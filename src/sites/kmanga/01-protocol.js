    // Ported from dokuha-cli src/download/kmanga-protocol.js. Every Buffer call
    // there is a Uint8Array/DataView/TextDecoder call here; the arithmetic is
    // deliberately unchanged, including the field widths and the LCG constants,
    // because those are what the recorded fixtures pin.
    //
    // A BCP000 message is:
    //   "BCP000" + 10 ASCII digits of JSON length + JSON
    //   and, for a content reply only, 3 digits of chunk count followed by one
    //   10-digit length per chunk and the raw chunk bytes. The chunks are raw
    //   JPEG, not base64: the viewer base64-encodes them itself only to build a
    //   data: URL, and treating the wire bytes as base64 yields a 170-byte image.
    const KM_MAGIC = 'BCP000';
    const KM_API_URL = 'https://bv.k-manga.jp/public/app/action/bd00.php';
    const KM_WS_URL = 'wss://ws.viewer.k-manga.jp/';
    const KM_PROFILES = ['64kb_QVGA_h', 'apple_h'];

    function kmangaBuildHeaderRequest(opts) {
        if (!opts || !opts.ticket || !opts.obfuid) throw new Error('k-manga header request needs a ticket and an obfuid');
        return 'REQUEST HEADER\nt=' + opts.ticket + '&fn=' + (opts.profile || KM_PROFILES[0]) + '&o=' + opts.obfuid;
    }

    function kmangaBuildDataRequest(opts) {
        if (!opts || !opts.ticket || !opts.obfuid) throw new Error('k-manga data request needs a ticket and an obfuid');
        const dk = opts.decryptKey ? '&dk=' + opts.decryptKey : '';
        return 'REQUEST DATA\nt=' + opts.ticket + '&fn=' + opts.name + '&o=' + opts.obfuid + dk;
    }

    function kmangaLatin1(bytes, start, end) {
        let out = '';
        for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
        return out;
    }

    function kmangaReadField(bytes, offset, width, what) {
        const raw = kmangaLatin1(bytes, offset, offset + width);
        const text = raw.trim();
        if (!/^\d+$/.test(text)) {
            throw new Error('k-manga frame has a non-numeric ' + what + ': ' + JSON.stringify(raw));
        }
        return Number(text);
    }

    function kmangaParseFrame(input) {
        const buf = input instanceof Uint8Array ? input : new Uint8Array(input || []);
        if (buf.length < 6 || kmangaLatin1(buf, 0, 6) !== KM_MAGIC) {
            throw new Error('k-manga frame does not start with ' + KM_MAGIC);
        }
        // The greeting is the magic on its own. Reading it as "a frame with no
        // JSON" would leave the client waiting for a length field that never comes.
        if (buf.length === 6) return { hello: true };

        if (buf.length < 16) throw new Error('k-manga frame is ' + buf.length + ' bytes, too short for a length field');
        const jsonLength = kmangaReadField(buf, 6, 10, 'JSON length');
        const jsonEnd = 16 + jsonLength;
        if (jsonEnd > buf.length) {
            throw new Error('k-manga frame claims ' + jsonLength + ' bytes of JSON but only ' + (buf.length - 16) + ' remain');
        }
        let body;
        try {
            body = JSON.parse(new TextDecoder().decode(buf.subarray(16, jsonEnd)));
        } catch (error) {
            throw new Error('k-manga frame has unparseable JSON: ' + ((error && error.message) || error));
        }
        // The header reply stops after its JSON; only a content reply appends the
        // chunk table. `chunks === null` is therefore how a caller tells them apart.
        if (jsonEnd === buf.length) return { hello: false, body: body, chunks: null };

        const count = kmangaReadField(buf, jsonEnd, 3, 'chunk count');
        const chunks = [];
        let cursor = jsonEnd + 3;
        for (let i = 0; i < count; i++) {
            if (cursor + 10 > buf.length) throw new Error('k-manga frame ended inside chunk ' + i + ' of ' + count);
            const size = kmangaReadField(buf, cursor, 10, 'chunk ' + i + ' length');
            cursor += 10;
            if (cursor + size > buf.length) {
                throw new Error('k-manga frame ended inside chunk ' + i + ' of ' + count + ': wanted ' + size
                    + ' bytes, ' + (buf.length - cursor) + ' left');
            }
            chunks.push(buf.subarray(cursor, cursor + size));
            cursor += size;
        }
        if (cursor !== buf.length) {
            throw new Error('k-manga frame has ' + (buf.length - cursor) + ' trailing byte(s) after ' + count + ' chunk(s)');
        }
        return { hello: false, body: body, chunks: chunks };
    }

    // The table of contents: a header row, chapters, then flag rows whose second
    // cell is empty. Treating the flags as chapters would invent pages.
    function kmangaParseIndexJsonp(text) {
        const source = String(text);
        const start = source.indexOf('(');
        const end = source.lastIndexOf(')');
        if (start < 0 || end < start) throw new Error('k-manga index reply is not a JSONP call');
        let rows;
        try {
            rows = JSON.parse(source.slice(start + 1, end));
        } catch (error) {
            throw new Error('k-manga index reply has unparseable JSON: ' + ((error && error.message) || error));
        }
        if (!Array.isArray(rows)) throw new Error('k-manga index reply is not an array');

        const chapters = [];
        const flags = [];
        for (const row of rows) {
            if (!Array.isArray(row)) continue;
            if (row.length === 2 && row[0] && row[1]) {
                const page = Number(row[1]);
                if (Number.isInteger(page) && page > 0) chapters.push({ name: String(row[0]).trim(), page: page });
            } else if (row.length === 2 && row[0] && !row[1]) {
                flags.push(String(row[0]).trim());
            }
        }
        return { chapters: chapters, flags: flags };
    }

    // Both p5 and p9 are JSON, base64-encoded, in the viewer URL. The CLI used
    // Buffer.from(raw, 'base64'); atob + TextDecoder is the browser spelling of
    // the same thing, and it is tolerant of the URL-safe alphabet.
    function kmangaBase64ToText(raw) {
        let text = String(raw).replace(/-/g, '+').replace(/_/g, '/');
        while (text.length % 4) text += '=';
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }

    // The viewer URL owns the session: without the ticket and obfuid the socket
    // has nothing to authenticate with.
    function kmangaParseViewerUrl(viewerUrl) {
        let url;
        try { url = new URL(viewerUrl, KM_ORIGIN); } catch (e) { url = new URL(KM_ORIGIN); }
        const p = url.searchParams;
        const decode = function (key) {
            const raw = p.get(key);
            if (!raw) return null;
            try { return JSON.parse(kmangaBase64ToText(raw)); } catch (e) { return null; }
        };
        return {
            url: url.toString(),
            ticket: p.get('p0') || null,
            obfuid: p.get('p1') || null,
            bookId: p.get('p3') || null,
            sid: p.get('p8') || null,
            accessUuid: p.get('p20') || null,
            config: decode('p5'),
            nextConfig: decode('p9'),
            params: p,
        };
    }

    function kmangaIsScrambled(image) {
        return Number(image && image.key) > 0;
    }

    // The cell constant is chosen from the *declared* size while the grid is
    // measured against the JPEG: the wire image is padded up to a whole number
    // of cells, each of which gives up its inner cell-2 square.
    function kmangaScrambleGeometry(box) {
        let cell = 32;
        if (box.declaredWidth > 1000 || box.declaredHeight > 1000) cell *= 3;
        else if (box.declaredWidth > 300 || box.declaredHeight > 300) cell *= 2;

        if (box.sourceWidth % cell || box.sourceHeight % cell) {
            throw new Error('k-manga scrambled page is ' + box.sourceWidth + 'x' + box.sourceHeight
                + ', which is not a whole number of ' + cell + 'px cells');
        }
        return {
            cell: cell,
            block: cell - 2,
            gridX: box.sourceWidth / cell,
            gridY: box.sourceHeight / cell,
        };
    }

    // The permutation: a bijection drawn from the LCG the viewer uses. A wrong
    // constant still yields a bijection, so the fixtures pin a prefix of the draw.
    function kmangaScrambleOrder(grid) {
        const total = grid.gridX * grid.gridY;
        const remaining = new Array(total);
        for (let i = 0; i < total; i++) remaining[i] = i;

        const order = new Uint32Array(total);
        let value = Number(grid.key) || 0;
        for (let t = 0; t < total; t++) {
            value = (8741 * value + 30873) % 131071;
            const pick = value % remaining.length;
            order[t] = remaining[pick];
            remaining.splice(pick, 1);
        }
        return order;
    }

    // The frame header carries the page size, and the scramble answer depends
    // only on that size, never on the pixels. Reading it here is what lets a page
    // the store already serves assembled skip a full JPEG decode.
    function kmangaReadJpegSize(input) {
        const data = input instanceof Uint8Array ? input : new Uint8Array(input || []);
        if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
        let i = 2;
        while (i + 9 < data.length) {
            if (data[i] !== 0xff) { i++; continue; }
            const marker = data[i + 1];
            if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
            const size = (data[i + 2] << 8) | data[i + 3];
            const isFrame = marker >= 0xc0 && marker <= 0xcf &&
                marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isFrame) {
                const height = (data[i + 5] << 8) | data[i + 6];
                const width = (data[i + 7] << 8) | data[i + 8];
                return (width > 0 && height > 0) ? { width: width, height: height } : null;
            }
            if (size < 2) return null;
            i += 2 + size;
        }
        return null;
    }

    // A **free** volume is rendered as a real link, while a **sample** or
    // campaign volume is rendered as a button with no href at all -- title.js
    // fills the href in on DOMContentLoaded from the page's own settings plus the
    // button's data-chapter-* attributes. A parser that only follows hrefs
    // therefore reports two volumes for a title that offers ten.
    function kmangaTextOf(html) {
        return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function kmangaReadAttributes(tag) {
        const attrs = {};
        const attribute = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        let match;
        while ((match = attribute.exec(String(tag))) !== null) {
            attrs[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3];
        }
        return attrs;
    }

    function kmangaReadLauncherTemplate(html) {
        const script = /<script\b[^>]*\bid=["']titlejs["'][^>]*>/i.exec(html);
        const attrs = script ? kmangaReadAttributes(script[0]) : {};
        const viewerId = attrs['data-viewer-id-pc'];
        const book = attrs['data-book'];
        const formatType = attrs['data-format-type'];
        const quality = attrs['data-quality-default'];
        if (viewerId && book && formatType && quality) {
            return { viewerId: viewerId, book: book, formatType: formatType, quality: quality };
        }
        const rendered = /\/viewer-launcher\/(\d+)\/(\d+)\/(\d+)\/([^/"'\s]+)/.exec(html);
        if (rendered) {
            return { viewerId: rendered[1], quality: rendered[2], book: rendered[3], formatType: rendered[4] };
        }
        return null;
    }

    function kmangaBuildLauncherUrl(template, opts) {
        if (!template) return null;
        const attrs = (opts && opts.attrs) || {};
        const volume = opts ? opts.volume : null;
        const fcipath = attrs['data-chapter-fcipath'] != null ? attrs['data-chapter-fcipath'] : '1';
        const readType = attrs['data-chapter-readtype'] != null ? attrs['data-chapter-readtype'] : '0';
        const fcid = attrs['data-chapter-fcid'] != null ? attrs['data-chapter-fcid'] : '0';
        const fcupdated = attrs['data-chapter-fcupdated'] != null ? attrs['data-chapter-fcupdated'] : '0';
        return KM_ORIGIN + '/viewer-launcher/' + template.viewerId + '/' + template.quality + '/' + template.book
            + '/' + template.formatType + '/' + volume + '/' + fcipath + '/' + readType + '/' + fcid + '/' + fcupdated;
    }

    function kmangaParseLauncherUrl(href) {
        let url;
        try { url = new URL(href, KM_ORIGIN); } catch (e) { return null; }
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] !== 'viewer-launcher' || parts.length < 9) return null;
        return {
            url: url.toString(),
            bookId: parts[3],
            mode: parts[4],
            volume: Number(parts[5]),
            readType: Number(parts[7]),
            fcid: parts[8],
        };
    }

    function kmangaRank(entry) {
        if (entry.sample) return 2;
        return entry.readType === 4 ? 0 : 1;
    }

    function kmangaDecodeEntities(value) {
        return String(value)
            .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    }

    function kmangaParseTitlePage(html) {
        const text = String(html);
        const template = kmangaReadLauncherTemplate(text);
        const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

        const best = new Map();
        // for...of, not `while ((m = text.matchAll(re)) !== null)`: matchAll
        // returns an iterator, which is never null, so the while form is an
        // infinite loop (and it hung the page before it was caught).
        for (const match of text.matchAll(anchor)) {
            const attrs = kmangaReadAttributes(match[1]);
            const href = attrs.href || '';
            const classes = attrs.class || '';
            const rendered = href.indexOf('/viewer-launcher/') !== -1 ? kmangaParseLauncherUrl(href) : null;

            if (!rendered && !/x-invoke-viewer--btn__selector|book-chapter--btn/.test(classes)) continue;

            const volume = Number(attrs['data-chapter-exid'] != null ? attrs['data-chapter-exid'] : (rendered && rendered.volume));
            if (!Number.isInteger(volume) || volume < 1) continue;

            const launcher = rendered ? rendered.url : kmangaBuildLauncherUrl(template, { volume: volume, attrs: attrs });
            if (!launcher) continue;

            const label = kmangaTextOf(match[2]);
            const readType = Number(attrs['data-chapter-readtype'] != null ? attrs['data-chapter-readtype'] : (rendered && rendered.readType));

            const entry = {
                volume: volume,
                launcher: launcher,
                readType: readType,
                // Read type 4 is a whole free read; 0 is the store's sample
                // button. Anything else that says 試し読み is a sample too.
                sample: readType === 0 || (readType !== 1 && readType !== 4 && /試し読み/.test(label)),
            };
            const previous = best.get(volume);
            if (!previous || kmangaRank(entry) < kmangaRank(previous)) best.set(volume, entry);
        }

        const ld = /"@type"\s*:\s*"ProductGroup"[\s\S]{0,300}?"name"\s*:\s*"([^"]+)"/.exec(text);
        const og = /<meta property="og:title" content="([^"]+)"/.exec(text);
        const name = (ld && ld[1]) || (og && og[1]) || null;

        return {
            name: name ? kmangaDecodeEntities(name) : null,
            volumes: Array.from(best.values()).sort(function (a, b) { return a.volume - b.volume; }),
        };
    }
