    // ---- auth and signed CDN URLs ------------------------------------------

    function dmmCookieParams() {
        // A CloudFront signed URL uses `Policy`, `Signature` and `Key-Pair-Id`;
        // the matching cookies carry a `CloudFront-` prefix. Sending the cookie
        // names in the query is a 403 even though the values are valid.
        const wanted = {
            'cloudfront-policy': 'Policy',
            'cloudfront-signature': 'Signature',
            'cloudfront-key-pair-id': 'Key-Pair-Id',
        };
        const out = {};
        let text = '';
        try { text = document.cookie || ''; } catch (e) { text = ''; }
        for (const part of text.split(';')) {
            const at = part.indexOf('=');
            if (at <= 0) continue;
            const name = part.slice(0, at).trim();
            let value = part.slice(at + 1).trim();
            if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
                value = value.slice(1, -1);
            }
            // CloudFront sends the signature percent-encoded (`%7E` for `~`).
            // The cookie is sent to the CDN verbatim, but a signed *URL* has to
            // carry the decoded value: URLSearchParams would otherwise encode
            // the `%` to `%25` and CloudFront would see the wrong signature.
            try { value = decodeURIComponent(value); } catch (e) {}
            const canonical = wanted[name.toLowerCase()];
            if (canonical) out[canonical] = value;
        }
        return Object.keys(out).length === 3 ? out : null;
    }

    function dmmBaseUrl(raw) {
        const base = String(raw || '');
        if (!base) throw new Error('DMM auth answer carried no content URL');
        return base.endsWith('/') ? base : base + '/';
    }

    function dmmSignedUrl(url, session) {
        const params = session && (session.authInfo || session.cookies);
        if (!params) return url;
        const out = new URL(url);
        for (const key of Object.keys(params)) {
            const value = params[key];
            if (value != null) out.searchParams.set(key, String(value));
        }
        return out.toString();
    }

    async function dmmReadResponseText(res) {
        if (!res) return '';
        if (typeof res.text === 'function') return await res.text();
        if (typeof res.blob === 'function') return await (await res.blob()).text();
        throw new Error('DMM response had no readable body');
    }

    async function dmmReadResponseBytes(res) {
        if (!res) throw new Error('DMM response was empty');
        if (typeof res.arrayBuffer === 'function') return new Uint8Array(await res.arrayBuffer());
        if (typeof res.blob === 'function') return new Uint8Array(await (await res.blob()).arrayBuffer());
        throw new Error('DMM response had no readable bytes');
    }

    async function dmmAuth(viewer) {
        if (!viewer || !viewer.cid) throw new Error('DMM viewer URL is missing its cid');
        const query = new URLSearchParams({ cid: viewer.cid, lin: viewer.lin });
        const url = DMM_ORIGIN + '/viewerapi/auth/?' + query.toString();
        const response = await fetchWithTimeout(url, {
            credentials: 'include',
            headers: {
                Accept: '*/*',
                'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8',
            },
        }, DMM_FETCH_TIMEOUT_MS);
        if (!response || !response.ok) {
            const err = new Error('DMM viewer authorization answered HTTP ' + (response ? response.status : '0'));
            err.status = response ? response.status : 0;
            throw err;
        }
        let body;
        try { body = await response.json(); }
        catch (e) { throw new Error('DMM viewer authorization did not return JSON'); }
        if (String(body && body.status) !== '200' || !body.url) {
            throw new Error('DMM viewer authorization refused this volume: '
                + ((body && body.status) || 'no status'));
        }
        const authInfo = body.auth_info && typeof body.auth_info === 'object' ? body.auth_info : null;
        // CloudFront query values can arrive percent-encoded, exactly like the
        // Set-Cookie signature. URLSearchParams encodes them again, so decode
        // once here or the CDN receives a signature that is nearly right.
        if (authInfo) {
            for (const key of Object.keys(authInfo)) {
                if (typeof authInfo[key] !== 'string') continue;
                try { authInfo[key] = decodeURIComponent(authInfo[key]); } catch (e) {}
            }
        }
        // Free volumes answer with CloudFront cookies and no auth_info. The
        // cookies are not HttpOnly and belong to .dmm.com, so document.cookie
        // is the only place a script can read them; laneFetch sends no cookies,
        // so they are appended to each CDN URL as query parameters instead.
        const cookies = authInfo ? null : dmmCookieParams();
        if (!authInfo && !cookies) {
            throw new Error('DMM authorization returned neither auth_info nor CloudFront cookies. '
                + 'Reload the viewer and try again.');
        }
        return {
            auth: body,
            base: dmmBaseUrl(body.url),
            authInfo: authInfo,
            cookies: cookies,
            cti: typeof body.cti === 'string' ? body.cti : '',
            at: Date.now(),
        };
    }

    function dmmParseConfiguration(config) {
        const contents = Array.isArray(config && config.configuration && config.configuration.contents)
            ? config.configuration.contents
            : [];
        const pages = [];
        for (const entry of contents) {
            if (!entry || typeof entry.file !== 'string') continue;
            const item = config[entry.file];
            if (!item || item.Linear === 0) continue;
            const type = entry.type === 'bmp' ? 'jpeg' : String(entry.type || 'jpeg').toLowerCase();
            if (type !== 'jpeg' && type !== 'jpg') continue;
            const links = item.FileLinkInfo && item.FileLinkInfo.PageLinkInfoList;
            const list = Array.isArray(links) ? links : [{ Page: { No: 0 } }];
            for (const link of list) {
                const page = (link && link.Page) || {};
                const no = Number.isInteger(page.No) ? page.No : 0;
                const dummyWidth = Number.isFinite(page.DummyWidth) ? page.DummyWidth : null;
                const dummyHeight = Number.isFinite(page.DummyHeight) ? page.DummyHeight : null;
                pages.push({
                    file: entry.file,
                    no: no,
                    type: type === 'jpg' ? 'jpeg' : type,
                    width: Number(page.Size && page.Size.Width) || 0,
                    height: Number(page.Size && page.Size.Height) || 0,
                    dummyWidth: dummyWidth,
                    dummyHeight: dummyHeight,
                    // Both fields being numbers is the viewer's own condition
                    // for installing the shuffle. Zero still means "shuffle".
                    scrambled: typeof dummyWidth === 'number' && typeof dummyHeight === 'number',
                    pattern: dmmPattern(entry.file, no),
                });
            }
        }
        return pages;
    }

    async function dmmFetchManifest(session) {
        const url = dmmSignedUrl(session.base + 'configuration_pack.json', session);
        const res = await laneFetch(url, DMM_FETCH_TIMEOUT_MS, {
            allowProxy: proxyCanServe(hostOf(url)),
        });
        if (!res || !res.ok) {
            const err = new Error('DMM manifest answered HTTP ' + (res ? res.status : '0'));
            err.status = res ? res.status : 0;
            throw err;
        }
        let body;
        try { body = JSON.parse(await dmmReadResponseText(res)); }
        catch (e) { throw new Error('DMM configuration_pack.json is not JSON'); }
        const pages = dmmParseConfiguration(body);
        if (!pages.length) throw new Error('DMM configuration_pack.json listed no JPEG pages');
        return pages;
    }

    async function dmmProbe() {
        const viewer = dmmState.viewer;
        if (!viewer) return null;
        const url = viewer.url;
        const session = await dmmAuth(viewer);
        const pages = await dmmFetchManifest(session);
        // The panel can watch a new viewer URL while the auth and manifest round
        // trips are still in flight. Publishing this answer would label the new
        // volume with the old one's page count, and a run starting within ten
        // seconds would then reuse the old page list with the new session. Leave
        // the state alone so the next refresh probes the volume actually open.
        if (!dmmState.viewer || dmmState.viewer.url !== url) return null;
        dmmState.probe = { session: session, pages: pages, at: Date.now() };
        dmmState.total = pages.length;
        const first = pages.find(function (page) { return page.width && page.height; });
        dmmState.resolution = first ? (first.width + ' × ' + first.height) : '';
        dmmLog('probe', pages.length + ' page(s)', dmmState.resolution);
        return dmmState.probe;
    }

    function dmmProbeFresh() {
        const probe = dmmState.probe;
        return probe && Date.now() - probe.at < 10000 ? probe : null;
    }

    // ---- the 64×64 tile shuffle --------------------------------------------

    function dmmPattern(file, no) {
        const key = String(file) + '/' + String(no);
        let sum = 0;
        for (let i = 0; i < key.length; i++) sum += key.charCodeAt(i);
        return sum % 4 + 1;
    }

    function dmmVn(index, split, remainder, tile) {
        return index * tile + (index >= split ? remainder : 0);
    }

    function dmmFu(index, count, pattern) {
        return (index + 61 * pattern) % count;
    }

    function dmmQi(index, split, splitY, countY, pattern) {
        const odd = pattern % 2 === 1;
        const before = index < split ? odd : !odd;
        let start;
        let span;
        if (before) { span = splitY; start = 0; }
        else { span = countY - splitY; start = splitY; }
        return (index + 53 * pattern + 59 * splitY) % span + start;
    }

    function dmmEs(index, splitX, splitY, countX, pattern) {
        const odd = pattern % 2 === 1;
        const before = index < splitY ? odd : !odd;
        let start;
        let span;
        if (before) { span = countX - splitX; start = splitX; }
        else { span = splitX; start = 0; }
        return (index + 67 * pattern + splitX + 71) % span + start;
    }

    function dmmXu(index, count, pattern) {
        return (index + 73 * pattern) % count;
    }

    // The viewer's Wu(): `sx`/`sy` are the source in the scrambled JPEG and
    // `dx`/`dy` the destination in the clean page. The viewer's own names are
    // inverted (drawImage(c, destX, destY, ..., srcX, srcY, ...)), so they are
    // renamed here to keep the copy loop readable.
    function dmmTileRects(width, height, pattern, block) {
        const tile = block || DMM_TILE;
        const cols = Math.floor(width / tile);
        const rows = Math.floor(height / tile);
        if (cols <= 0 || rows <= 0) return [];
        const remX = width % tile;
        const remY = height % tile;
        const rects = [];

        let splitX = cols - (43 * pattern) % cols;
        splitX = splitX % cols === 0 ? (cols - 4) % cols : splitX;
        splitX = splitX === 0 ? cols - 1 : splitX;
        let splitY = rows - (47 * pattern) % rows;
        splitY = splitY % rows === 0 ? (rows - 4) % rows : splitY;
        splitY = splitY === 0 ? rows - 1 : splitY;

        const push = function (sx, sy, dx, dy, w, h) {
            if (w > 0 && h > 0) rects.push({ sx: sx, sy: sy, dx: dx, dy: dy, w: w, h: h });
        };

        if (remX > 0 && remY > 0) {
            push(splitX * tile, splitY * tile, splitX * tile, splitY * tile, remX, remY);
        }
        if (remY > 0) {
            for (let x = 0; x < cols; x++) {
                const targetX = dmmFu(x, cols, pattern);
                const targetY = dmmQi(targetX, splitX, splitY, rows, pattern);
                push(
                    dmmVn(targetX, splitX, remX, tile), targetY * tile,
                    dmmVn(x, splitX, remX, tile), splitY * tile,
                    tile, remY,
                );
            }
        }
        if (remX > 0) {
            for (let y = 0; y < rows; y++) {
                const targetY = dmmXu(y, rows, pattern);
                const targetX = dmmEs(targetY, splitX, splitY, cols, pattern);
                push(
                    targetX * tile, dmmVn(targetY, splitY, remY, tile),
                    splitX * tile, dmmVn(y, splitY, remY, tile),
                    remX, tile,
                );
            }
        }
        for (let x = 0; x < cols; x++) {
            for (let y = 0; y < rows; y++) {
                const targetX = (x + 29 * pattern + 31 * y) % cols;
                const targetY = (y + 37 * pattern + 41 * targetX) % rows;
                const shiftX = targetX >= dmmEs(targetY, splitX, splitY, cols, pattern) ? remX : 0;
                const shiftY = targetY >= dmmQi(targetX, splitX, splitY, rows, pattern) ? remY : 0;
                push(
                    targetX * tile + shiftX, targetY * tile + shiftY,
                    x * tile + (x >= splitX ? remX : 0),
                    y * tile + (y >= splitY ? remY : 0),
                    tile, tile,
                );
            }
        }
        return rects;
    }

    // ---- page decode / descramble ------------------------------------------

    function dmmIsJpeg(bytes) {
        return bytes && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }

    async function dmmDecodeImage(bytes, mime) {
        const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const blob = new Blob([buffer], { type: mime || 'image/jpeg' });
        if (typeof createImageBitmap === 'function') {
            try {
                const bitmap = await createImageBitmap(blob);
                return {
                    element: bitmap,
                    width: bitmap.width,
                    height: bitmap.height,
                    cleanup: function () { try { if (bitmap.close) bitmap.close(); } catch (e) {} },
                };
            } catch (e) { /* fall back to an <img> */ }
        }
        return new Promise(function (resolve, reject) {
            const objectUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.decoding = 'async';
            img.onload = function () {
                resolve({
                    element: img,
                    width: img.naturalWidth || img.width,
                    height: img.naturalHeight || img.height,
                    cleanup: function () {
                        try { URL.revokeObjectURL(objectUrl); img.src = ''; } catch (e) {}
                    },
                });
            };
            img.onerror = function (e) {
                try { URL.revokeObjectURL(objectUrl); } catch (_) {}
                reject(e || new Error('DMM page decode failed'));
            };
            img.src = objectUrl;
        });
    }

    async function dmmCanvasToBlob(canvas, mime, quality) {
        const q = typeof quality === 'number' ? quality : undefined;
        if (typeof canvas.toBlob === 'function') {
            const direct = await new Promise(function (resolve) { canvas.toBlob(resolve, mime, q); });
            if (direct) return direct;
            if (mime && mime !== 'image/png') {
                const fallback = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
                if (fallback) return fallback;
            }
        }
        const dataUrl = canvas.toDataURL(mime || 'image/png');
        const comma = dataUrl.indexOf(',');
        const binary = atob(comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return new Blob([out], { type: mime || 'image/png' });
    }

    async function dmmDescrambleJpeg(bytes, page) {
        const decoded = await dmmDecodeImage(bytes, 'image/jpeg');
        try {
            const cleanWidth = Math.max(1, decoded.width - (Number(page.dummyWidth) || 0));
            const cleanHeight = Math.max(1, decoded.height - (Number(page.dummyHeight) || 0));
            const canvas = document.createElement('canvas');
            canvas.width = cleanWidth;
            canvas.height = cleanHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('DMM descramble needs a 2D canvas context');
            const rects = dmmTileRects(decoded.width, decoded.height, page.pattern);
            for (const rect of rects) {
                const w = Math.min(rect.w, cleanWidth - rect.dx, decoded.width - rect.sx);
                const h = Math.min(rect.h, cleanHeight - rect.dy, decoded.height - rect.sy);
                if (w <= 0 || h <= 0) continue;
                // Source is the scrambled tile, destination is the clean page.
                ctx.drawImage(decoded.element, rect.sx, rect.sy, w, h, rect.dx, rect.dy, w, h);
            }
            const blob = await dmmCanvasToBlob(canvas, IMAGE_CODEC.type, IMAGE_CODEC.quality);
            if (!blob) throw new Error('DMM descramble produced no image');
            return { blob: blob, ext: imageExtForMime(blob.type) || IMAGE_CODEC.ext };
        } finally {
            try { decoded.cleanup(); } catch (e) {}
        }
    }

    async function dmmReencode(bytes) {
        const decoded = await dmmDecodeImage(bytes, 'image/jpeg');
        try {
            const canvas = document.createElement('canvas');
            canvas.width = decoded.width;
            canvas.height = decoded.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('DMM re-encode needs a 2D canvas context');
            ctx.drawImage(decoded.element, 0, 0);
            const blob = await dmmCanvasToBlob(canvas, IMAGE_CODEC.type, IMAGE_CODEC.quality);
            if (!blob) throw new Error('DMM re-encode produced no image');
            return { blob: blob, ext: imageExtForMime(blob.type) || IMAGE_CODEC.ext };
        } finally {
            try { decoded.cleanup(); } catch (e) {}
        }
    }

    async function dmmPageBlob(bytes, page) {
        if (!dmmIsJpeg(bytes)) throw new Error('DMM page ' + page.file + '/' + page.no + ' is not a readable JPEG');
        if (!page.scrambled) {
            // A page with no DummyWidth/DummyHeight is already whole. Keep the
            // bytes when JPEG is the selected codec; otherwise re-encode once.
            if (IMAGE_CODEC.type === 'image/jpeg') {
                return { blob: new Blob([bytes], { type: 'image/jpeg' }), ext: 'jpg' };
            }
            return dmmReencode(bytes);
        }
        return dmmDescrambleJpeg(bytes, page);
    }

    // ---- off-thread tile unshuffle -----------------------------------------

    // The worker only rearranges decoded tiles and re-encodes; the geometry is
    // computed here and sent as rectangles. Keeping the path-derived arithmetic
    // in one place means the worker cannot quietly disagree with the main-thread
    // fallback about where a tile belongs.
    function dmmWorkerJob(id, bytes, page) {
        if (!page || !page.scrambled || !page.width || !page.height) return null;
        const encodedWidth = page.width + (Number(page.dummyWidth) || 0);
        const encodedHeight = page.height + (Number(page.dummyHeight) || 0);
        if (encodedWidth <= 0 || encodedHeight <= 0) return null;
        const rects = dmmTileRects(encodedWidth, encodedHeight, page.pattern);
        if (!rects.length) return null;
        return {
            id: id,
            bytes: bytes,
            rects: rects,
            cleanWidth: page.width,
            cleanHeight: page.height,
            encodedWidth: encodedWidth,
            encodedHeight: encodedHeight,
            mime: IMAGE_CODEC.type,
            quality: IMAGE_CODEC.quality,
        };
    }

    function dmmWorkerMessage(job) {
        return job;
    }

    // A worker is the right place for this: createImageBitmap and convertToBlob
    // are off the UI thread, and a pool overlaps several pages instead of making
    // every page wait behind one main-thread canvas. The source is a string so it
    // travels into the userscript build without a second file or a runtime fetch.
    function dmmWorkerSource() {
        return [
            '"use strict";',
            'async function one(job) {',
            '  const bmp = await createImageBitmap(new Blob([job.bytes], { type: "image/jpeg" }));',
            '  try {',
            '    if (bmp.width !== job.encodedWidth || bmp.height !== job.encodedHeight) {',
            '      throw new Error("DMM page dimensions changed: " + bmp.width + "x" + bmp.height +',
            '        " expected " + job.encodedWidth + "x" + job.encodedHeight);',
            '    }',
            '    const canvas = new OffscreenCanvas(job.cleanWidth, job.cleanHeight);',
            '    const ctx = canvas.getContext("2d");',
            '    if (!ctx) throw new Error("DMM worker has no 2D context");',
            '    for (const r of job.rects) {',
            '      const w = Math.min(r.w, job.cleanWidth - r.dx, bmp.width - r.sx);',
            '      const h = Math.min(r.h, job.cleanHeight - r.dy, bmp.height - r.sy);',
            '      if (w > 0 && h > 0) ctx.drawImage(bmp, r.sx, r.sy, w, h, r.dx, r.dy, w, h);',
            '    }',
            '    const opts = { type: job.mime };',
            '    if (job.quality !== undefined && job.quality !== null) opts.quality = job.quality;',
            '    let blob = null;',
            '    try { blob = await canvas.convertToBlob(opts); }',
            '    catch (e) {}',
            '    if (!blob && job.mime !== "image/png") {',
            '      blob = await canvas.convertToBlob({ type: "image/png" });',
            '    }',
            '    if (!blob) throw new Error("DMM worker produced no image");',
            '    return { id: job.id, blob: blob };',
            '  } finally {',
            '    try { if (bmp.close) bmp.close(); } catch (e) {}',
            '  }',
            '}',
            'self.onmessage = async function (ev) {',
            '  const m = ev.data || {};',
            '  const jobs = Array.isArray(m.jobs) ? m.jobs : [m];',
            '  await Promise.all(jobs.map(async function (job) {',
            '    try {',
            '      const out = await one(job);',
            '      self.postMessage({ batchId: m.batchId, id: out.id, blob: out.blob });',
            '    } catch (e) {',
            '      self.postMessage({ batchId: m.batchId, id: job.id, error: (e && e.message) || String(e) });',
            '    }',
            '  }));',
            '};',
        ].join('\n');
    }

    // A blob worker can be constructed and still be refused by the page's CSP.
    // Ask it to do real OffscreenCanvas work once; only a successful round trip
    // means the run should use the pool.
    function dmmWorkerAllowed() {
        return new Promise(function (resolve) {
            if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined'
                || typeof createImageBitmap !== 'function') {
                resolve(false);
                return;
            }
            let url = null, worker = null, done = false;
            const finish = function (ok) {
                if (done) return;
                done = true;
                if (worker) { try { worker.terminate(); } catch (e) {} }
                if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
                resolve(ok);
            };
            try {
                url = URL.createObjectURL(new Blob([
                    'self.onmessage = async function () {',
                    '  try {',
                    '    const canvas = new OffscreenCanvas(1, 1);',
                    '    const blob = await canvas.convertToBlob({ type: "image/png" });',
                    '    self.postMessage(!!blob);',
                    '  } catch (e) { self.postMessage(false); }',
                    '};',
                ], { type: 'text/javascript' }));
                worker = new Worker(url);
            } catch (e) {
                finish(false);
                return;
            }
            worker.onmessage = function (ev) { finish(!!ev.data); };
            worker.onerror = function () { finish(false); };
            setTimeout(function () { finish(false); }, 1500);
            worker.postMessage(0);
        });
    }

    async function dmmFetchPage(session, page) {
        const url = dmmSignedUrl(session.base + page.file + '/' + page.no + '.' + page.type, session);
        const res = await laneFetch(url, DMM_FETCH_TIMEOUT_MS, {
            allowProxy: proxyCanServe(hostOf(url)),
        });
        if (!res || !res.ok) {
            const err = new Error('DMM page ' + page.file + '/' + page.no
                + ' answered HTTP ' + (res ? res.status : '0'));
            err.status = res ? res.status : 0;
            throw err;
        }
        return await dmmReadResponseBytes(res);
    }

    function dmmSleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function dmmRetryable(error) {
        return !error || !error.status || error.status === 429 || error.status >= 500;
    }
