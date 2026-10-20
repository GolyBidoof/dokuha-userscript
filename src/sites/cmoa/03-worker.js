    // A CMOA page arrives as a scrambled JPEG whose tiles must be blitted back
    // into place through `getImageDescrambleCoords`, then re-encoded. That used
    // to happen on this thread, one DOM canvas per page, while up to 256 page
    // coroutines were in flight: every blit, every encode and ~10 MB of canvas
    // backing store per page landed on the same thread that services the socket
    // callbacks. With no plan the page still re-encodes, so this is on the path
    // of every page of every volume.
    //
    // The fix is the one BookWalker and ebookjapan already use: core's makePool
    // with a worker that owns its own OffscreenCanvas. What is local here is the
    // job envelope, the worker source and the canary.
    //
    // The *geometry* stays on this thread. Interpreting the viewer's plan needs
    // the decoded dimensions and the page-context reader object, so `blits` is
    // flattened here into plain rectangles and the worker only draws what it is
    // handed. The two paths therefore cannot drift: inline and worker consume
    // the same list.
    const CMOA_JOB_TIMEOUT = 60000;

    // Where each page was reassembled. Counted rather than inferred: the whole
    // point of the pool is that the main thread stops doing this work, and a
    // silent fall back to the inline path would otherwise look identical.
    // `passthrough` is the fourth outcome: nothing had to move, so the delivered
    // bytes were kept and no decode or encode happened at all.
    const cmoaReassembly = { worker: 0, inline: 0, fallback: 0, passthrough: 0 };

    // Escape hatch for the adapter test, which runs the same volume both ways and
    // compares the archives. Set window.__bwddCmoaInline = true before a run.
    function cmoaInlineForced() {
        try { return typeof window !== 'undefined' && window.__bwddCmoaInline === true; }
        catch (e) { return false; }
    }

    /** The job envelope this store posts. makePool ships BookWalker's by default. */
    function cmoaJobMessage(job) {
        return {
            id: job.id,
            bitmap: job.bitmap,
            blits: job.blits,
            width: job.width,
            height: job.height,
            codec: job.codec,
        };
    }

    /**
     * The worker source.
     *
     * Serialised rather than shipped as a separate file because this project has
     * no bundler: the fragments in src/ are concatenated into one IIFE and
     * `makePool` takes the source as a string. The worker is a clean realm with
     * its own OffscreenCanvas, and it keeps one canvas alive per worker, resizing
     * only when a page's geometry actually differs — the old path allocated a
     * fresh full-page canvas for every page.
     */
    function cmoaWorkerSource() {
        return '"use strict";\n' +
            'let canvas = null;\n' +
            'function surface(w, h) {\n' +
            '    if (!canvas) canvas = new OffscreenCanvas(w, h);\n' +
            '    else if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }\n' +
            '    return canvas;\n' +
            '}\n' +
            'async function one(job) {\n' +
            '    const cv = surface(job.width, job.height);\n' +
            '    const ctx = cv.getContext("2d");\n' +
            '    if (!ctx) throw new Error("no 2D context");\n' +
            '    ctx.clearRect(0, 0, cv.width, cv.height);\n' +
            '    if (job.blits && job.blits.length) {\n' +
            '        for (const b of job.blits) {\n' +
            '            try { ctx.drawImage(job.bitmap, b.sx, b.sy, b.w, b.h, b.dx, b.dy, b.w, b.h); }\n' +
            '            catch (e) { /* keep the remaining pieces */ }\n' +
            '        }\n' +
            '    } else {\n' +
            '        ctx.drawImage(job.bitmap, 0, 0);\n' +
            '    }\n' +
            '    if (job.bitmap && job.bitmap.close) { try { job.bitmap.close(); } catch (e) {} }\n' +
            '    const blob = await cv.convertToBlob({ type: job.codec.type, quality: job.codec.quality });\n' +
            '    if (!blob) throw new Error("canvas encode produced nothing");\n' +
            '    return blob;\n' +
            '}\n' +
            'self.onmessage = async ev => {\n' +
            '    const m = ev.data || {};\n' +
            '    for (const job of (m.jobs || [])) {\n' +
            '        try {\n' +
            '            const blob = await one(job);\n' +
            '            self.postMessage({ id: job.id, batchId: m.batchId, blob: blob, mime: blob.type });\n' +
            '        } catch (e) {\n' +
            '            self.postMessage({ id: job.id, batchId: m.batchId, error: (e && e.message) || String(e) });\n' +
            '        }\n' +
            '    }\n' +
            '};\n';
    }

    // Core's pool is a callback per job; the run wants a promise per page.
    let cmoaPool = null;
    let cmoaPoolSize = 0;
    // Kept after close so a finished run can still say how wide it ran.
    let cmoaLastWorkers = 0;
    const cmoaPoolWaiters = new Map();

    function cmoaPoolDone(result) {
        const waiter = result && cmoaPoolWaiters.get(result.id);
        if (!waiter) return;
        cmoaPoolWaiters.delete(result.id);
        if (result.error || !result.blob) waiter.no(new Error(result.error || 'the worker returned no image'));
        else waiter.ok(result);
    }

    // A job id has to be unique per *submission*, not per page. Both this waiter
    // map and `makePool` itself key their bookkeeping by id: the pool keeps one
    // timeout per id and removes an id from a worker's in-flight list by value.
    // A hedged page puts the same page through the pool twice, so keying by
    // `descriptor.index` made the second submission overwrite the first
    // waiter's slot while the pool still echoed two results for that one id.
    // The page then counted on the bars - the winning attempt settled it - but
    // the losing coroutine was left awaiting a result that had already been
    // handed to its twin, so its worker loop never returned and the run never
    // reached the ZIP until a reload cleared the in-flight page from the cache.
    let cmoaJobSeq = 0;
    function cmoaPoolSubmit(job) {
        return new Promise((ok, no) => {
            const id = String(job.id) + ':' + (++cmoaJobSeq);
            cmoaPoolWaiters.set(id, { ok: ok, no: no });
            cmoaPool.submit(Object.assign({}, job, { id: id }));
        });
    }

    /**
     * Start the descramble pool if this page will allow one.
     *
     * Returns the number of pages that may be decoded-and-blitted at once, which
     * is the size of the pool times its batch. That number is the pipeline's real
     * ceiling now: it is the same figure the panel advertises as "decode
     * concurrently", and it bounds decoded frames and canvas backing stores
     * rather than letting one accumulate per in-flight socket.
     */
    async function cmoaOpenProcessPool() {
        const size = workerPoolSize();
        const batch = workerBatchSize(IMAGE_CODEC.type);
        if (cmoaInlineForced()) {
            cmoaLog('worker', 'reassembly forced inline (__bwddCmoaInline)');
            return size * batch;
        }
        if (!(await canSpawnBlobWorker())) {
            cmoaLog('worker', 'this page\u2019s CSP refuses a blob: worker \u2014 reassembling on this thread');
            return size * batch;
        }
        try {
            cmoaPool = makePool(size, cmoaWorkerSource(), cmoaPoolDone, CMOA_JOB_TIMEOUT, batch, cmoaJobMessage);
            cmoaPoolSize = size;
            cmoaLastWorkers = size;
            cmoaLog('worker', 'reassembling on ' + size + ' worker(s), ' + batch + ' page each');
        } catch (e) {
            cmoaPool = null;
            cmoaLog('worker', 'pool unavailable: ' + safeLogText(e && e.message));
        }
        return size * batch;
    }

    function cmoaCloseProcessPool() {
        if (cmoaPool) { try { cmoaPool.terminate(); } catch (e) {} }
        cmoaPool = null;
        cmoaPoolSize = 0;
        for (const waiter of cmoaPoolWaiters.values()) {
            try { waiter.no(new Error('CMOA descramble pool closed')); } catch (e) {}
        }
        cmoaPoolWaiters.clear();
    }

    // At most `limit` pages may hold a decoded frame at once. Without this the
    // pool is not what bounds memory — the page coroutines are, one decoded
    // bitmap each, which is the ~2.6 GB the old path could reach at 256 in
    // flight. The gate sits *before* the decode so the frames are never made.
    let cmoaSlotLimit = 0;
    let cmoaSlotsBusy = 0;
    let cmoaSlotQueue = [];

    function cmoaSetSlotLimit(limit) {
        cmoaSlotLimit = Math.max(1, limit | 0);
    }

    function cmoaAcquireSlot() {
        if (cmoaSlotsBusy < cmoaSlotLimit) {
            cmoaSlotsBusy++;
            return Promise.resolve();
        }
        return new Promise(resolve => cmoaSlotQueue.push(resolve));
    }

    function cmoaReleaseSlot() {
        const next = cmoaSlotQueue.shift();
        if (next) { next(); return; }
        cmoaSlotsBusy = Math.max(0, cmoaSlotsBusy - 1);
    }

    function cmoaProcessDepth() {
        return {
            busy: cmoaSlotsBusy,
            queued: cmoaSlotQueue.length,
            limit: cmoaSlotLimit,
            workers: cmoaPoolSize,
            lastWorkers: cmoaLastWorkers,
        };
    }
