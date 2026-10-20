    function ebjSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    /**
     * The shared codec speaks {fmt,type,quality,ext,lossless}; the ported
     * encoder reads {mime,qualityValue}. Left unmapped, every page would be
     * encoded with the wrong MIME and nobody would notice until the file was
     * opened again.
     */
    function ebjCodec() {
        const c = resolveImageCodec();
        return {
            fmt: c.fmt, mime: c.type, ext: c.ext, lossless: !!c.lossless,
            quality: c.quality,
            qualityValue: c.lossless ? 1 : (Number(c.quality) || 0.92),
        };
    }

    // "It starts off fast and then slows down to 1 page/s" has three candidate
    // owners: the network fetch, the main-thread decode+descramble+encode, and
    // handing the finished blob to the run harness (ZIP entry, page cache, OCR
    // queue). Guessing between them is what makes a slow run expensive, so
    // every page records how long each stage took and the run ends with the
    // totals and the distribution.
    //
    // It is deliberately cheap: two performance.now() calls per stage per page,
    // no per-page log line, and a bounded sample ring so a 1000-page volume
    // cannot grow the accumulator. The ring keeps min/max exactly (running
    // values) and the median from a fixed 512-slot rotating sample, which is
    // representative without holding a million numbers for a long series.
    const EBJ_TIMING_SAMPLES = 512;

    // The last finished run's timing, kept whole so the console can read the
    // stage split and the lane mix after the fact.
    let ebjLastTiming = null;
    // The prep breakdown, published alongside the timing: it is a run-scoped
    // local, and the timing object is assembled outside ebjRun's scope.
    let ebjLastPrep = null;

    function ebjNow() {
        try { return performance.now(); } catch (e) { return Date.now(); }
    }

    function ebjTimingNew() {
        const stage = () => ({ total: 0, n: 0, min: Infinity, max: 0, ring: [], next: 0 });
        return {
            fetch: stage(), decode: stage(), descramble: stage(), write: stage(),
            lanes: Object.create(null),
            pages: 0,   // pages that reached the harness (the write stage)
            failed: 0,  // pages whose stage threw; excluded from the min/median/max
            retried: 0,
            start: 0,   // set when the page phase begins, not at run entry
            phaseMs: 0,
        };
    }

    function ebjTimingAdd(t, name, ms) {
        const s = t[name];
        if (!s) return;
        const v = (isFinite(ms) && ms > 0) ? ms : 0;
        s.total += v;
        s.n++;
        if (v < s.min) s.min = v;
        if (v > s.max) s.max = v;
        if (s.ring.length < EBJ_TIMING_SAMPLES) s.ring.push(v);
        else s.ring[s.next++ % EBJ_TIMING_SAMPLES] = v;
    }

    /** Which transport actually served a page (gm / page / px:7010 / edge). */
    function ebjTimingLane(t, lane) {
        const k = lane || '?';
        t.lanes[k] = (t.lanes[k] || 0) + 1;
    }

    function ebjMedian(ring) {
        if (!ring || !ring.length) return 0;
        const a = ring.slice().sort((x, y) => x - y);
        const mid = a.length >> 1;
        return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
    }

    // A page between decode and hand-off holds an <img> (or a bitmap) plus a
    // full-intrinsic-size canvas - about 30 MB for a 1600x2400 page, and twice
    // that while the crop copy exists. The socket budget says how many pages may
    // be on the wire; it says nothing about how many may hold pixels, and those
    // two numbers differ by an order of magnitude. CMOA gates the same thing for
    // the same reason (cmoaAcquireSlot), and without it a wide fan-out trades a
    // socket problem for a memory stall - which is what "starts fast, then
    // stalls" is. The gate sits *before* the decode, so the pixels are never made.
    let ebjSlotsBusy = 0;
    let ebjSlotLimit = 16;
    let ebjSlotQueue = [];
    // High-water mark since the last arm: if this sits at the limit for the whole
    // run the gate is the throughput limit, and if it never gets near it, it is
    // not, and the network is.
    let ebjSlotsPeak = 0;

    function ebjSetSlotLimit(limit) {
        const n = limit | 0;
        ebjSlotLimit = (n > 0 && n <= 64) ? n : 16;
        ebjSlotsBusy = 0;
        ebjSlotQueue = [];
        ebjSlotsPeak = 0;
    }

    function ebjAcquireSlot() {
        if (ebjSlotsBusy < ebjSlotLimit) {
            ebjSlotsBusy++;
            if (ebjSlotsBusy > ebjSlotsPeak) ebjSlotsPeak = ebjSlotsBusy;
            return Promise.resolve();
        }
        return new Promise(resolve => ebjSlotQueue.push(resolve));
    }

    function ebjReleaseSlot() {
        const next = ebjSlotQueue.shift();
        if (next) { next(); return; }   // the slot passes straight to the waiter
        ebjSlotsBusy = Math.max(0, ebjSlotsBusy - 1);
    }

    function ebjProcessDepth() {
        return { busy: ebjSlotsBusy, queued: ebjSlotQueue.length, limit: ebjSlotLimit,
                 peak: ebjSlotsPeak };
    }

    function ebjMs(v) {
        if (!isFinite(v) || v <= 0) return '0ms';
        return v >= 1000 ? (v / 1000).toFixed(1) + 's' : Math.round(v) + 'ms';
    }

    function ebjTimingStageText(t, name) {
        const s = t[name];
        if (!s || !s.n) return null;
        return name + ': ' + ebjMs(s.total) + ' total, ' +
            ebjMs(s.min) + ' / ' + ebjMs(ebjMedian(s.ring)) + ' / ' + ebjMs(s.max) +
            ' min/median/max over ' + s.n + ' pages';
    }

    /**
     * The one-line breakdown. fetch is the CDN/GM transport, cpu is everything
     * this thread spent between the bytes arriving and an encoded blob existing
     * (decode split out so a slow JPEG decode is not blamed on the shuffle),
     * write is the harness hand-off. The stage that dominates is the one to fix.
     */
    function ebjTimingLine(t) {
        // Stage totals are summed over concurrent workers, so fetch-total divided
        // by the wall clock is how many pages were genuinely in flight. Near 1
        // means the transport ran them one at a time however wide the fan-out was;
        // a large number means the fan-out was real and something else is the
        // limit. Without this, "249 workers, one page a second" is ambiguous.
        const par = (t.phaseMs > 0 && t.fetch.total > 0)
            ? (t.fetch.total / t.phaseMs) : 0;
        const parts = [
            'fetch ' + ebjMs(t.fetch.total) + (par ? ' (~' + par.toFixed(1) + ' in flight)' : ''),
            'cpu ' + ebjMs(t.decode.total + t.descramble.total) +
                ' (decode ' + ebjMs(t.decode.total) + ' + descramble ' + ebjMs(t.descramble.total) + ')',
            'write ' + ebjMs(t.write.total),
            'wall ' + ebjMs(t.phaseMs) + ebjTimingRate(t),
            t.pages + ' pages timed' +
                (t.retried ? ', ' + t.retried + ' retried' : '') +
                (t.failed ? ', ' + t.failed + ' failed attempt(s)' : ''),
        ];
        const depth = ebjProcessDepth();
        parts.push('gate peak ' + depth.peak + '/' + depth.limit);
        const lanes = Object.keys(t.lanes).sort((a, b) => t.lanes[b] - t.lanes[a]);
        if (lanes.length) parts.push('lanes ' + lanes.map(k => k + ' ' + t.lanes[k]).join(' / '));
        return 'timing: ' + parts.join(' \u00b7 ');
    }

    function ebjTimingRate(t) {
        if (!(t.phaseMs > 0) || !t.pages) return '';
        return ' (' + (t.pages / (t.phaseMs / 1000)).toFixed(1) + ' pages/s)';
    }

    function ebjTimingRaw(t) {
        const lines = ['fetch', 'decode', 'descramble', 'write']
            .map(name => ebjTimingStageText(t, name))
            .filter(Boolean);
        // The wall clock is what makes the stages interpretable: stage totals are
        // summed over concurrent workers, so only the descramble total (one main
        // thread) and this wall clock are directly comparable.
        if (t.phaseMs > 0) {
            lines.push('wall: ' + ebjMs(t.phaseMs) + ' for the page phase' + ebjTimingRate(t));
        }
        return lines;
    }

    function ebjTimingEmpty(t) {
        return !t || (!t.pages && !t.failed);
    }

    /**
     * Surface the measurement where a run is actually read. The harness has
     * usually already written the outcome into the details element, so append
     * the timing line instead of replacing it, and put the per-stage
     * distribution plus the raw failure lines in the collapsible block. EbjLog
     * carries the same line to the console, debug-gated like every other
     * ebookjapan diagnostic. A failure path calls this too: "which stage ate
     * the run" is exactly what a failed run needs to answer.
     */
    function ebjTimingPublish(ui, harness, t) {
        if (ebjTimingEmpty(t)) return;
        const line = ebjTimingLine(t);
        // Kept for the console. A DevTools HAR cannot see this site's page
        // traffic at all - it rides GM_xmlhttpRequest, which never appears there -
        // so the stage split and the lane mix are the only window onto a run, and
        // "which stage ate the wall clock" is the first question every time.
        t.prep = ebjLastPrep;
        ebjLastTiming = t;
        try { ebjLog('timing', line); } catch (e) {}
        // Automation callers read the result object, not the panel; put the same
        // numbers there so a headless run can be measured without scraping logs.
        try {
            const rr = harness && harness.runResult;
            if (rr) {
                rr.timing = {
                    phaseMs: Math.round(t.phaseMs),
                    fetchMs: Math.round(t.fetch.total), decodeMs: Math.round(t.decode.total),
                    descrambleMs: Math.round(t.descramble.total), writeMs: Math.round(t.write.total),
                    pages: t.pages, failed: t.failed, retried: t.retried,
                    lanes: Object.assign({}, t.lanes),
                };
            }
        } catch (e) {}
        try {
            const el = ui && ui.details;
            if (!el) return;
            const existing = (el.textContent || '').trim();
            const raw = ebjTimingRaw(t).concat((harness && harness.errors) || []);
            setRunDetails(el, existing ? (existing + ' \u2014 ' + line) : line, raw);
        } catch (e) {}
    }

    /**
     * Fetch one page, preferring the accelerator ports.
     *
     * This page's CSP is `connect-src 'self' https: wss:`, so a page-realm fetch
     * to `http://127.0.0.1:<port>` is refused before a socket opens. That is why
     * discovery and the proxy lanes ride GM_xmlhttpRequest once the realm is shown
     * to be sealed (see core/21-transport-pool.js) - GM runs in the extension's
     * context and is not subject to it. The old conclusion here, that the
     * accelerator was "genuinely unreachable" for this site, only ever held for a
     * page-realm fetch.
     *
     * It matters because a proxy lane is the only transport that gives this site
     * more than one origin, and one origin is the whole problem: the page CDN
     * sends no Access-Control-Allow-Origin, so `page`/`dot` are refused by CORS,
     * and GM straight at the CDN is a single origin and therefore Chrome's
     * 6-socket ceiling however wide the fan-out is. Each proxy port is its own
     * origin, so 48 ports are 48 socket pools.
     */
    async function ebjFetchPage(url) {
        // The accelerator first, when one is online. proxyLaneFetch answers null
        // rather than falling back to the page lane, so a miss cannot pass for a
        // hit and quietly halve the fan-out.
        if (typeof proxyLaneFetch === 'function' && proxyLaneAvailable()) {
            const viaProxy = await proxyLaneFetch(url, 30000);
            if (viaProxy && viaProxy.ok) {
                const blob = await viaProxy.blob();
                return { buf: await blob.arrayBuffer(), lane: 'px' };
            }
        }
        // GM straight at the CDN. It is not subject to CORS and @connect already
        // lists the host, so it always works - just on one origin.
        if (typeof GM_xmlhttpRequest === 'function') {
            try {
                const r = await new Promise((ok, no) => {
                    GM_xmlhttpRequest({
                        method: 'GET', url: url, responseType: 'blob', timeout: 30000,
                        onload: ok, onerror: no, ontimeout: no,
                    });
                });
                if (r && r.status >= 200 && r.status < 300 && r.response) {
                    return { buf: await r.response.arrayBuffer(), lane: 'gm' };
                }
            } catch (e) { /* fall through to the shared lanes */ }
        }
        // Last resort for a manager without GM: the shared lanes. laneFetch
        // resolves rather than rejecting, and its gm lane answers with
        // {ok,status,blob} only - no headers, no arrayBuffer. So: check res.ok,
        // then go through blob().
        const res = await laneFetch(url, 30000);
        if (!res || !res.ok) throw new Error('HTTP ' + ((res && res.status) || '?'));
        const blob = await res.blob();
        return { buf: await blob.arrayBuffer(), lane: (res._lane && res._lane.kind) || '?' };
    }

    async function ebjRun(ui, mode, options) {
        const runOptions = normalizeRunOptions(options, mode);
        // Function scope on purpose: the arming block below sets these inside a
        // try, but the finally has to terminate the pool, and a `let` inside that
        // try is invisible there — which threw ebjPool is not defined after a
        // run had already saved successfully.
        let ebjPool = null;
        let ebjCanary = null;
        // Per-page stage totals for this whole run (main pass, retry pass and
        // the canary fetches). Function scope for the same reason as ebjPool:
        // the failure path has to be able to report it.
        const ebjTiming = ebjTimingNew();
        const runResult = runOptions.automation
            ? (runOptions.result || newAutomationResult(mode, ebjState.code || '', runOptions.deferFinalize))
            : null;
        if (runResult) { runOptions.result = runResult; runOptions.errors = runResult.errors; }

        let harness = null;
        try {
            reportRunProgress(runOptions, 'started', { mode: mode, cid: ebjState.code || '' });
            ebjLog('run', 'entered: mode=' + mode + ' url=' + location.href +
                ' code=' + (ebjState.code || '?'));
            ebjState.running = true;
            ebjResetCore();

            // Discovery is asked for once here and awaited just before the
            // fan-out is sized. The run does need the port list - sizing the
            // window against a lane table with no ports in it is how a run ends
            // up at "concurrency 20 on 12 sockets" and never uses the bridge - but
            // the *resolve* below does not depend on it, so putting the probe on
            // the critical path only adds its latency to every start. Started
            // here it overlaps the resolve and the viewer round trips.
            const prep = { start: ebjNow(), resolveMs: 0 };
            const discovery = (typeof probeFetchProxy === 'function')
                ? Promise.resolve().then(probeFetchProxy).catch(() => null) : null;

            // The viewer learns the volume a beat after the page loads, and its
            // manifest needs a session the viewer has already negotiated.
            let book = null;
            let lastErr = null;
            for (let i = 0; i < 30; i++) {
                try {
                    book = await ebjResolvePages(location.href);
                    lastErr = null;
                } catch (e) {
                    lastErr = e;
                    book = null;
                    // Say it the first time it happens, not fifteen seconds later:
                    // swallowing this is what made the whole failure invisible.
                    if (i === 0) ebjLog('resolve', 'attempt failed: ' + safeLogText((e && e.message) || e));
                }
                if (book && book.pages && book.pages.length) break;
                // Attempts 1..29 used to be completely silent: a viewer that is
                // slow to report its volume looked exactly like a hung run. The
                // loop can spend 30 x ~1.1s, so say that it is waiting.
                if (i === 0 || (i + 1) % 5 === 0) {
                    ebjLog('resolve', 'the viewer has not reported the volume yet — retry ' +
                        (i + 1) + '/30 after ' + ebjMs(ebjNow() - prep.start));
                }
                await ebjSleep(500);
            }
            prep.resolveMs = ebjNow() - prep.start;
            if (!book || !book.pages || !book.pages.length) {
                throw new Error('the ebookjapan viewer has not reported this volume yet — open ' +
                    'the book and let a page render, then try again.' +
                    (lastErr ? ' (last resolve error: ' + safeLogText((lastErr && lastErr.message) || lastErr) + ')'
                             : ' (the resolve returned no pages and reported no error)'));
            }
            // The autograph overlay is the one page whose scrambled tiles are a
            // separate image. ebjState.payload is what decrypt_session was given.
            try {
                book.autograph = autographSpec(ebjState.payload && ebjState.payload.drmPayload);
            } catch (e) { book.autograph = null; }

            const rawTitle = book.name || book.title || '';
            const title = rawTitle || ebjState.code || 'ebookjapan volume';
            const sv = splitSeriesVolume(title);
            const archiveName = ui.syncArchiveDefault(rawTitle) || zipBaseName(sv, title);
            const rows = book.pages;
            const total = rows.length;
            const geo = { width: (book.canvas && book.canvas.width) || 0, height: (book.canvas && book.canvas.height) || 0 };
            if (!geo.width || !geo.height) throw new Error('could not determine the page canvas size');
            const cid = ebjState.code || '';

            if (runResult) {
                runResult.cid = cid;
                runResult.mode = mode;
                runResult.title = title;
                runResult.total = total;
                reportRunProgress(runOptions, 'book', { title: title, cid: cid });
            }

            harness = createRunHarness(ui, mode, runOptions, { title, archiveName, sv, total, cid });
            harness.setTotal(total);
            if (!runOptions.headless) {
                renderBookCard(ui.statsEl, {
                    title: title, pages: total, resolution: geo.width + ' \u00d7 ' + geo.height,
                    type: (book.direction === true || book.direction === 1) ? 'Right-to-left' : 'Full Edition',
                });
                if (sv.series) fetchAndRenderStats(ui.statsEl, sv.series, sv.volNum);
            }
            harness.showBars();
            if (harness.mokuro) await harness.mokuro.open();
            ebjLog('run', total + ' pages \u00b7 ' + geo.width + 'x' + geo.height + ' \u00b7 ' + title);

            const codec = ebjCodec();
            ebjShape.canvas = 'auto';
            ebjShape.image = 'img';
            let glue = null;
            let gatePassed = false;
            // Released the moment the first page paints (or fails, or takes too
            // long). The fan-out waits on it so the first page is not queued
            // behind every other page's fetch.
            let releaseFirstPaint = () => {};
            const firstPainted = new Promise(res => { releaseFirstPaint = res; });
            const firstPaintTimer = setTimeout(() => releaseFirstPaint(), 20000);

            // One cursor drives both passes. During the main pass it walks every
            // row in order; the retry pass below re-points it at only the indexes
            // that failed and runs the *same* worker() under the *same*
            // concurrency gate. That is what turns the retry tail from N serial
            // main-thread descrambles into one bounded batch, without a second
            // scheduling mechanism to keep in sync with the first.
            let nextIndex = 0;
            let ebjRetryList = null;
            let ebjRetryAt = 0;
            const ebjNextJob = () => {
                if (ebjRetryList) {
                    return ebjRetryAt < ebjRetryList.length ? ebjRetryList[ebjRetryAt++] : -1;
                }
                return nextIndex < total ? nextIndex++ : -1;
            };

            const worker = async () => {
                while (true) {
                    const i = ebjNextJob();
                    if (i < 0) return;
                    const row = rows[i];
                    const pageIdx = i + 1;
                    try {
                        if (!row.url) throw new Error('no page name');
                        const tFetch = ebjNow();
                        const got = await ebjFetchPage(row.url);
                        const tFetched = ebjNow();
                        ebjTimingAdd(ebjTiming, 'fetch', tFetched - tFetch);
                        ebjTimingLane(ebjTiming, got.lane);
                        harness.bumpFetched(1);
                        let out = null;
                        let tDone = tFetched;
                        // A run that adopted the pool descrambles there, which is
                        // what the canary was for and what the retry pass always
                        // did. No pool (ebookjapan's CSP refuses blob: workers)
                        // means the in-thread path below, exactly as before.
                        if (ebjPool && ebjCanary) {
                            try {
                                const res = await ebjPoolPage(ebjPool,
                                    ebjPoolJob(geo, codec, pageIdx, row, got.buf, ebjCanary.withSrc));
                                out = { blob: res.blob, ext: EBJ_MIME_EXT[res.mime] || codec.ext, stats: res.stats };
                                tDone = ebjNow();
                                ebjTimingAdd(ebjTiming, 'descramble', tDone - tFetched);
                            } catch (e) {
                                ebjLog('worker', 'fell back to this thread: ' +
                                    safeLogText((e && e.message) || e));
                            }
                        }
                        if (!out) {
                            // Wait for a pixel slot before decoding, not after:
                            // the whole point is that the canvases are never made
                            // for the pages that are only queued. The network side
                            // stays as wide as the socket budget allows; this is
                            // the memory side, and it is a much smaller number.
                            await ebjAcquireSlot();
                            try {
                                const tDecodeStart = ebjNow();
                                const bitmap = await decodeImage(got.buf);
                                const tDecoded = ebjNow();
                                ebjTimingAdd(ebjTiming, 'decode', tDecoded - tDecodeStart);
                                const aov = (book.autograph && book.autograph.page === row.page)
                                    ? await loadAutographImage(book.autograph) : undefined;
                                out = await descramblePage(glue, bitmap, row, geo,
                                    { codec: codec, autographed: aov });
                                tDone = ebjNow();
                                ebjTimingAdd(ebjTiming, 'descramble', tDone - tDecoded);
                            } finally { ebjReleaseSlot(); }
                        }
                        // The paint gate: "the shuffle ran" is not "the page
                        // painted". The first page decides whether this shape is
                        // believable at all.
                        if (!gatePassed) {
                            const st = out.stats || await canvasStats(null);
                            if (st && !st.error && st.mean < 6) {
                                gatePassed = true;
                                releaseFirstPaint();
                                throw new Error('the descrambler painted an empty page (' + statsText(st) +
                                    ') — refusing to save a book of blank images');
                            }
                            gatePassed = true;
                            prep.firstPageMs = ebjNow() - prep.start;
                            releaseFirstPaint();
                            ebjLog('canary', 'page 1 painted ' + statsText(st) +
                                ' — ' + ebjMs(prep.firstPageMs) + ' after the run started');
                        }
                        harness.notePage(pageIdx, out.blob, out.crc, out.ext);
                        ebjTimingAdd(ebjTiming, 'write', ebjNow() - tDone);
                        ebjTiming.pages++;
                    } catch (e) {
                        ebjTiming.failed++;
                        harness.bumpFetched(1);
                        harness.noteFailure(pageIdx, safeLogText((e && e.message) || e));
                    }
                }
            };

            // Off-thread, on core's own pool. Nothing is trusted on faith: the
            // first page goes through a worker and is adopted only if those pixels
            // pass the same paint gate as any other page. Otherwise this run keeps
            // descrambling on this thread and the cost is one log line.
            // The page phase is what the user experiences as "the download", so
            // its wall clock starts here, after the viewer resolve and the bars.
            // One gate per run: 16 pages may hold a decoded frame or a canvas at
            // once. That is the memory bound the pre-fan-out code had by accident
            // (16 workers), kept deliberately now that the network side is wide.
            ebjSetSlotLimit(16);
            ebjTiming.start = ebjNow();
            try {
                if (typeof makePool === 'function' && typeof Worker !== 'undefined' &&
                    typeof OffscreenCanvas !== 'undefined' && rows[0] && rows[0].url) {
                    const tCanary = ebjNow();
                    const allowed = await ebjWorkerAllowed();
                    prep.canaryMs = ebjNow() - tCanary;
                    if (!allowed) {
                        ebjLog('worker-canary', 'this page\u2019s CSP refuses a blob: worker — ' +
                            'descrambling on this thread');
                        throw { ebjSkipPool: true };
                    }
                    // workerPoolSize() is core's own answer for this machine. The old
                    // cap of 8 was mine, and the real bottleneck here is the shuffle plus
                    // the encode, so use what core asks for. Two pages in flight per
                    // worker overlaps convertToBlob with the next page's shuffle, which is
                    // the same ~10% BookWalker measured.
                    const size = Math.max(2, workerPoolSize());
                    ebjPool = makePool(size, ebjWorkerSource(), ebjPoolDone, 60000, 2, ebjJobMessage);
                    const tCanaryFetch = ebjNow();
                    const first = await ebjFetchPage(rows[0].url);
                    ebjTimingAdd(ebjTiming, 'fetch', ebjNow() - tCanaryFetch);
                    ebjTimingLane(ebjTiming, first.lane);
                    harness.bumpFetched(1);
                    for (const withSrc of [false, true]) {
                        try {
                            const tCanary = ebjNow();
                            const res = await ebjPoolPage(ebjPool, ebjPoolJob(geo, codec, 1, rows[0], first.buf, withSrc));
                            ebjTimingAdd(ebjTiming, 'descramble', ebjNow() - tCanary);
                            ebjLog('worker-canary', 'src=' + withSrc + ' ' + statsText(res.stats));
                            if (res.stats && !res.stats.error && res.stats.mean >= 6) {
                                ebjCanary = { res: res, withSrc: withSrc };
                                break;
                            }
                        } catch (e) {
                            ebjLog('worker-canary', 'src=' + withSrc + ' failed: ' +
                                safeLogText((e && e.message) || e));
                        }
                    }
                    if (ebjCanary) {
                        harness.notePage(1, ebjCanary.res.blob, undefined,
                            EBJ_MIME_EXT[ebjCanary.res.mime] || codec.ext);
                        nextIndex = 1;
                        ebjLog('worker-canary', 'adopted ' + size + ' workers (src=' + ebjCanary.withSrc + ')');
                    } else {
                        try { ebjPool.terminate(); } catch (e) {}
                        ebjPool = null;
                        ebjLog('worker-canary', 'the pool painted nothing — descrambling on this thread');
                    }
                }
            } catch (e) {
                if (ebjPool) { try { ebjPool.terminate(); } catch (e2) {} ebjPool = null; }
                if (!e || !e.ebjSkipPool) {
                    ebjLog('worker-canary', 'pool unavailable: ' + safeLogText((e && e.message) || e));
                }
            }

            // Discovery was started before the resolve; this is where its answer is
            // needed, because the fan-out is sized from the port list. Awaiting it
            // here costs only the part the resolve did not already cover.
            // Only wait for discovery when the run has nothing to size against.
            // The panel polls the same thing, so on a page that has been open more
            // than a moment the port list is already known and this probe is a
            // refresh: awaiting it put the bridge's whole /health round trip in
            // front of the first page for no gain. When it is not known - a cold
            // run - waiting is exactly right, and that is the only case that pays.
            let probeMs = 0;
            const knownPorts = (typeof proxyPorts !== 'undefined' && proxyPorts && proxyPorts.length) || 0;
            if (discovery && !knownPorts) {
                const tProbe = ebjNow();
                try { await discovery; } catch (e) {}
                probeMs = ebjNow() - tProbe;
            } else if (discovery) {
                // Let the refresh settle on its own; it is already cancelled-safe.
                try { discovery.catch(() => {}); } catch (e) {}
            }
            prep.probeMs = probeMs;
            prep.totalMs = ebjNow() - prep.start;
            ebjLastPrep = prep;
            const budget = (typeof fetchSocketBudget === 'function' ? fetchSocketBudget(true) : 6) || 6;
            // The 16 that used to cap this expression was the whole fan-out: no
            // matter what the transport could carry, this site fetched 16 pages at
            // a time. That is the second half of why it felt unaccelerated. The cap
            // is now the same 256-page memory bound CMOA uses - each page holds one
            // blob while the pool descrambles it - and the window is sized from the
            // real budget with headroom so the descramble pool stays fed. Lower it
            // on a low-RAM machine with window.__bwddMaxInflight.
            let inflightCap = 256;
            try {
                if (typeof window !== 'undefined' && window.__bwddMaxInflight > 0) {
                    inflightCap = Math.max(4, Math.min(256, window.__bwddMaxInflight | 0));
                }
            } catch (e) {}
            const concurrency = Math.max(2, Math.min(total, Math.min(inflightCap,
                budget + Math.max(8, Math.round(budget * 0.2)))));
            ebjLog('run', 'concurrency ' + concurrency + ' on ' + budget + ' sockets');
            // Prep is everything between the click and the first page fetch, and
            // it is the phase that felt slow while the download itself got
            // faster. Named per step so the next report says which one it is.
            ebjLog('run', 'prep ' + ebjMs(prep.totalMs) + ' (resolve ' + ebjMs(prep.resolveMs) +
                ' + canary ' + ebjMs(prep.canaryMs || 0) + ' + probe ' + ebjMs(probeMs) +
                ') before the first page');
            glue = await ebjLoadGlue();
            const workers = [];
            // Launch a small first wave, then widen once the first page has
            // painted. Starting all of them at once put the first page - the one
            // that drives the paint gate, the progress bar and the "has it
            // started" question - into the same queue as the other 248, which is
            // why the script looked dead for seconds after the prep line and only
            // then began. The transport does not need a ramp; the first page's
            // latency does, because it is the only page anyone is waiting for.
            const firstWave = Math.max(1, Math.min(concurrency, 12));
            for (let w = 0; w < firstWave; w++) workers.push(worker());
            await firstPainted;
            clearTimeout(firstPaintTimer);
            if (workers.length < concurrency) {
                for (let w = firstWave; w < concurrency; w++) workers.push(worker());
            }
            await Promise.all(workers);

            // One retry pass: a page that failed once is usually a transient lane
            // or session rollover, and the viewer will have settled by now. It is
            // driven through the same worker() and the same `concurrency` gate as
            // the main pass, just with the cursor re-pointed at the failed
            // indexes — a serial awaited loop here was one full main-thread
            // descramble per iteration, which is the "fast, then one page a
            // second" tail this run was reported for. A page that throws again
            // stays failed and is reported below, exactly as before.
            if (harness.failedIdx.size && !runOptions.headless) {
                ebjRetryList = Array.from(harness.failedIdx)
                    .map(n => n - 1)
                    .filter(n => n >= 0 && n < total && rows[n] && rows[n].url)
                    .sort((a, b) => a - b);
                ebjRetryAt = 0;
                if (ebjRetryList.length) {
                    ebjTiming.retried = ebjRetryList.length;
                    ebjLog('run', 'retrying ' + ebjRetryList.length + ' failed page(s) across ' +
                        concurrency + ' workers');
                    const retryWorkers = [];
                    for (let w = 0; w < concurrency; w++) retryWorkers.push(worker());
                    await Promise.all(retryWorkers);
                }
            }

            // Close the page-phase clock here, before the ZIP is assembled or
            // the OCR finalize runs, so "wall" means fetch+descramble time only.
            if (ebjTiming.start) ebjTiming.phaseMs = ebjNow() - ebjTiming.start;

            const missing = total - harness.okIdx.size;
            if (mode === 'ocr' && harness.mokuro) {
                await harness.mokuro.settle();
                if (runOptions.deferFinalize) {
                    ebjTimingPublish(ui, harness, ebjTiming);
                    return harness.mokuro.deferred();
                }
                const fin = await harness.mokuro.finalize();
                harness.markFinished();
                ebjTimingPublish(ui, harness, ebjTiming);
                return harness.outcome(fin.ok);
            }
            if (mode === 'ocr' && !harness.mokuro) throw new Error('Mokuro OCR is unavailable for this run');
            if (missing === total) {
                setRunDetails(harness.details, msgAllFailedZip(), harness.errors);
                ebjTimingPublish(ui, harness, ebjTiming);
                return harness.outcome(false);
            }
            const finished = await harness.finishZip();
            ebjTimingPublish(ui, harness, ebjTiming);
            return finished;
        } catch (e) {
            const text = safeLogText((e && e.stack) || (e && e.message) || e);
            ebjLog('run', 'failed: ' + text);
            // Core's launch() catches a rejected run and only console.warns it,
            // which from the panel is indistinguishable from the button doing
            // nothing. Put it where it will actually be read.
            try {
                setRunDetails(ui.details, 'the run failed: ' + text,
                    harness ? harness.errors : []);
            } catch (e2) {}
            const reported = harness ? harness.reportFailure(e) : null;
            // Last, because reportFailure writes its own one-line panel message:
            // a failed run is exactly when "which stage ate the time" matters,
            // so the timing line is appended after it rather than erased by it.
            ebjTimingPublish(ui, harness, ebjTiming);
            if (reported) throw reported;
            throw e;
        } finally {
            if (ebjPool) { try { ebjPool.terminate(); } catch (e) {} ebjPool = null; }
            ebjState.running = false;
            if (harness) await harness.cleanup();
        }
    }

    function ebjOwnsHost() {
        try { return /(^|\.)ebookjapan\.yahoo\.co\.jp$/i.test(location.hostname); } catch (e) { return false; }
    }
    registerSite({
        id: 'ebookjapan',
        label: 'ebookjapan',
        panelTitle: 'ebookjapan Native Downloader',
        ownsHost() {
            return ebjOwnsHost();
        },
        matches() {
            // The viewer only. A /books/<id>/<code>/ page is the shop's detail
            // page, not the reader: it carries no page list, and an ordinary
            // page load there must do nothing.
            try { return ebjOwnsHost() && /^\/viewer\//.test(location.pathname); } catch (e) { return false; }
        },
        headlessMatches() {
            // A detail page resolves a volume through br_api for an explicitly
            // injected headless run, so the whole store host stays claimable when
            // that is how the script arrived. The header does not match it.
            return ebjOwnsHost();
        },
        install() {
            // The viewer URL carries the volume code, so the adapter knows
            // its id from load. A network resolve only confirms it.
            try {
                const t = ebjParseTarget(location.href);
                if (t && t.code) ebjState.code = t.code;
            } catch (e) {}
        },
        getBook() {
            const b = ebjState.book;
            if (!b) return null;
            const title = b.name || b.title || ebjState.code || '';
            const sv = splitSeriesVolume(title);
            return { rawTitle: b.name || b.title || '', title: title, series: sv.series, volNum: sv.volNum };
        },
        getPreview() {
            const b = ebjState.book;
            if (!b || !b.pages || !b.pages.length) return null;
            const geo = b.canvas || {};
            return {
                title: b.name || b.title || ebjState.code || '',
                pages: b.pages.length,
                resolution: geo.width ? (geo.width + ' \u00d7 ' + geo.height) : '?',
                type: (b.direction === true || b.direction === 1) ? 'Right-to-left' : 'Full Edition',
            };
        },
        getCid() {
            if (ebjState.code) return ebjState.code;
            // Fall back to the URL: the page-cache key and the availability
            // badge read this before anything has been fetched.
            try {
                const t = ebjParseTarget(location.href);
                return (t && (t.code || t.publication)) || '';
            } catch (e) { return ''; }
        },
        // The shared panel awaits this before reading getBook/getPreview, so the
        // title, page count and page size are on the card before a run starts —
        // which is exactly where the standalone script had to bolt this on.
        async refresh() {
            try {
                const b = await ebjResolvePages(location.href);
                if (b && b.pages && b.pages.length) { ebjState.book = b; return true; }
            } catch (e) { ebjLog('refresh', safeLogText((e && e.message) || e)); }
            return false;
        },
        afterBoot() {
            let ticks = 0;
            const timer = setInterval(async () => {
                ticks++;
                if ((ebjState.book && ebjState.book.pages && ebjState.book.pages.length) || ticks > 60) {
                    clearInterval(timer);
                    return;
                }
                try { await ebjResolvePages(location.href); } catch (e) {}
            }, 1500);
        },
        archiveDefault(rawTitle) { return archiveDefaultName(rawTitle) || fsSafePath(ebjState.code || ''); },
        run(ui, mode, options) { return ebjRun(ui, mode, options); },
        state: ebjState,
        debug: {
            get state() { return ebjState; },
            get shape() { return ebjShape; },
            // Pages holding pixels right now, against the gate's limit. This is
            // the number that explains a run that starts fast and then stalls.
            get processDepth() { return ebjProcessDepth(); },
            get lastDecodePath() { return ebjLastDecodePath; },
            get encodePath() { return ebjEncodePath; },
            get lastShuffleTrace() { return ebjLastShuffleTrace; },
            get probeOnce() { return ebjProbeOnce; },
            get simulatedTraps() { return ebjSimulatedTraps; },
        },
        // Call __bwddEbookjapanDebug() from the console for a live answer to
        // "where did it stop?". The standalone had this and it was the fastest
        // way to tell a realm problem from a session problem.
        debugGlobals: {
            __bwddEbookjapan: ebjState,
            __bwddEbookjapanDebug: function ebjDiag() {
                return {
                    href: location.href,
                    code: ebjState.code || '',
                    running: !!ebjState.running,
                    payload: ebjState.payload ? Object.keys(ebjState.payload) : null,
                    pages: (ebjState.book && ebjState.book.pages) ? ebjState.book.pages.length : 0,
                    canvas: ebjState.book && ebjState.book.canvas ? ebjState.book.canvas : null,
                    shape: { canvas: ebjShape.canvas, image: ebjShape.image },
                    // The stage split and the lane mix of the last run, so
                    // "the download is slow" can be answered with numbers:
                    // fetch/decode/descramble/write totals, the wall clock those
                    // add up against, and which transport served each page.
                    timing: ebjLastTiming ? {
                        wallMs: Math.round(ebjLastTiming.phaseMs),
                        pages: ebjLastTiming.pages, failed: ebjLastTiming.failed,
                        retried: ebjLastTiming.retried,
                        fetchMs: Math.round(ebjLastTiming.fetch.total),
                        fetchMedianMs: Math.round(ebjMedian(ebjLastTiming.fetch.ring)),
                        decodeMs: Math.round(ebjLastTiming.decode.total),
                        descrambleMs: Math.round(ebjLastTiming.descramble.total),
                        descrambleMedianMs: Math.round(ebjMedian(ebjLastTiming.descramble.ring)),
                        writeMs: Math.round(ebjLastTiming.write.total),
                        lanes: Object.assign({}, ebjLastTiming.lanes),
                        pagesPerSecond: ebjLastTiming.phaseMs > 0
                            ? +(ebjLastTiming.pages / (ebjLastTiming.phaseMs / 1000)).toFixed(2) : 0,
                    } : null,
                    lastDecodePath: ebjLastDecodePath,
                    encodePath: ebjEncodePath,
                    lastShuffleTrace: ebjLastShuffleTrace,
                    probeOnce: ebjProbeOnce,
                    simulatedTraps: ebjSimulatedTraps,
                };
            },
        },
    });
