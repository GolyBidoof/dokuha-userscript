    // Ported from the standalone script, where every part of this was forced by
    // a real failure rather than chosen:
    //
    //   * The wasm draws with drawImage, and those draws only land on a canvas
    //     from the PAGE's realm — which is why makeCanvas() builds there. The
    //     viewer's own canvases being page-realm is the proof.
    //   * That page deletes getImageData/toBlob/convertToBlob from its own
    //     prototypes, so pixels are read and images encoded through a hidden
    //     about:blank iframe with untouched prototypes. WebIDL brand checks are
    //     per-interface, not per-realm, so its methods read a page-realm canvas.
    //   * If no canvas encoder exists in any realm, pngFromRgba writes the PNG.
    //   * canvasStats() reads pixels so "the shuffle ran" is never mistaken for
    //     "the page painted": a shape that traps nothing and paints nothing is
    //     exactly how a whole book of identical black pages once shipped. The
    //     run's canary refuses to adopt any shape whose first page fails it.
    //   * The wasm module is single-shot, and its autograph argument must be a
    //     loaded <img> for its page and `undefined` everywhere else — never
    //     null, or it unwraps a None and traps at src/book.rs:910:17.
    //
    // Only the functions this fragment owns are defined here: anything else it
    // calls (crc32Bytes, fmtBytes, safeLogText, ...) comes from the shared core,
    // because two definitions of one name in a single closure would shadow it.
    const ebjShuffleUnwraps = {
        '0x1653b': 'src/book.rs:856:17',
        '0x170b5': 'src/book.rs:717:14',
        '0x1723b': 'src/book.rs:892:17',
        '0x17454': 'src/book.rs:910:17',
    };

    const ebjShape = { canvas: 'auto', image: 'img' };
    let ebjLastDecodePath = '';
    let ebjEncodePath = '';
    let ebjLastShuffleTrace = null;
    let ebjTraceNextShuffle = false;
    let ebjProbeOnce = true;
    let ebjAutographImg = null;
    let ebjSimulatedTraps = 0;
    let ebjFrameRealmSlot = null;

    function ebjLog(kind, text) {
        try {
            if (typeof BWDD_DEBUG !== 'undefined' && BWDD_DEBUG) {
                console.info('[bwdd/ebookjapan] ' + kind + ' ' + text);
            }
        } catch (e) {}
    }

    function autographSpec(drm) {
        const a = drm && drm.autographed;
        if (!a || !a.img) return null;
        return {
            page: parseInt(a.page || '0', 10) || 0,
            type: a.content_type || 'image/png',
            image: a.img,
        };
    }

    async function loadAutographImage(spec) {
        if (ebjAutographImg) return ebjAutographImg;
        const img = document.createElement('img');
        await new Promise((ok, no) => {
            img.onload = () => ok();
            img.onerror = () => no(new Error('the autograph overlay image would not load'));
            img.src = `data:${spec.type};base64,${spec.image}`;
        });
        ebjAutographImg = img;
        return img;
    }

    function wasmFrame(e) {
        const st = String((e && e.stack) || '');
        const hits = [...st.matchAll(/wasm-function\[(\d+)\]:(0x[0-9a-f]+)/gi)].slice(0, 5);
        if (!hits.length) return '';
        const parts = hits.map(m => {
            const off = parseInt(m[2], 16);
            let where = null;
            // Chrome reports either the instruction or its return address.
            for (let d = 0; d <= 4 && !where; d++) {
                where = ebjShuffleUnwraps['0x' + (off - d).toString(16)] || null;
            }
            return `function[${m[1]}]` + (where ? ` (${where})` : '');
        });
        return ', wasm trap at ' + parts.join(' <- ');
    }

    function magic(buf) {
        let s = '';
        const n = Math.min(16, buf ? buf.byteLength : 0);
        const b = new Uint8Array(buf || new ArrayBuffer(0), 0, n);
        for (let i = 0; i < b.length; i++) s += (b[i] >= 32 && b[i] < 127) ? String.fromCharCode(b[i]) : '.';
        return s;
    }

    function bytesToBase64(bytes) {
        let s = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < bytes.length; i += CHUNK) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(s);
    }

    async function decodeImage(buf, { asImage = null } = {}) {
        const wantImg = asImage ? asImage === 'img' : ebjShape.image === 'img';
        const blob = new Blob([buf], { type: 'image/webp' });
        // createImageBitmap() is the fast path, and it decodes from memory, so
        // the page's `img-src` cannot stop it. The bare name can still be
        // missing inside a userscript sandbox even when the page has it, so ask
        // every root before giving up on it.
        const roots = [typeof createImageBitmap === 'function' ? createImageBitmap : null,
            (typeof window !== 'undefined' && window && typeof window.createImageBitmap === 'function')
                ? window.createImageBitmap : null,
            (typeof globalThis !== 'undefined' && globalThis &&
                typeof globalThis.createImageBitmap === 'function') ? globalThis.createImageBitmap : null];
        const cib = wantImg ? null : roots.find(Boolean);
        if (cib) {
            try {
                const bitmap = await cib.call(null, blob);
                try {
                    // Some callers look for the <img> spelling of the size.
                    bitmap.naturalWidth = bitmap.width;
                    bitmap.naturalHeight = bitmap.height;
                } catch (e) { /* expando refused */ }
                ebjLastDecodePath = 'createImageBitmap';
                return bitmap;
            } catch (e) {
                ebjLastDecodePath = 'createImageBitmap threw: ' + ((e && e.message) || e);
            }
        }
        // Fallback for engines without createImageBitmap (or a WebP variant it
        // refuses): decode an <img> from the bytes. This used a blob: URL, which
        // on ebookjapan can never work — the viewer's CSP is
        // `img-src 'self' https: data:` with no blob:, so the load is blocked
        // before it starts. A data: URL is allowed, so the bytes go in as base64.
        ebjLastDecodePath = 'data: URL';
        const url = `data:image/webp;base64,${bytesToBase64(new Uint8Array(buf))}`;
        try {
            const img = new Image();
            img.decoding = 'sync';
            await new Promise((res, rej) => {
                img.onload = () => res();
                img.onerror = () => rej(new Error('the browser refused to decode these bytes'));
                img.src = url;
            });
            if (typeof img.decode === 'function') { try { await img.decode(); } catch (e) {} }
            return img;
        } catch (e) {
            throw new Error(`decode failed after ${ebjLastDecodePath}: ${(e && e.message) || e} ` +
                `(${buf.byteLength} bytes, magic "${magic(buf)}")`);
        }
    }

    function ebjPageDoc() { return (ebjPage && ebjPage.document) || document; }

    /**
     * The page deletes toBlob/toDataURL/convertToBlob/getImageData from its own
     * canvas prototypes (a tainted canvas would still *have* them and throw, so
     * deletion is what the console shows). An about:blank iframe is a fresh
     * realm with its own untouched prototypes, and a method from there works on
     * our canvas: WebIDL brand checks are per-interface, not per-realm.
     */
    function frameRealm() {
        if (ebjFrameRealmSlot !== undefined) return ebjFrameRealmSlot;
        ebjFrameRealmSlot = null;
        let frame = null;
        try {
            const host = ebjPageDoc();
            frame = host.createElement('iframe');
            frame.setAttribute('aria-hidden', 'true');
            frame.style.cssText = 'display:none!important;width:0;height:0;border:0';
            (host.body || host.documentElement).appendChild(frame);
            const w = frame.contentWindow;
            if (w && w.document && w.HTMLCanvasElement && w.CanvasRenderingContext2D) {
                const probe = w.document.createElement('canvas');
                probe.width = probe.height = 1;
                const ctx = probe.getContext('2d');
                if (ctx && typeof ctx.getImageData === 'function') {
                    ebjFrameRealmSlot = w;
                    ebjLog('wasm', 'found a clean canvas realm in a blank iframe ' +
                        '(the page deleted the encoders from its own)');
                }
            }
        } catch (e) { ebjLog('wasm', `no spare canvas realm: ${(e && e.message) || e}`); }
        if (!ebjFrameRealmSlot && frame && frame.parentNode) {
            frame.parentNode.removeChild(frame);
        }
        return ebjFrameRealmSlot;
    }

    function frameRealm() {
        if (ebjFrameRealmSlot !== undefined) return ebjFrameRealmSlot;
        ebjFrameRealmSlot = null;
        let frame = null;
        try {
            const host = ebjPageDoc();
            frame = host.createElement('iframe');
            frame.setAttribute('aria-hidden', 'true');
            frame.style.cssText = 'display:none!important;width:0;height:0;border:0';
            (host.body || host.documentElement).appendChild(frame);
            const w = frame.contentWindow;
            if (w && w.document && w.HTMLCanvasElement && w.CanvasRenderingContext2D) {
                const probe = w.document.createElement('canvas');
                probe.width = probe.height = 1;
                const ctx = probe.getContext('2d');
                if (ctx && typeof ctx.getImageData === 'function') {
                    ebjFrameRealmSlot = w;
                    ebjLog('wasm', 'found a clean canvas realm in a blank iframe ' +
                        '(the page deleted the encoders from its own)');
                }
            }
        } catch (e) { ebjLog('wasm', `no spare canvas realm: ${(e && e.message) || e}`); }
        if (!ebjFrameRealmSlot && frame && frame.parentNode) {
            frame.parentNode.removeChild(frame);
        }
        return ebjFrameRealmSlot;
    }

    function realms() {
        const out = [];
        const push = w => { if (w && out.indexOf(w) === -1) out.push(w); };
        push(frameRealm());
        push(ebjPage);
        try { push(typeof window !== 'undefined' ? window : null); } catch (e) {}
        return out;
    }

    function makeCanvas(w, h, kind = null) {
        const want = kind || ebjShape.canvas;
        // The canvas has to come from the page's realm: that is where the wasm's
        // drawImage actually lands (the viewer's own canvases are proof). The
        // spare realm is only used to *read* pixels back, because the page has
        // deleted getImageData/toBlob from its own prototypes.
        const Off = (ebjPage && ebjPage.OffscreenCanvas) ||
            (typeof OffscreenCanvas === 'function' ? OffscreenCanvas : null);
        if (want !== 'html' && Off) {
            try { return new Off(w, h); } catch (e) {  }
        }
        const doc = (ebjPage && ebjPage.document) || document;
        const c = doc.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
    }

    function tracedCtx(ctx, sink) {
        return new Proxy(ctx, {
            get(t, k) {
                const v = Reflect.get(t, k);
                if (sink.length < 60) {
                    sink.push(typeof k === 'string' ? k : String(k));
                }
                if (typeof v === 'function') {
                    const bound = v.bind(t);
                    return (...args) => {
                        if (sink.length < 60) sink.push(`${String(k)}(${args.length} args)`);
                        return bound(...args);
                    };
                }
                return v;
            },
        });
    }

    async function canvasStats(canvas) {
        try {
            const px = await rgbaFromCanvas(canvas);
            if (!px) return null;
            const d = px.data;
            const step = Math.max(4, Math.floor(d.length / 4000 / 4) * 4);
            let sum = 0, n = 0, black = 0;
            for (let i = 0; i + 3 < d.length; i += step) {
                const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
                sum += v; n++;
                if (v < 8) black++;
            }
            return { mean: sum / Math.max(1, n), black: black / Math.max(1, n), samples: n, via: px.via };
        } catch (e) { return { error: (e && e.message) || String(e) }; }
    }

    function statsText(st) {
        if (!st) return 'pixels unreadable';
        if (st.error) return `pixels unreadable (${st.error})`;
        return `mean ${st.mean.toFixed(1)}/255, ${(100 * st.black).toFixed(0)}% black, ${st.samples} samples via ${st.via}`;
    }

    function imageReport(img) {
        if (!img) return 'no image';
        const src = img.src;
        return `${img.tagName || (img.constructor && img.constructor.name) || typeof img} ` +
            `width=${img.width} height=${img.height} ` +
            `natural=${img.naturalWidth}x${img.naturalHeight} ` +
            `complete=${img.complete} ` +
            `src=${typeof src === 'string' ? `${typeof src}:${src.length}` : String(src)}`;
    }

    async function descramblePage(glue, bitmap, row, geo,
                                  { codec = IMAGE_CODEC, canvasKind = null, autographed = undefined } = {}) {
        if (ebjSimulatedTraps > 0) {
            ebjSimulatedTraps--;
            const trap = new Error('unreachable');
            trap.name = 'RuntimeError';
            trap.stack = 'RuntimeError: unreachable\n    at wasm://wasm/000914c2:wasm-function[139]:0x137f5\n' +
                '    at wasm://wasm/000914c2:wasm-function[213]:0x175f7';
            throw trap;
        }
        const canvas = makeCanvas(geo.width, geo.height, canvasKind);
        const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: false });
        if (!ctx) throw new Error('no 2d canvas context');
        ctx.clearRect(0, 0, geo.width, geo.height);

        // The wasm only ever reads ctx.canvas.{width,height} and calls
        // ctx.drawImage(image, sx, sy, sw, sh, dx, dy) — the destination offsets
        // come from the page's own geometry, which is why the canvas must be the
        // book's intrinsic size rather than the page's display box.
        // Control mark: if our own fill is gone after the shuffle, we are reading a
        // different surface than the wasm painted on; if it survives while the rest
        // is black, the wasm genuinely painted nothing.
        const probing = ebjProbeOnce;
        if (probing) {
            ebjProbeOnce = false;
            try {
                ctx.fillStyle = '#ff0000';
                ctx.fillRect(0, 0, 24, 24);
            } catch (e) { ebjLog('wasm', `control fill failed: ${(e && e.message) || e}`); }
        }

        // The first shuffle of a run is traced: a trap that happens before the
        // wasm has asked for a single tile is a state failure, and one after
        // dozens of drawImage calls is a geometry failure. The two need
        // completely different fixes, and the trap itself says neither.
        let ctxForShuffle = ctx;
        if (ebjTraceNextShuffle) {
            ebjTraceNextShuffle = false;
            ebjLastShuffleTrace = [];
            ebjLog('wasm', 'tracing canvas calls for the first page of this shape');
            ctxForShuffle = tracedCtx(ctx, ebjLastShuffleTrace);
        }
        glue.shuffle({ ctx: ctxForShuffle, x: 0, y: 0, data: { image: bitmap },
            autographed, page: row.page });

        // Trim the transparent padding the tile grid leaves past the page box so
        // small pages do not ship as mostly-empty full-intrinsic canvases.
        const w = row.width || geo.width;
        const h = row.height || geo.height;
        let out = canvas;
        let outW = geo.width, outH = geo.height;
        if (w !== geo.width || h !== geo.height) {
            const cropped = makeCanvas(w, h, canvasKind);
            const cctx = cropped.getContext('2d');
            if (!cctx) throw new Error('no 2d canvas context');
            cctx.drawImage(canvas, 0, 0);
            out = cropped;
            outW = w;
            outH = h;
        }

        if (probing) {
            let mark = 'unreadable';
            try {
                const px = await rgbaFromCanvas(out);
                mark = px && px.data.length >= 4
                    ? `${px.data[0]},${px.data[1]},${px.data[2]} (want 255,0,0)`
                    : 'short buffer';
            } catch (e) { mark = (e && e.message) || String(e); }
            const cname = (canvas.constructor && canvas.constructor.name) || typeof canvas;
            ebjLog('wasm', `probe: our control fill at 0,0 = ${mark} | ` +
                `canvas ${cname} ${canvas.width}x${canvas.height} option=${canvasKind || ebjShape.canvas} ` +
                `pageRealm=${ebjPage ? 'yes' : 'no'} spareRealm=${frameRealm() ? 'yes' : 'no'} | ` +
                `image ${imageReport(bitmap)}`);
        }
        const stats = await canvasStats(out);
        const blob = await canvasToBlob(out, codec);
        if (bitmap && typeof bitmap.close === 'function') { try { bitmap.close(); } catch (e) {} }
        const buf = new Uint8Array(await blob.arrayBuffer());
        // An encoder may quietly hand back PNG when asked for something it will
        // not produce, so the blob's own type decides the extension.
        const mime = blob.type || codec.mime;
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mime] || codec.ext;
        return { blob, width: outW, height: outH, ext, mime, stats,
                 crc: crc32Bytes(buf), bytes: buf.byteLength };
    }

    async function deflateBytes(bytes) {
        const cs = new CompressionStream('deflate');
        const w = cs.writable.getWriter();
        w.write(bytes);
        w.close();
        return new Uint8Array(await new Response(cs.readable).arrayBuffer());
    }

    function pngChunk(type, data) {
        const out = new Uint8Array(12 + data.length);
        const dv = new DataView(out.buffer);
        dv.setUint32(0, data.length);
        for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
        out.set(data, 8);
        dv.setUint32(8 + data.length, crc32Bytes(out.subarray(4, 8 + data.length)));
        return out;
    }

    async function pngFromRgba(width, height, rgba) {
        const stride = width * 4;
        const raw = new Uint8Array(height * (stride + 1));
        for (let y = 0; y < height; y++) {
            raw[y * (stride + 1)] = 0;                       // filter: none
            raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
        }
        const ihdr = new Uint8Array(13);
        const dv = new DataView(ihdr.buffer);
        dv.setUint32(0, width);
        dv.setUint32(4, height);
        ihdr[8] = 8;    // bit depth
        ihdr[9] = 6;    // colour type: RGBA
        const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        return new Blob([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', await deflateBytes(raw)),
            pngChunk('IEND', new Uint8Array(0))], { type: 'image/png' });
    }

    async function rgbaFromCanvas(canvas) {
        const notes = [];
        try {
            const ctx = canvas.getContext('2d');
            let get = ctx && ctx.getImageData;
            for (const w of realms()) {
                if (get) break;
                const P = w && w.CanvasRenderingContext2D && w.CanvasRenderingContext2D.prototype;
                if (P && typeof P.getImageData === 'function') get = P.getImageData;
            }
            if (get) {
                const d = get.call(ctx, 0, 0, canvas.width, canvas.height);
                if (d && d.data && d.data.length >= canvas.width * canvas.height * 4) {
                    return { width: canvas.width, height: canvas.height, data: d.data, via: 'getImageData', notes };
                }
                notes.push('getImageData: short buffer');
            } else {
                notes.push('getImageData: hidden');
            }
        } catch (e) { notes.push(`getImageData: ${(e && e.message) || e}`); }
        if (typeof VideoFrame === 'function') {
            try {
                const frame = new VideoFrame(canvas, { timestamp: 0 });
                const w = frame.displayWidth, h = frame.displayHeight;
                const buf = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
                await frame.copyTo(buf, { format: 'RGBA' });
                frame.close();
                if (buf.length >= w * h * 4) {
                    return { width: w, height: h, data: buf, via: 'VideoFrame.copyTo', notes };
                }
                notes.push('VideoFrame: short buffer');
            } catch (e) { notes.push(`VideoFrame: ${(e && e.message) || e}`); }
        } else {
            notes.push('VideoFrame: missing');
        }
        return null;
    }

    function encodeReport(canvas, notes) {
        const kind = (canvas && canvas.constructor && canvas.constructor.name) || typeof canvas;
        const has = (o, k) => (o && typeof o[k] === 'function' ? 'yes' : 'no');
        const proto = canvas && Object.getPrototypeOf(canvas);
        return `${kind} ${canvas && canvas.width}x${canvas && canvas.height} | ` +
            `own{convertToBlob:${has(canvas, 'convertToBlob')},toBlob:${has(canvas, 'toBlob')},` +
            `toDataURL:${has(canvas, 'toDataURL')},getImageData:${has(canvas, 'getImageData')}} | ` +
            `ctxGetImageData:${(() => { try { const c = canvas.getContext('2d'); return c && typeof c.getImageData === 'function' ? 'yes' : 'no'; } catch (e) { return 'throws'; } })()} | ` +
            `VideoFrame:${typeof VideoFrame === 'function' ? 'yes' : 'no'} | ` +
            `CompressionStream:${typeof CompressionStream === 'function' ? 'yes' : 'no'} | ` +
            `transferToImageBitmap:${has(canvas, 'transferToImageBitmap')} | ` +
            `pageRealm:${ebjPage ? 'yes' : 'no'} | ` +
            `proto{convertToBlob:${has(proto, 'convertToBlob')},toBlob:${has(proto, 'toBlob')},` +
            `toDataURL:${has(proto, 'toDataURL')}}` +
            (notes.length ? ' | ' + notes.join(' | ') : '');
    }

    function blobFromDataUrl(url, fallbackMime) {
        const comma = url.indexOf(',');
        const bin = atob(url.slice(comma + 1));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const mime = (url.slice(0, comma).match(/^data:([^;,]+)/) || [])[1] || fallbackMime;
        return new Blob([bytes], { type: mime });
    }

    function canvasToBlob(canvas, codec = IMAGE_CODEC) {
        const q = codec.qualityValue;
        return new Promise((resolve, reject) => {
            const notes = [];
            // A sandbox may strip the encoder off the object it hands over; the
            // page realm still carries it on the prototype, so call that instead.
            const from = name => {
                if (canvas && typeof canvas[name] === 'function') return canvas[name].bind(canvas);
                for (const w of realms()) {
                    if (!w) continue;
                    for (const C of [w.OffscreenCanvas, w.HTMLCanvasElement]) {
                        if (!C || !C.prototype || typeof C.prototype[name] !== 'function') continue;
                        try { if (canvas instanceof C) return C.prototype[name].bind(canvas); }
                        catch (e) { /* cross-realm instanceof can refuse */ }
                    }
                }
                return null;
            };
            const enc = {
                convertToBlob: from('convertToBlob'),
                toBlob: from('toBlob'),
                toDataURL: from('toDataURL'),
            };
            const notPassed = m => { notes.push(m); lastResort(); };
            const fromPng = () => enc.convertToBlob({ type: 'image/png' }).then(
                b => { ebjEncodePath = 'convertToBlob(png)'; resolve(b); },
                e => notPassed(`convertToBlob(png): ${(e && e.message) || e}`));

            let pxNotes = [];
            function lastResort() {
                // toDataURL is the encoder a patched page usually leaves alone.
                if (enc.toDataURL) {
                    try {
                        const url = enc.toDataURL(codec.mime, q);
                        if (url && url.indexOf('data:') === 0) {
                            const blob = blobFromDataUrl(url, codec.mime);
                            ebjEncodePath = 'toDataURL(' + blob.type + ')';
                            resolve(blob);
                            return;
                        }
                        notes.push('toDataURL: not a data URL');
                    } catch (e) { notes.push(`toDataURL threw: ${(e && e.message) || e}`); }
                } else {
                    notes.push('toDataURL: not a function');
                }
                rgbaFromCanvas(canvas).then(px => {
                    if (!px) {
                        reject(new Error('no canvas encoder worked \u2014 ' +
                            encodeReport(canvas, notes.concat(pxNotes))));
                        return;
                    }
                    return pngFromRgba(px.width, px.height, px.data).then(blob => {
                        ebjEncodePath = `rgba->png via ${px.via}`;
                        resolve(blob);
                    });
                }, e => reject(new Error('no canvas encoder worked \u2014 ' +
                    encodeReport(canvas, notes.concat([String((e && e.message) || e)])))));
            }

            if (enc.convertToBlob) {
                enc.convertToBlob({ type: codec.mime, quality: q }).then(
                    b => { ebjEncodePath = 'convertToBlob'; resolve(b); },
                    e => {
                        notes.push(`convertToBlob(${codec.mime}): ${(e && e.message) || e}`);
                        fromPng();
                    });
                return;
            }
            if (enc.toBlob) {
                try {
                    enc.toBlob(b => {
                        if (b) { ebjEncodePath = 'toBlob'; resolve(b); }
                        else notPassed('toBlob: null (tainted or refused)');
                    }, codec.mime, q);
                    return;
                } catch (e) { notes.push(`toBlob threw: ${(e && e.message) || e}`); }
            } else {
                notes.push('toBlob: not a function');
            }
            lastResort();
        });
    }

    function asArrayBuffer(v) {
        if (!v) return null;
        if (typeof v.byteLength === 'number' && typeof v.slice === 'function') {
            // ArrayBuffer, or a typed-array view over one.
            return v instanceof Uint8Array
                ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)
                : v;
        }
        return null;
    }

    async function asBytes(v) {
        const direct = asArrayBuffer(v);
        if (direct) return direct;
        if (v && typeof v.arrayBuffer === 'function') {
            const ab = await v.arrayBuffer();
            return asArrayBuffer(ab) || ab;
        }
        if (typeof v === 'string') {                      // a manager that ignored responseType
            return new TextEncoder().encode(v).buffer;
        }
        return null;
    }
