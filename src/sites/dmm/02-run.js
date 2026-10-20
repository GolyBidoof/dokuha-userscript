    // The shared harness owns the bars, the Mokuro session, the ZIP assembly
    // and the reporting. What is left here is DMM's own shape: one auth call, a
    // manifest, a wide network fan-out, and one 64×64 tile unshuffle per page.
    //
    // Network and decode are deliberately separate. The fetch width follows the
    // real socket budget, so every bridge port can be busy. Descrambling then
    // runs through an OffscreenCanvas worker pool, with a small main-thread
    // fallback for a page whose CSP refuses blob workers. Tying fetch and decode
    // to the same fixed worker count made the transport look serial: while eight
    // canvases were rebuilding, every other lane had nothing in flight.

    async function dmmRun(ui, mode, options) {
        const runOptions = normalizeRunOptions(options, mode);
        const runResult = runOptions.automation
            ? (runOptions.result || newAutomationResult(mode, dmmState.contentId || '', runOptions.deferFinalize))
            : null;
        if (runResult) {
            runOptions.result = runResult;
            runOptions.errors = runResult.errors;
        }

        // Start bridge discovery before the auth and manifest round trips so it
        // is usually already answered by the time the fan-out is sized. Without
        // this a cold run can size itself against the page origin alone and
        // leave every extra bridge port idle for the whole volume.
        const discovery = typeof probeFetchProxy === 'function'
            ? Promise.resolve().then(probeFetchProxy).catch(function () { return null; })
            : null;

        let harness = null;
        let dmmPool = null;
        let dmmPoolSeq = 0;
        let dmmPoolFailures = 0;
        const dmmPoolWaiters = new Map();

        const dmmStopPool = function (reason) {
            const pool = dmmPool;
            if (!pool) return;
            dmmPool = null;
            for (const [id, waiter] of dmmPoolWaiters) {
                dmmPoolWaiters.delete(id);
                waiter.no(new Error(reason || 'DMM worker pool stopped'));
            }
            try { pool.terminate(); } catch (e) {}
        };
        const dmmPoolDone = function (result) {
            const waiter = result && dmmPoolWaiters.get(result.id);
            if (!waiter) return;
            dmmPoolWaiters.delete(result.id);
            if (result.error || !result.blob) {
                waiter.no(new Error(result.error || 'DMM worker returned no image'));
            } else {
                waiter.ok(result);
            }
        };
        const dmmPoolPage = function (job, pool) {
            return new Promise(function (resolve, reject) {
                dmmPoolWaiters.set(job.id, { ok: resolve, no: reject });
                try {
                    pool.submit(job);
                } catch (e) {
                    dmmPoolWaiters.delete(job.id);
                    reject(e);
                }
            });
        };

        try {
            reportRunProgress(runOptions, 'started', { mode: mode, cid: dmmState.contentId || '' });
            dmmState.running = true;
            if (!dmmState.ready) dmmRefreshState();
            const viewer = dmmState.viewer;
            if (!viewer || !viewer.cid) {
                throw new Error('This is not a DMMブックス viewer page: open a free volume or a '
                    + '試し読み sampler and start the download there.');
            }

            // The panel's background probe already paid for auth + manifest.
            // Reuse it only for a few seconds: CloudFront signatures and the
            // sampler's auth_info are short-lived, and a stale one would turn
            // every page into a 403.
            let session = null;
            let pages = null;
            const probe = dmmProbeFresh();
            if (probe) {
                session = probe.session;
                pages = probe.pages;
                dmmLog('run reuses the panel probe', pages.length + ' page(s)');
            } else {
                session = await dmmAuth(viewer);
                // A manifest request is the one call made before any page has
                // taught us whether the signature is current. Give it the same
                // 403-refresh and 429/5xx patience as a page.
                let manifestError = null;
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        pages = await dmmFetchManifest(session);
                        break;
                    } catch (e) {
                        manifestError = e;
                        if (e && e.status === 403 && attempt === 0) {
                            session = await dmmAuth(viewer);
                            continue;
                        }
                        if (dmmRetryable(e) && attempt < 2) {
                            await dmmSleep(500 * (attempt + 1));
                            continue;
                        }
                        throw e;
                    }
                }
                if (!pages) throw manifestError || new Error('DMM manifest could not be read');
                dmmState.probe = { session: session, pages: pages, at: Date.now() };
            }

            const total = pages.length;
            if (!total) throw new Error('DMM listed no pages for this volume.');
            dmmState.total = total;
            const first = pages.find(function (page) { return page.width && page.height; });
            dmmState.resolution = first ? (first.width + ' × ' + first.height) : '';

            const rawTitle = dmmState.rawTitle || dmmTitleFromDocument() || ('DMM ' + viewer.contentId);
            const title = dmmState.title || cleanTitle(rawTitle) || rawTitle;
            const sv = splitSeriesVolume(title);
            const archiveName = ui.syncArchiveDefault(rawTitle) || zipBaseName(sv, title);
            const cid = viewer.contentId + (dmmState.sample ? 'sample' : '');

            if (runResult) {
                runResult.cid = cid;
                runResult.mode = mode;
                runResult.title = title;
                reportRunProgress(runOptions, 'book', { title: title, cid: cid });
            }

            harness = createRunHarness(ui, mode, runOptions, {
                title: title, archiveName: archiveName, sv: sv, total: total, cid: cid,
            });
            harness.setTotal(total);
            if (runResult) {
                runResult.total = total;
                reportRunProgress(runOptions, 'manifest', { total: total, plaintext: true });
            }
            if (!runOptions.headless) {
                renderBookCard(ui.statsEl, {
                    title: title,
                    pages: total,
                    resolution: dmmState.resolution,
                    type: dmmState.sample ? 'DMMブックス 試し読み' : 'DMMブックス 無料',
                });
                if (sv.series) fetchAndRenderStats(ui.statsEl, sv.series, sv.volNum);
            }
            harness.showBars();
            if (harness.mokuro) await harness.mokuro.open();

            // The panel normally has a fresh port list already. A headless or
            // just-opened page does not, so wait for the probe only when there
            // is nothing to size against; otherwise let it refresh in place.
            const knownPorts = typeof proxyPorts !== 'undefined' && proxyPorts && proxyPorts.length;
            if (discovery && !knownPorts) {
                try { await discovery; } catch (e) {}
            } else if (discovery) {
                try { discovery.catch(function () {}); } catch (e) {}
            }
            const laneBudget = typeof fetchSocketBudget === 'function'
                ? fetchSocketBudget(true) : 6;
            let inflightCap = DMM_MAX_INFLIGHT;
            try {
                if (typeof window !== 'undefined' && window.__bwddMaxInflight > 0) {
                    inflightCap = Math.max(4, Math.min(DMM_MAX_INFLIGHT,
                        window.__bwddMaxInflight | 0));
                }
            } catch (e) {}
            let cores = DMM_DECODE_CONCURRENCY;
            try { cores = navigator.hardwareConcurrency || cores; } catch (e) {}
            const fanout = dmmFanoutPlan(total, runOptions.dmmConcurrency, laneBudget,
                inflightCap, Math.max(4, Math.min(8, cores)));
            const concurrency = fanout.fetchWidth;
            dmmLog('fan-out', concurrency + ' fetchers, ' + fanout.decodeWidth +
                ' decoders, ' + laneBudget + ' socket slots' +
                (typeof allLanes === 'function' ? ', ' + allLanes().length + ' lanes' : ''));
            // Off-thread descrambling. The worker pool is optional in the same
            // way it is for every other store: a CSP that refuses blob workers
            // makes dmmWorkerAllowed() false, and every page then uses the
            // main-thread path below. The pool does not own the network, so a
            // worker failure can fall back per page without re-fetching.
            try {
                if (typeof makePool === 'function' && await dmmWorkerAllowed()) {
                    const size = typeof workerPoolSize === 'function'
                        ? Math.max(2, Math.min(8, workerPoolSize())) : 8;
                    dmmPool = makePool(size, dmmWorkerSource(), dmmPoolDone,
                        60000, 2, dmmWorkerMessage);
                    dmmLog('worker pool', size + ' descramblers');
                }
            } catch (e) {
                dmmPool = null;
                dmmLog('worker pool unavailable', safeLogText((e && e.message) || e));
            }
            const retriesWanted = runOptions.retries === undefined || runOptions.retries === null
                ? 2 : Number(runOptions.retries);
            const attempts = Math.max(1, Math.min(DMM_MAX_ATTEMPTS,
                1 + (Number.isFinite(retriesWanted) ? Math.max(0, retriesWanted) : 2)));
            let next = 0;
            let downloaded = 0;
            let cachedCount = 0;

            // A 403 means the very short CloudFront signature (or the sampler's
            // auth_info) rolled over. One refresh is shared by every worker; a
            // page that saw the 403 retries against the replacement session.
            let refreshing = null;
            const refresh = function () {
                if (!refreshing) {
                    refreshing = dmmAuth(viewer).then(function (replacement) {
                        session = replacement;
                        dmmState.probe = { session: replacement, pages: pages, at: Date.now() };
                        dmmLog('auth refreshed after a 403');
                        return replacement;
                    }).finally(function () {
                        refreshing = null;
                    });
                }
                return refreshing;
            };

            const failPage = function (index, error) {
                harness.noteFailure(index + 1, 'page ' + (index + 1) + ': '
                    + safeLogText((error && error.message) || error || 'failed'));
            };

            // fetchOne only downloads. Decoding happens in a worker pool when
            // the page allows one, with a main-thread fallback for CSP-restricted
            // pages or a worker failure.
            const fetchOne = async function (index) {
                const page = pages[index];
                let refreshed = false;
                // Counted apart from the loop so the signature refresh is not a
                // retry: it replaces the session the request was refused against,
                // so a page that hit a 403 keeps its whole retry budget (the
                // protocol record promises exactly that). Charging it to the
                // budget is what dropped the last page of a run whose 429
                // retries ran out just as the signature rolled over.
                let failures = 0;
                for (;;) {
                    try {
                        const bytes = await dmmFetchPage(session, page);
                        harness.bumpFetched(1);
                        downloaded++;
                        return bytes;
                    } catch (e) {
                        if (e && e.status === 403 && !refreshed) {
                            refreshed = true;
                            await refresh();
                            continue;
                        }
                        failures++;
                        const retryable = !e || dmmRetryable(e);
                        if (retryable && failures < attempts) {
                            await dmmSleep(Math.min(8000, 400 * failures * failures));
                            continue;
                        }
                        // A page whose retries are spent still finished its
                        // fetch attempt, so the download bar advances with the
                        // rest of the volume instead of stalling at total-1.
                        harness.bumpFetched(1);
                        throw e;
                    }
                }
            };

            // The fallback path is the expensive main-thread stage; limit it
            // without limiting the network. A worker that has downloaded a page
            // waits here for a slot, so every lane can stay busy while only a
            // few canvases exist at once.
            const decodeLimit = (function (limit) {
                let active = 0;
                const waiters = [];
                return {
                    run: async function (fn) {
                        if (active >= limit) {
                            await new Promise(function (resolve) { waiters.push(resolve); });
                        } else {
                            active++;
                        }
                        try {
                            return await fn();
                        } finally {
                            const next = waiters.shift();
                            if (next) next();
                            else active--;
                        }
                    },
                };
            })(fanout.decodeWidth);

            const decodeOne = async function (index, bytes, page) {
                if (dmmPool) {
                    const pool = dmmPool;
                    const job = dmmWorkerJob(++dmmPoolSeq, bytes, page);
                    if (job) {
                        try {
                            const out = await dmmPoolPage(job, pool);
                            dmmPoolFailures = 0;
                            return {
                                blob: out.blob,
                                ext: imageExtForMime(out.blob.type) || IMAGE_CODEC.ext,
                            };
                        } catch (e) {
                            dmmPoolFailures++;
                            dmmLog('worker page failed', safeLogText((e && e.message) || e));
                            if (dmmPoolFailures >= 2) {
                                dmmLog('worker pool disabled; using the main thread');
                                dmmStopPool('DMM worker pool disabled');
                            }
                        }
                    }
                }
                return await decodeLimit.run(function () {
                    return dmmPageBlob(bytes, page);
                });
            };

            const worker = async function () {
                for (;;) {
                    const index = next++;
                    if (index >= total) return;
                    if (runOptions.usePageCache) {
                        const cached = await getCachedPage(cid, index + 1);
                        if (cached) {
                            harness.bumpCached(1);
                            harness.noteCached(index + 1, cached, cachedPageCrc.get(cached));
                            cachedCount++;
                            continue;
                        }
                    }
                    try {
                        const bytes = await fetchOne(index);
                        const out = await decodeOne(index, bytes, pages[index]);
                        harness.notePage(index + 1, out.blob, undefined, out.ext);
                    } catch (e) {
                        failPage(index, e);
                    }
                }
            };

            await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));

            // One bounded retry wave over the pages that failed. A 429 storm
            // across a wide fan-out is the usual cause: the in-page retry
            // budget is spent while the CDN is refusing everything, so a page
            // gets its whole budget again after the storm has passed. It is
            // deliberately narrow and runs after the wide fan-out, and a
            // headless caller has to ask for it explicitly, because a
            // systematic refusal would otherwise be repeated unattended.
            const retryFailures = runOptions.retryFailedPages === true || !runOptions.headless;
            if (harness.failedIdx.size && retryFailures) {
                const retry = Array.from(harness.failedIdx)
                    .filter(function (page) { return page >= 1 && page <= total; })
                    .sort(function (a, b) { return a - b; });
                let cursor = 0;
                const retryWorker = async function () {
                    for (;;) {
                        const at = cursor++;
                        if (at >= retry.length) return;
                        const index = retry[at] - 1;
                        try {
                            const bytes = await fetchOne(index);
                            const out = await decodeOne(index, bytes, pages[index]);
                            harness.notePage(index + 1, out.blob, undefined, out.ext);
                        } catch (e) { /* stays failed; reported below */ }
                    }
                };
                const retryWidth = Math.max(1, Math.min(24, retry.length));
                await Promise.all(Array.from({ length: retryWidth }, retryWorker));
            }

            const missing = total - harness.okIdx.size;
            dmmLog('pages', downloaded + ' fetched, ' + harness.okIdx.size + '/' + total + ' ready');

            // The OCR branch owns the Mokuro session the run opened, so it runs
            // before the all-failed return; otherwise a failed OCR run would
            // leave the session un-finalized. A pure ZIP run falls through to
            // the all-failed answer.
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
            dmmState.running = false;
            dmmStopPool('run finished');
            if (harness) await harness.cleanup();
        }
    }

    registerSite({
        id: 'dmm',
        label: 'DMMブックス',
        panelTitle: 'DMMブックス Native Downloader',
        ownsHost() {
            return dmmOwnsHost();
        },
        matches() {
            // Only the viewer carries the cid, and only the viewer can be
            // authorized for a free volume or sampler. A product page is a
            // storefront page, left to the store-owns-host guard.
            try { return dmmOwnsHost() && !!dmmParseViewerUrl(location.href); } catch (e) { return false; }
        },
        refresh() {
            dmmRefreshState();
            return dmmState.ready;
        },
        getBook() {
            return dmmBook();
        },
        getPreview() {
            // Wait for the background probe: a card with 0 pages would make the
            // panel's poll stop before the real count landed.
            if (!dmmState.ready || !dmmState.total) return null;
            const title = dmmState.title || cleanTitle(dmmState.rawTitle);
            if (!title) return null;
            return {
                title: title,
                pages: dmmState.total || 0,
                resolution: dmmState.resolution || '',
                type: dmmState.sample ? 'DMMブックス 試し読み' : 'DMMブックス 無料',
            };
        },
        getCid() {
            return dmmState.contentId
                ? dmmState.contentId + (dmmState.sample ? 'sample' : '')
                : '';
        },
        archiveDefault(rawTitle) {
            return archiveDefaultName(rawTitle) || fsSafePath(dmmState.contentId || '');
        },
        run(ui, mode, options) {
            return dmmRun(ui, mode, options);
        },
        state: dmmState,
        debug: {
            dmmState: dmmState,
        },
        debugGlobals: {
            __bwddDmm: dmmState,
            __bwddDmmProtocol: {
                parseViewerUrl: dmmParseViewerUrl,
                parseConfiguration: dmmParseConfiguration,
                pattern: dmmPattern,
                tileRects: dmmTileRects,
                parseAuth: dmmAuth,
                fetchManifest: dmmFetchManifest,
                pageBlob: dmmPageBlob,
                page: dmmFetchPage,
            },
        },
    });
