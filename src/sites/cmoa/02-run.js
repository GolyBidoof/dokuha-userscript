    // The shared harness owns the bars, Mokuro session, ZIP assembly and
    // reporting; what is left here is CMOA's own shape: wait for the viewer,
    // enumerate its pages, fetch a bounded number at a time.
    async function cmoaRun(ui, mode, options) {
        const runOptions = normalizeRunOptions(options, mode);
        const runResult = runOptions.automation
            ? (runOptions.result || newAutomationResult(mode, cmoaState.cid || '', runOptions.deferFinalize))
            : null;
        if (runResult) {
            runOptions.result = runResult;
            runOptions.errors = runResult.errors;
        }

        let harness = null;
        try {
            reportRunProgress(runOptions, 'started', { mode: mode, cid: cmoaState.cid || '' });
            cmoaState.qualityBlacklist.clear();
            // Rungs this run has actually seen answer, which is what lets a 403
            // be blamed on the rung rather than on a healthy token (see
            // cmoaFetchPage). Reset with the blacklist so one run's evidence
            // cannot excuse another's.
            cmoaState.winningRungs.clear();
            cmoaState.running = true;
            // Always start at the head of the ladder, whatever rung the viewer
            // itself was using.
            cmoaState.quality = CMOA_QUALITY_ORDER[0];

            // The viewer learns the volume a beat after the page loads; poll
            // rather than failing a click that lands a moment too early.
            let ready = false;
            for (let i = 0; i < 30; i++) {
                await cmoaRefreshState();
                if (cmoaState.ready) { ready = true; break; }
                await new Promise(r => setTimeout(r, 500));
            }
            if (!ready) {
                const missing = cmoaComputeReadiness();
                // The viewer capability line is only paid for on the failure
                // path, and it is the only way to tell a frame that landed on
                // the wrong viewer page from one whose viewer came up without
                // its scrambler.
                const cap = (missing.indexOf('descramble reader') !== -1)
                    ? ' viewer=' + JSON.stringify(cmoaViewerCapabilities()) : '';
                throw new Error('CMOA reader is not ready yet (missing ' + missing.join(', ') +
                    ') on ' + location.href + '.' + cap + ' Open the volume in the speed reader and ' +
                    'let a page render, then try again.');
            }
            reportRunProgress(runOptions, 'state-refresh-ready');

            const rawTitle = cmoaState.rawTitle || cmoaState.title || document.title || '';
            const title = cmoaState.title || cmoaCleanTitle(rawTitle) || cmoaState.cid || 'CMOA volume';
            const sv = splitSeriesVolume(title);
            const archiveName = ui.syncArchiveDefault(cmoaState.title || rawTitle) ||
                zipBaseName(sv, title);
            if (runResult) {
                runResult.cid = cmoaState.cid || '';
                runResult.mode = mode;
                runResult.title = title;
                reportRunProgress(runOptions, 'book', { title: title, cid: cmoaState.cid || '' });
            }

            const descriptors = cmoaState.pages.map((page, index) => ({
                index: index + 1,
                src: page.src,
                image: page.image || null,
            }));
            const total = descriptors.length;
            if (!total) throw new Error('CMOA reader reported no pages for this volume.');

            const resolution = (() => {
                const first = cmoaState.pages.find(p => p.width && p.height);
                return first ? (first.width + ' × ' + first.height) : '?';
            })();

            harness = createRunHarness(ui, mode, runOptions, {
                title, archiveName, sv, total, cid: cmoaState.cid,
            });
            harness.setTotal(total);
            if (runResult) {
                runResult.total = total;
                reportRunProgress(runOptions, 'manifest', { total: total, plaintext: true });
            }

            if (!runOptions.headless) {
                renderBookCard(ui.statsEl, {
                    title, pages: total, resolution, type: 'Full Edition',
                });
                if (sv.series) fetchAndRenderStats(ui.statsEl, sv.series, sv.volNum);
            }
            harness.showBars();
            if (harness.mokuro) await harness.mokuro.open();

            // The descramble pool and its gate are opened before the first page
            // so the run never decodes on this thread by accident, and closed in
            // the finally below. The returned number is the pipeline ceiling.
            cmoaSetSlotLimit(await cmoaOpenProcessPool());

            // The CDN is HTTP/1.1 only, so the browser pins a download to 6
            // sockets per origin and that cap - not the worker count - sets the
            // ceiling. The trailing-dot hostname is the same server but a
            // different origin, worth 6 more sockets, with no local helper; if it
            // does not answer the lane simply stays off.
            //
            // Deliberately not awaited. The probe is a whole CDN round trip and
            // the run used to sit behind it before dispatching anything; it now
            // overlaps the rung probe below, and the lane joins the pool whenever
            // it answers. Probing with the least-restricted rung, not the best
            // one: a free or trial volume refuses the original rendition, so
            // probing q=0 would 403 on exactly the most common volumes and leave
            // the extra origin quietly switched off.
            try {
                const probeRung = CMOA_QUALITY_ORDER[CMOA_QUALITY_ORDER.length - 1];
                const probeUrl = cmoaBuildImageUrl(
                    cmoaState.pages[0],
                    probeRung,
                    cmoaState.lastGoodToken || cmoaState.token || cmoaState.tokenPool[0] || null
                );
                probeDotLane(probeUrl).catch(e => {
                    cmoaLog('dot lane probe skipped', safeLogText(e && e.message));
                });
            } catch (e) {
                cmoaLog('dot lane probe skipped', safeLogText(e && e.message));
            }

            // One page walks the quality ladder alone, before any other page is
            // dispatched. CMOA refuses the original rendition on free and trial
            // volumes, and the ladder can only learn that from the 403 itself, so
            // with every worker starting at the head of the ladder at once a
            // 160-page volume paid one identical 403 per page - each a full
            // origin round trip, measured at 0.4-0.9 s - because the blacklist
            // the first 403 populated arrived after all the others had already
            // been sent. Page 1 pays that cost once and its bytes are kept, which
            // is what lets the fan-out below start on the rung that answers.
            let nextIndex = 0;
            try {
                const first = descriptors[0];
                const cachedFirst = (runOptions.usePageCache && cmoaState.cid)
                    ? await getCachedPage(cmoaState.cid, first.index)
                    : null;
                if (cachedFirst) {
                    // The page is already here, but the rung is not: learn it and
                    // drop those bytes rather than emit a second copy of them.
                    harness.bumpCached(1);
                    harness.noteCached(first.index, cachedFirst, cachedPageCrc.get(cachedFirst));
                    await cmoaWarmQualityRung(first);
                } else {
                    const processed = await cmoaFetchPage(first, 0);
                    harness.bumpFetched(1);
                    if (processed && processed.blob) {
                        harness.notePage(first.index, processed.blob, undefined, processed.ext);
                    } else {
                        harness.noteFailure(first.index, 'page ' + first.index + ': empty response');
                    }
                }
                nextIndex = 1;
            } catch (e) {
                // A probe that cannot fetch page 1 must not fail the run: the
                // fan-out re-runs the same ladder per page, exactly as before.
                cmoaLog('rung probe failed, the fan-out will run the ladder per page',
                    safeLogText((e && e.message) || e));
            }
            // Pages are attempted by `concurrency` pullers, and a page that is
            // anomalously slow is re-attempted on a *free* socket instead of
            // being waited out. That is the tail this fixes: 205 pages land in a
            // few seconds and then the last handful sit there for seconds each,
            // because by then the run's entire rate is those few connections.
            // A hedge only ever starts into capacity nobody else is using, so it
            // cannot add to the pressure that made the page slow in the first
            // place. The first attempt to settle a page owns it.
            const live = new Map();
            const hedgeTasks = new Set();
            const latencies = [];
            let attemptsInFlight = 0;
            let hedgedPages = 0;
            const HEDGE_FLOOR_MS = 1500;
            const HEDGE_DRAINED_FLOOR_MS = 700;
            const HEDGE_FACTOR = 2.5;
            const HEDGE_MAX = 2;
            function hedgeAfterMs(drained) {
                const floor = drained ? HEDGE_DRAINED_FLOOR_MS : HEDGE_FLOOR_MS;
                if (latencies.length < 8) return floor;
                const sorted = latencies.slice().sort((a, b) => a - b);
                const p75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))] || floor;
                // With the queue drained there is nothing left to protect: the
                // only thing a duplicate can cost is a parallel fetch, and the
                // only thing waiting costs is the whole tail.
                return Math.max(floor, Math.round(p75 * (drained ? 1.5 : HEDGE_FACTOR)));
            }
            function noteLatency(ms) {
                latencies.push(ms);
                if (latencies.length > 64) latencies.shift();
            }
            function settlePage(pageIdx, fn) {
                const rec = live.get(pageIdx);
                if (rec && rec.settled) return false;
                if (rec) {
                    rec.settled = true;
                    // Whoever wins the page cancels every other attempt: the
                    // loser is holding a socket on a connection that has already
                    // proved slow, and leaving it to run to its own timeout is
                    // exactly the idle-socket waste this hedge exists to stop.
                    for (const ctrl of rec.aborters) { try { ctrl.abort(); } catch (e) {} }
                }
                fn();
                return true;
            }
            async function attemptPage(i, hedged) {
                const descriptor = descriptors[i];
                const pageIdx = descriptor.index;
                let rec = live.get(pageIdx);
                if (!rec) {
                    rec = { i: i, startedAt: performance.now(), hedges: 0, settled: false, aborters: new Set() };
                    live.set(pageIdx, rec);
                } else if (hedged) {
                    rec.hedges++;
                }
                const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
                if (ctrl) rec.aborters.add(ctrl);
                attemptsInFlight++;
                const t0 = performance.now();
                try {
                    // A page from a previous run needs neither a fetch nor a
                    // descramble; replaying it keeps a resumed volume cheap.
                    let cached = null;
                    if (!hedged && runOptions.usePageCache && cmoaState.cid) {
                        cached = await getCachedPage(cmoaState.cid, pageIdx);
                    }
                    if (cached) {
                        if (settlePage(pageIdx, () => {
                            harness.bumpCached(1);
                            harness.noteCached(pageIdx, cached, cachedPageCrc.get(cached));
                        })) noteLatency(performance.now() - t0);
                        return;
                    }
                    const processed = await cmoaFetchPage(descriptor, i, ctrl && ctrl.signal);
                    if (!settlePage(pageIdx, () => {
                        harness.bumpFetched(1);
                        if (processed && processed.blob) {
                            harness.notePage(pageIdx, processed.blob, undefined, processed.ext);
                        } else {
                            harness.noteFailure(pageIdx, 'page ' + pageIdx + ': empty response');
                        }
                    })) return;   // a hedge already delivered this page
                    noteLatency(performance.now() - t0);
                } catch (e) {
                    // A hedge that lost was aborted on purpose; it is not a
                    // failure and its cancelled timing is not a latency sample.
                    if (settlePage(pageIdx, () => {
                        harness.bumpFetched(1);
                        harness.noteFailure(pageIdx, safeLogText((e && e.message) || e));
                    })) noteLatency(performance.now() - t0);
                } finally {
                    attemptsInFlight--;
                    if (ctrl) rec.aborters.delete(ctrl);
                    const r = live.get(pageIdx);
                    if (r && r.settled && !r.aborters.size) live.delete(pageIdx);
                }
            }
            const worker = async () => {
                while (true) {
                    const i = nextIndex++;
                    if (i >= total) return;
                    await attemptPage(i, false);
                }
            };
            // The hedge watchdog. It runs on the hidden-tab ticker, so a
            // background tab does not freeze it, and it only ever acts when a
            // socket is genuinely free.
            let hedgeTimer = null;
            hedgeTimer = setBackgroundInterval(() => {
                if (attemptsInFlight >= concurrency) return;
                const drained = nextIndex >= total;
                const limit = hedgeAfterMs(drained);
                const now = performance.now();
                for (const [pageIdx, rec] of live) {
                    if (rec.settled || rec.hedges >= HEDGE_MAX) continue;
                    if (now - rec.startedAt < limit) continue;
                    const age = Math.round(now - rec.startedAt);
                    rec.startedAt = now;
                    hedgedPages++;
                    cmoaLog('hedging slow page', pageIdx, age + 'ms, limit ' + limit + 'ms');
                    const p = attemptPage(rec.i, true);
                    hedgeTasks.add(p);
                    const drop = () => hedgeTasks.delete(p);
                    p.then(drop, drop);
                    return;   // one hedge per tick; the next tick re-checks capacity
                }
            }, 250);
            // Size the fan-out from real transport capacity, like the BookWalker
            // pipeline: every online lane carries ~6 connections and is a
            // separate origin, so the page's 6-connection ceiling is not the
            // limit. A hardcoded worker count leaves those ports idle, which is
            // what made CMOA run at one page per request round-trip.
            const LANE_SLOTS = fetchSocketBudget(true);
            // A CMOA worker fetches a page and then hands it to the descramble
            // pool, so this count is about keeping sockets busy and it no longer
            // has to double as a memory bound: `cmoaSetSlotLimit` above caps how
            // many pages may hold a decoded frame or a canvas at once, which is
            // what used to make 256 in-flight pages cost gigabytes. 256 matches
            // what the bridge can feed (48 proxy ports x 6 sockets plus the page
            // and dot origins) while staying inside the browser's socket budget;
            // lower it with window.__bwddMaxInflight if a low-RAM machine swaps.
            let inflightCap = 256;
            try {
                if (typeof window !== 'undefined' && window.__bwddMaxInflight > 0) {
                    inflightCap = Math.max(4, Math.min(256, window.__bwddMaxInflight | 0));
                }
            } catch (e) {}
            const concurrency = Math.max(
                Math.max(1, Math.min(CMOA_FETCH_CONCURRENCY, total)),
                Math.min(inflightCap, Math.min(total,
                    LANE_SLOTS + Math.max(8, Math.round(LANE_SLOTS * 0.2))))
            );
            if (BWDD_DEBUG) {
                console.info('[bwdd/cmoa] lanes=' + allLanes().length + ' sockets=' + LANE_SLOTS +
                    ' page workers=' + concurrency);
            }

            const workers = [];
            for (let w = 0; w < concurrency; w++) workers.push(worker());
            await Promise.all(workers);
            // Stop hedging before the retry pass: a late hedge would race it for
            // the same page. Then let the hedges already in flight finish, so the
            // ZIP cannot be assembled while one is still deciding a page.
            if (hedgeTimer !== null) { clearBackgroundInterval(hedgeTimer); hedgeTimer = null; }
            while (hedgeTasks.size) { await Promise.all(Array.from(hedgeTasks)); }
            if (hedgedPages) cmoaLog('hedged ' + hedgedPages + ' slow page(s) this run');

            // Retry failed pages once after re-reading viewer state: a token
            // rollover mid-run is the common cause. Bounded and parallel - a
            // strictly sequential pass turned a wide failure into a serial tail
            // as long as the volume itself - but deliberately narrow, because
            // the usual cause of a whole-volume failure is systematic and a wide
            // retry would only repeat the same refusal in parallel.
            //
            // A headless caller asks for this explicitly: it runs unattended, so
            // a transient refusal must not be the last word on a volume.
            const retryFailures = runOptions.retryFailedPages === true || !runOptions.headless;
            if (harness.failedIdx.size && retryFailures) {
                await cmoaRefreshState();
                const retry = descriptors.filter(d => harness.failedIdx.has(d.index));
                let retryCursor = 0;
                const retryWorker = async () => {
                    while (true) {
                        const i = retryCursor++;
                        if (i >= retry.length) return;
                        const descriptor = retry[i];
                        try {
                            const processed = await cmoaFetchPage(descriptor, descriptor.index - 1);
                            if (processed && processed.blob) harness.notePage(descriptor.index, processed.blob, undefined, processed.ext);
                        } catch (e) { /* stays failed; reported below */ }
                    }
                };
                // Wide enough that a handful of stragglers retries in one wave
                // rather than six-at-a-time, still bounded so a systematic
                // refusal is not repeated 200-wide into a CDN already refusing.
                const retryWidth = Math.max(CMOA_FETCH_CONCURRENCY, Math.min(24, retry.length));
                const retryWorkers = [];
                for (let w = 0; w < retryWidth; w++) retryWorkers.push(retryWorker());
                await Promise.all(retryWorkers);
            }

            const missing = total - harness.okIdx.size;

            if (mode === 'ocr' && harness.mokuro) {
                await harness.mokuro.settle();
                if (runOptions.deferFinalize) return harness.mokuro.deferred();
                const fin = await harness.mokuro.finalize();
                harness.markFinished();
                return harness.outcome(fin.ok);
            }

            if (mode === 'ocr' && !harness.mokuro) {
                throw new Error('Mokuro OCR is unavailable for this run');
            }

            if (missing === total) {
                setRunDetails(harness.details, msgAllFailedZip(), harness.errors);
                return harness.outcome(false);
            }
            return await harness.finishZip();
        } catch (e) {
            const reported = harness ? harness.reportFailure(e) : null;
            if (reported) throw reported;
            throw e;
        } finally {
            cmoaState.running = false;
            // The pool is per-run: a terminated worker is the only reliable way
            // to drop its OffscreenCanvas and any native codec work still in it.
            cmoaCloseProcessPool();
            if (harness) await harness.cleanup();
        }
    }

    function cmoaOwnsHost() {
        try { return /(^|\.)cmoa\.jp$/i.test(location.hostname); } catch (e) { return false; }
    }
    registerSite({
        id: 'cmoa',
        label: 'CMOA',
        panelTitle: 'CMOA Native Downloader',
        ownsHost() {
            return cmoaOwnsHost();
        },
        matches() {
            // Only the readers. A title page such as /title/100001/ is a storefront
            // with no cid and no viewer, so claiming the whole host painted the panel
            // and its error state over a plain product page. Both reader entry points
            // stay: the speed reader, and the /reader/ path the offline scramble
            // tables are collected from.
            try {
                if (!cmoaOwnsHost()) return false;
                const path = location.pathname;
                return /^\/bib\/speedreader\/?$/.test(path) || /^\/reader\//.test(path);
            } catch (e) { return false; }
        },
        install() {
            try { cmoaInstallCapture(); } catch (e) {}
        },
        getBook() {
            if (!cmoaState.title && !cmoaState.rawTitle) return null;
            const title = cmoaState.title || cmoaCleanTitle(cmoaState.rawTitle);
            const sv = splitSeriesVolume(title);
            return { rawTitle: cmoaState.title || cmoaState.rawTitle, title: title, series: sv.series, volNum: sv.volNum };
        },
        getPreview() {
            if (!cmoaState.ready || !cmoaState.pages.length) return null;
            const first = cmoaState.pages.find(p => p.width && p.height);
            const title = cmoaState.title || cmoaCleanTitle(cmoaState.rawTitle) || cmoaState.cid;
            return {
                title: title,
                pages: cmoaState.pages.length,
                resolution: first ? (first.width + ' × ' + first.height) : '?',
                type: 'CMOA Speed Reader',
            };
        },
        getCid() { return cmoaState.cid || ''; },
        // The panel calls this before getBook/getPreview, so the page list and
        // real title show up as soon as the viewer has them.
        refresh() { return cmoaRefreshState(); },
        afterBoot() {
            // Keep refreshing while the viewer is still coming up; stop as soon
            // as it is ready so an idle page does not poll forever.
            let ticks = 0;
            const timer = setInterval(async () => {
                ticks++;
                if (cmoaState.ready || ticks > 60) { clearInterval(timer); return; }
                try { await cmoaRefreshState(); } catch (e) {}
            }, 1500);
        },
        archiveDefault(rawTitle) { return archiveDefaultName(rawTitle) || fsSafePath(cmoaState.cid || ''); },
        run(ui, mode, options) { return cmoaRun(ui, mode, options); },
        state: cmoaState,
        // Getters, not values: this object is built at load time and the worker
        // fragment that owns these bindings is concatenated after this one.
        debug: {
            cmoaState,
            get cmoaReassembly() { return cmoaReassembly; },
            get cmoaProcessDepth() { return cmoaProcessDepth; },
        },
        debugGlobals: {
            __bwddCmoa: cmoaState,
            // The viewer-free scramble engine, so its geometry can be checked
            // against real tables without mounting a run at all.
            __bwddCmoaScramble: {
                decodeTables: cmoaDecodeTables,
                selectScramble: cmoaSelectScramble,
                plan: cmoaScramblePlan,
                parsePageList: cmoaParsePageList,
            },
        },
    });
