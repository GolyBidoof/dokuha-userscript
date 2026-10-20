    // The shuffle is a synchronous burst on whatever thread runs it, so a run of
    // pages starves the UI thread. A worker is a clean realm: its OffscreenCanvas
    // keeps convertToBlob and getImageData, and the glue's Window shim already
    // accepts a worker global. Each worker installs its own copy of the pack,
    // because the module is single-shot and a second decrypt_session traps.
    //
    // The pool itself is core's makePool, the same one BookWalker uses. What is
    // local here is only the job envelope and the worker source, which is what
    // makePool's sixth argument exists for.
    const EBJ_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

    /**
     * The job envelope this store posts. makePool ships BookWalker's
     * relPath/seeds/q shape by default; this one carries the page's geometry and
     * the session material the worker needs to install its own pack.
     */
    function ebjJobMessage(job) {
        return {
            id: job.id,
            page: job.page,
            width: job.width,
            height: job.height,
            withSrc: !!job.withSrc,
            blob: job.blob,
            sessionId: job.sessionId,
            code: job.code,
            openPayload: job.openPayload,
            drmPayload: job.drmPayload,
            params: job.params,
            codec: job.codec,
            autograph: job.autograph || null,
        };
    }

    /**
     * The worker source. Both the glue and the wasm ride inside it as base64, so
     * nothing heavy crosses postMessage and a spawn costs one Blob URL for the
     * whole pool. The module is installed lazily on the first page and reused for
     * every page after, and a batch is walked in order so two pages never race on
     * one canvas.
     */
    function ebjWorkerSource() {
        return '"use strict";\n' +
            'const GLUE = (function () { ' + atob(EBJ_GLUE_B64) + ' })();\n' +
            'const WASM_B64 = "' + EBJ_WASM_B64 + '";\n' +
            'let mod = null, ready = null;\n' +
            'function dec(b) { const s = atob(b), u = new Uint8Array(s.length);\n' +
            '    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }\n' +
            'function install(job) {\n' +
            '    if (ready) return ready;\n' +
            '    ready = (async () => {\n' +
            '        const m = GLUE();\n' +
            '        await m.default({ module_or_path: dec(WASM_B64) });\n' +
            '        await m.decrypt_session(job.sessionId, job.code, job.openPayload, job.drmPayload);\n' +
            '        if (job.params) await m.open_param(job.params);\n' +
            '        return m;\n' +
            '    })();\n' +
            '    return ready;\n' +
            '}\n' +
            'async function one(job) {\n' +
            '    const m = await install(job);\n' +
            '    const bytes = new Uint8Array(await job.blob.arrayBuffer());\n' +
            '    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/webp" }));\n' +
            '    try { bmp.naturalWidth = bmp.width; bmp.naturalHeight = bmp.height; } catch (e) {}\n' +
            '    if (job.withSrc) {\n' +
            '        let s = "";\n' +
            '        for (let i = 0; i < bytes.length; i += 0x8000) {\n' +
            '            s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));\n' +
            '        }\n' +
            '        try { bmp.src = "data:image/webp;base64," + btoa(s); } catch (e) {}\n' +
            '    }\n' +
            '    let overlay;\n' +
            '    if (job.autograph && job.autograph.page === job.page) {\n' +
            '        const ob = dec(job.autograph.image);\n' +
            '        overlay = await createImageBitmap(new Blob([ob], { type: job.autograph.type }));\n' +
            '        try {\n' +
            '            overlay.naturalWidth = overlay.width;\n' +
            '            overlay.naturalHeight = overlay.height;\n' +
            '            overlay.src = "data:" + job.autograph.type + ";base64," + job.autograph.image;\n' +
            '        } catch (e) {}\n' +
            '    }\n' +
            '    const canvas = new OffscreenCanvas(job.width, job.height);\n' +
            '    const ctx = canvas.getContext("2d");\n' +
            '    m.shuffle({ ctx: ctx, x: 0, y: 0, data: { image: bmp },\n' +
            '        autographed: overlay, page: job.page });\n' +
            '    let stats = null;\n' +
            '    try {\n' +
            '        const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;\n' +
            '        const step = Math.max(4, Math.floor(d.length / 4000 / 4) * 4);\n' +
            '        let sum = 0, n = 0, black = 0;\n' +
            '        for (let i = 0; i + 3 < d.length; i += step) {\n' +
            '            const v = (d[i] + d[i + 1] + d[i + 2]) / 3;\n' +
            '            sum += v; n++; if (v < 8) black++;\n' +
            '        }\n' +
            '        stats = { mean: sum / Math.max(1, n), black: black / Math.max(1, n),\n' +
            '            samples: n, via: "worker getImageData" };\n' +
            '    } catch (e) { stats = { error: (e && e.message) || String(e) }; }\n' +
            '    if (bmp.close) { try { bmp.close(); } catch (e) {} }\n' +
            '    const blob = await canvas.convertToBlob({ type: job.codec.mime, quality: job.codec.quality });\n' +
            '    return { blob: blob, mime: job.codec.mime, width: canvas.width, height: canvas.height, stats: stats };\n' +
            '}\n' +
            'self.onmessage = async ev => {\n' +
            '    const m = ev.data || {};\n' +
            '    const jobs = m.jobs || [];\n' +
            '    for (const job of jobs) {\n' +
            '        try {\n' +
            '            const out = await one(job);\n' +
            '            self.postMessage({ id: job.id, batchId: m.batchId, blob: out.blob, mime: out.mime,\n' +
            '                width: out.width, height: out.height, stats: out.stats });\n' +
            '        } catch (e) {\n' +
            '            self.postMessage({ id: job.id, batchId: m.batchId, error: (e && e.message) || String(e) });\n' +
            '        }\n' +
            '    }\n' +
            '};\n';
    }

    // Core's pool is callback per job; the run wants a promise per page.
    const ebjPoolWaiters = new Map();

    function ebjPoolDone(result) {
        const waiter = result && ebjPoolWaiters.get(result.id);
        if (!waiter) return;
        ebjPoolWaiters.delete(result.id);
        if (result.error || !result.blob) waiter.no(new Error(result.error || 'the worker returned no image'));
        else waiter.ok(result);
    }

    function ebjPoolPage(pool, job) {
        return new Promise((ok, no) => {
            ebjPoolWaiters.set(job.id, { ok: ok, no: no });
            pool.submit(job);
        });
    }

    /**
     * One page as a pool job. The worker installs its pack from the first job it
     * sees and keeps it, so this carries the session material every time and the
     * worker ignores it after the first.
     */
    function ebjPoolJob(geo, codec, index, row, buf, withSrc) {
        const p = ebjState.payload || {};
        const book = ebjState.book;
        return {
            id: index,
            page: row.page,
            width: geo.width,
            height: geo.height,
            withSrc: !!withSrc,
            blob: new Blob([buf], { type: 'image/webp' }),
            sessionId: p.sessionId,
            code: p.code,
            openPayload: p.openPayload,
            drmPayload: p.drmPayload,
            params: ebjState.params,
            codec: codec,
            autograph: (book && book.autograph) ? book.autograph : null,
        };
    }

    /**
     * Can this page run a worker at all? ebookjapan sets no worker-src, so
     * script-src governs and it allows no blob:, which means new Worker(blobURL)
     * is refused. That refusal does not throw the constructor — the worker fires
     * error instead — so core's pool would respawn a blocked worker on every
     * failure and bury the console. One probe answers it, and the run then stays
     * on this thread by choice rather than by accident.
     */
    function ebjWorkerAllowed() {
        return new Promise(resolve => {
            let url = null, w = null, done = false;
            const finish = ok => {
                if (done) return;
                done = true;
                if (w) { try { w.terminate(); } catch (e) {} }
                if (url) { try { URL.revokeObjectURL(url); } catch (e) {} }
                resolve(ok);
            };
            try {
                url = URL.createObjectURL(new Blob(['self.postMessage(1);'], { type: 'text/javascript' }));
                w = new Worker(url);
            } catch (e) { finish(false); return; }
            w.onmessage = () => finish(true);
            w.onerror = () => finish(false);
            setTimeout(() => finish(false), 1500);
        });
    }
