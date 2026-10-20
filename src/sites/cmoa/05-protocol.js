    // The live speed reader is not the only thing that knows how to unshuffle a
    // CMOA page: the geometry is *data*, sitting in the bibGetCntntInfo response
    // as four XOR-scrambled tables, and the viewer's own algorithm over them is
    // a fixed permutation. Ported from the viewer (`core/js/speedbinb.js`, via
    // the manga-dl engine's transcription of it), this lets a frame descramble a
    // volume with no viewer, no reader and no `getImageDescrambleCoords` - which
    // is what a series worker needs, because its hidden frame is the one place a
    // store's viewer is least likely to come up fully.
    //
    // The pieces, in the order they are used:
    //   cmoaGenerateK(cid)              local `k` token (the server only shape-checks it)
    //   cmoaDecodeTables(cid, k, item)  recover stbl/ttbl/ctbl/ptbl from the response
    //   cmoaSelectScramble(src, tables) per-page table choice, by filename checksum
    //   cmoaScramblePlan(coord, piece, w, h)  source -> destination tile rectangles
    //
    // Two permuted layouts exist. Only the tiled one is implemented: no CMOA
    // trial or purchased volume observed has used the numeric one, and shipping a
    // transcription that has never been checked against real pages is worse than
    // saying so, so that one throws with the format named.

    const CMOA_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const CMOA_CHAR_VALUE = (function () {
        const table = new Int8Array(128).fill(-1);
        for (let i = 0; i < CMOA_B64.length; i++) table[CMOA_B64.charCodeAt(i)] = i;
        return table;
    })();

    function cmoaCharValue(ch) {
        const code = ch.charCodeAt(0);
        return code < 128 ? CMOA_CHAR_VALUE[code] : -1;
    }

    // The viewer's `getRandomString`.
    function cmoaRandomString(length) {
        let out = '';
        for (let i = 0; i < length; i++) out += CMOA_B64[(Math.random() * CMOA_B64.length) | 0];
        return out;
    }

    // The viewer's `Reader.J(cid)`: 16 random characters, then for each position
    // one more character from XOR-accumulating the nonce against the cid repeated,
    // truncated and reversed to 16 bytes.
    function cmoaGenerateK(cid) {
        const nonce = cmoaRandomString(16);
        const repeated = new Array(Math.ceil(16 / String(cid).length) + 1).join(String(cid));
        const head = repeated.substr(0, 16);
        const tail = repeated.substr(-16, 16);
        let xorNonce = 0, xorHead = 0, xorTail = 0;
        return nonce.split('').map(function (ch, i) {
            xorNonce ^= nonce.charCodeAt(i);
            xorHead ^= head.charCodeAt(i);
            xorTail ^= tail.charCodeAt(i);
            return ch + CMOA_B64[(xorNonce + xorHead + xorTail) & 63];
        }).join('');
    }

    // The viewer's `Reader.jt(cid, k, encoded)`: ASCII in [32, 126), recovered by
    // running a 32-bit LFSR seeded from `cid + ':' + k` and subtracting the low
    // byte of each state, modulo 94. The plaintext is JSON.
    function cmoaDecodeTable(cid, k, encoded) {
        if (typeof encoded !== 'string') throw new TypeError('cmoaDecodeTable: encoded table must be a string');
        const seed = cid + ':' + k;
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
            // `+=`, not `|=`: the viewer adds each shifted char code into a number
            // that is truncated to 31 bits afterwards.
            hash += seed.charCodeAt(i) << (i % 16);
        }
        hash &= 0x7fffffff;
        if (hash === 0) hash = 0x12345678;
        let state = hash;
        let out = '';
        for (let i = 0; i < encoded.length; i++) {
            state = ((state >>> 1) ^ (1210056708 & -(state & 1))) >>> 0;
            out += String.fromCharCode(((encoded.charCodeAt(i) - 32 + state) % 94) + 32);
        }
        return JSON.parse(out);
    }

    // All four tables. `stbl`/`ttbl` are decoded for completeness; only the two
    // selection tables are read.
    function cmoaDecodeTables(cid, k, item) {
        const out = {};
        for (const key of ['stbl', 'ttbl', 'ctbl', 'ptbl']) {
            const encoded = item ? item[key] : null;
            if (typeof encoded !== 'string' || !encoded) continue;
            try {
                out[key] = cmoaDecodeTable(cid, k, encoded);
            } catch (e) {
                cmoaLog('scramble table ' + key + ' did not decode', safeLogText(e && e.message));
            }
        }
        return out;
    }

    // The viewer's `Reader.mt(src)`: both eight-entry selection tables are indexed
    // by a checksum of the filename (sum of characters at even/odd offsets,
    // modulo 8), which is why the choice is per page rather than per volume.
    function cmoaSelectScramble(src, tables) {
        const sums = [0, 0];
        if (src && tables) {
            const start = String(src).lastIndexOf('/') + 1;
            for (let i = 0; i < String(src).length - start; i++) {
                sums[i % 2] += String(src).charCodeAt(start + i);
            }
            sums[0] %= 8;
            sums[1] %= 8;
        }
        if (!tables || !Array.isArray(tables.ptbl) || !Array.isArray(tables.ctbl)) return null;
        return {
            checksum: sums,
            pieceTable: tables.ptbl[sums[0]],
            coordTable: tables.ctbl[sums[1]],
        };
    }

    // The two strings are self-describing:
    //   '=R-C+X-body'  a tiled permutation of an R x C grid with X pixels of pad
    //   '12abc...'     a plain digit-encoded permutation
    //   ''             no scrambling
    function cmoaDescribeScramble(coordTable, pieceTable) {
        const coord = String(coordTable == null ? '' : coordTable);
        const piece = String(pieceTable == null ? '' : pieceTable);
        if (coord === '' && piece === '') return 'none';
        if (coord.charAt(0) === '=' && piece.charAt(0) === '=') return 'tiled';
        if (/^[0-9]/.test(coord) && /^[0-9]/.test(piece)) return 'numeric';
        return 'unknown';
    }

    function cmoaParseTiledPattern(pattern) {
        const m = /^=([0-9]+)-([0-9]+)([-+])([0-9]+)-([-_0-9A-Za-z]+)$/.exec(String(pattern));
        if (!m) return null;
        return {
            rows: parseInt(m[1], 10),
            cols: parseInt(m[2], 10),
            sign: m[3],
            padding: parseInt(m[4], 10),
            body: m[5],
        };
    }

    function cmoaTiledSection(T, j, body) {
        const values = [];
        for (let i = 0; i < T + j + T * j; i++) {
            const value = cmoaCharValue(body.charAt(i));
            values.push(value < 0 ? 0 : value);
        }
        return {
            colShift: values.slice(0, T),
            rowShift: values.slice(T, T + j),
            perm: values.slice(T + j),
        };
    }

    // Port of the viewer's `f` class (minified `T`, `j`, `Dt`, `kt`, `Lt`, `Nt`,
    // `Rt`, `Ft`).
    //
    // The viewer names the two coordinate runs against the order they appear in
    // the body: `Ct` returns `{t: <first T>, n: <next j>, p: <perm>}` and the
    // constructor then does `this.Rt = s.n, this.Ft = s.t, this.Lt = h.n,
    // this.Nt = h.t`. So `Rt`/`Lt` are the *second* run and `Ft`/`Nt` the first.
    // A tile's span must also come from the same run that placed it — the
    // *stored* grid (`Lt`/`Nt`) — otherwise the source rectangle is a pixel or
    // two out and every remainder tile lands a few pixels off.
    function cmoaTiledDescrambler(coordTable, pieceTable) {
        const coord = cmoaParseTiledPattern(coordTable);
        const piece = cmoaParseTiledPattern(pieceTable);
        if (!coord || !piece) throw new Error('invalid tiled scramble pattern');
        if (coord.rows !== piece.rows || coord.cols !== piece.cols ||
            coord.padding !== piece.padding || coord.sign !== '+' || piece.sign !== '-') {
            throw new Error('tiled scramble patterns disagree');
        }
        const T = coord.rows;   // tiles across
        const j = coord.cols;   // tiles down
        const Dt = coord.padding;
        if (T > 8 || j > 8 || T * j > 64) throw new Error('tiled scramble pattern too large');
        const expected = T + j + T * j;
        if (coord.body.length !== expected || piece.body.length !== expected) {
            throw new Error('tiled scramble body has the wrong length');
        }
        const s = cmoaTiledSection(T, j, coord.body);
        const h = cmoaTiledSection(T, j, piece.body);
        // `Rt`/`Lt` take the body's second run, `Ft`/`Nt` the first.
        const Rt = s.rowShift, Ft = s.colShift, Lt = h.rowShift, Nt = h.colShift;
        const kt = [];
        for (let i = 0; i < T * j; i++) kt.push(s.perm[h.perm[i]]);

        // The viewer's `It`: images smaller than the padded grid are not permuted.
        const applies = (width, height) => {
            const t = 2 * T * Dt;
            const jj = 2 * j * Dt;
            return width >= 64 + t && height >= 64 + jj && width * height >= (320 + t) * (320 + jj);
        };
        return {
            kind: 'tiled',
            applies: applies,
            displaySize: function (width, height) {
                if (!applies(width, height)) return { width: width, height: height };
                return { width: width - 2 * T * Dt, height: height - 2 * j * Dt };
            },
            // The viewer's `Ot`. width/height are the *stored* image's.
            regions: function (width, height) {
                const identity = [{ xsrc: 0, ysrc: 0, width: width, height: height, xdest: 0, ydest: 0 }];
                if (!applies(width, height)) return identity;
                const i = width - 2 * T * Dt;
                const n = height - 2 * j * Dt;
                const r = Math.floor((i + T - 1) / T);
                const e = i - (T - 1) * r;
                const sz = Math.floor((n + j - 1) / j);
                const hh = n - (j - 1) * sz;
                const out = [];
                for (let o = 0; o < T * j; o++) {
                    const a = o % T;
                    const f = Math.floor(o / T);
                    const c = Dt + a * (r + 2 * Dt) + (Lt[f] < a ? e - r : 0);
                    const l = Dt + f * (sz + 2 * Dt) + (Nt[a] < f ? hh - sz : 0);
                    const v = kt[o] % T;
                    const d = Math.floor(kt[o] / T);
                    const ws = v * r + (Rt[d] < v ? e - r : 0);
                    const hs = d * sz + (Ft[v] < d ? hh - sz : 0);
                    const w = Lt[f] === a ? e : r;
                    const m = Nt[a] === f ? hh : sz;
                    if (i > 0 && n > 0) {
                        out.push({ xsrc: c, ysrc: l, width: w, height: m, xdest: ws, ydest: hs });
                    }
                }
                return out;
            },
        };
    }

    // The viewer's `Reader.mt` dispatch. Never returns null: a volume with no
    // scramble tables descrambles to itself, which is the honest answer for a page
    // served whole.
    function cmoaCompileDescrambler(coordTable, pieceTable, where) {
        const kind = cmoaDescribeScramble(coordTable, pieceTable);
        if (kind === 'tiled') return cmoaTiledDescrambler(coordTable, pieceTable);
        if (kind === 'numeric') {
            throw new Error('this volume uses the numeric scramble layout, which is not implemented' +
                (where ? ' (' + where + ')' : '') + '; only the tiled layout has been verified');
        }
        if (kind === 'unknown') {
            throw new Error('unrecognised CMOA scramble tables' + (where ? ' (' + where + ')' : '') +
                ': coord=' + JSON.stringify(String(coordTable).slice(0, 24)) +
                ' piece=' + JSON.stringify(String(pieceTable).slice(0, 24)));
        }
        return {
            kind: 'none',
            applies: function () { return false; },
            displaySize: function (width, height) { return { width: width, height: height }; },
            regions: function (width, height) {
                return [{ xsrc: 0, ysrc: 0, width: width, height: height, xdest: 0, ydest: 0 }];
            },
        };
    }

    // The offline equivalent of the reader's `getImageDescrambleCoords`, returning
    // the same plan shape the live-viewer path produces, so the blit and worker
    // paths cannot tell the two apart.
    function cmoaScramblePlan(coordTable, pieceTable, width, height) {
        const engine = cmoaCompileDescrambler(coordTable, pieceTable, 'page ' + width + 'x' + height);
        const size = engine.displaySize(width, height);
        return {
            kind: engine.kind,
            width: size.width,
            height: size.height,
            transfers: [{ index: 0, coords: engine.regions(width, height) }],
        };
    }

    // The `ttx` document `sbcGetCntnt.php` returns describes the whole book twice,
    // split by media query; the speed reader runs landscape, so the `t-case`
    // portrait blocks are deleted before scanning. Getting this wrong silently
    // doubles the page count.
    function cmoaTtxAttributes(text) {
        const out = {};
        const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
        let m;
        while ((m = re.exec(text)) !== null) out[m[1].toLowerCase()] = m[2];
        return out;
    }

    function cmoaTtxPages(ttx) {
        const pages = [];
        const re = /<(t-pb|t-img|img|a)(\s+([^>]*)|)>/gi;
        let match;
        while ((match = re.exec(ttx)) !== null) {
            const tag = match[1].toLowerCase();
            if (tag !== 't-img' && tag !== 'img') continue;
            const attrs = cmoaTtxAttributes(match[2] || '');
            const src = String(attrs.src || '').trim();
            const width = parseInt(attrs.orgwidth, 10) || 0;
            const height = parseInt(attrs.orgheight, 10) || 0;
            if (!src || !width || !height) continue;
            pages.push({
                src: src,
                id: attrs.id || '',
                width: width,
                height: height,
                spread: attrs.a != null ? attrs.a : '',
            });
        }
        return pages;
    }

    function cmoaParsePageList(ttx) {
        if (typeof ttx !== 'string' || !ttx) return [];
        const landscape = ttx.replace(/<t-case\s+[^>]*screen\.portrait[^>]*>([\s\S]*?)<\/t-case>/gi, '');
        return cmoaTtxPages(landscape);
    }
