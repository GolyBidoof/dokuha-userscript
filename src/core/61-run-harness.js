    // Driven by the CMOA and ebookjapan pipelines; BookWalker's full and trial
    // pipelines never call it and keep their own plumbing. It owns everything the
    // user can see and everything the Mokuro bridge is told - same bars, same
    // progress reporting, same session/finalize conversation, same ZIP assembly
    // and naming - so the stores cannot drift apart.
    //
    // What stays site-specific is only *how* pages are fetched: BookWalker's
    // lane/worker/descramble engine and CMOA's token/quality/quality-blacklist
    // retry loop have nothing in common, and forcing them through one generic
    // fetch loop would mean rewriting the tuned path that already works.
    //
    // Usage:
    //   const H = createRunHarness(ui, mode, options, { title, archiveName, cid });
    //   await H.mokuro.open();          // OCR runs only
    //   H.showBars();
    //   ...per page: H.notePage(idx, blob, crc) / H.noteFailure(idx, message)
    //   await H.finishZip();  |  await H.finishOcr();
    //   return H.outcome(missing === 0);
    //   ...always: await H.cleanup()
    function createRunHarness(ui, mode, options, meta) {
        options = options || {};
        meta = meta || {};
        const { details, barWrap, barDownload, barDescramble, barMokuro, barUpload } = ui;
        const runResult = options.result || null;
        const errors = options.errors || (runResult ? runResult.errors : []);
        const okIdx = new Set();
        const failedIdx = new Set();
        const zip = mode === 'zip' ? { entries: [] } : null;
        const startedAt = performance.now();

        let total = Math.max(0, Number(meta.total) || 0);
        let fetched = 0;
        let finishedOk = false;
        let cleanedUp = false;

        // Cleanup registry. run() used to own this list; the harness owns it now
        // so a site pipeline cannot forget to unwind a poll or a worker pool.
        const cleanups = [];
        const registerCleanup = fn => { if (typeof fn === 'function') cleanups.push(fn); };
        options.registerRunCleanup = registerCleanup;

        // Hold the panel for the whole run; cleanup() releases it, and both
        // callers (cmoa/02-run.js, ebookjapan/05-run.js) run cleanup() in a
        // finally, so the lock cannot outlive a failed run either. Without this
        // only BookWalker locked, and the other two stores could start a second
        // run over the same book while the first was still fetching.
        if (typeof ui.setRunLock === 'function') ui.setRunLock(true);

        // One upload-bar feed shared by the early cover upload and finalize, so
        // the bar tracks the whole multi-file upload (cover = file 1/N).
        const uploadFeed = makeUploadBarUpdater(barUpload);
        const coverState = { fired: false };

        const setTotal = n => { total = Math.max(0, Number(n) || 0); return total; };
        const seconds = () => ((performance.now() - startedAt) / 1000).toFixed(1);

        function showBars() {
            barWrap.style.display = 'flex';
            barDownload.wrap.style.display = 'flex';
            barDescramble.wrap.style.display = 'flex';
            setBar(barDownload, 0, '0%');
            setBar(barDescramble, 0, '0%');
        }

        // Download bar = pages fetched from the CDN; Descramble bar = pages
        // actually processed (zipped / handed to OCR). They diverge naturally.
        function refreshProgress() {
            const done = okIdx.size;
            const dl = Math.min(fetched, total);
            setBar(barDownload, total ? (dl / total) * 100 : 0, dl + '/' + total);
            setBar(barDescramble, total ? (done / total) * 100 : 0, done + '/' + total);
            // The Mokuro bar is owned by the bridge status poll (updateMokuroBar,
            // done/received/total). Never write it from here or the two writers
            // fight and the label flickers.
        }

        const bumpFetched = n => { fetched += (Number(n) || 0); refreshProgress(); };
        const bumpCached = n => { fetched += (Number(n) || 0); refreshProgress(); };

        function reportPage(idx) {
            reportRunProgress(options, 'page', {
                page: idx, pageCount: okIdx.size, total: total, error: null
            });
        }

        function reportPageError(idx, message) {
            reportRunProgress(options, 'page', {
                page: idx, pageCount: okIdx.size, total: total, error: message || 'error'
            });
        }

        function noteFailure(idx, message) {
            const msg = safeLogText(message || 'failed');
            errors.push(msg);
            failedIdx.add(idx);
            okIdx.delete(idx);
            reportPageError(idx, msg);
            refreshProgress();
        }

        // Pages are streamed to the bridge in strict page order (buffered until
        // the gaps fill) rather than in completion order: BookWalker's lane engine
        // settles pages out of order and CMOA's retry loop skips forward, so
        // completion order is not a reliable sequence. A failed page is skipped,
        // which keeps the volume contiguous.
        const mokuro = (mode !== 'ocr') ? null : (() => {
            let sessionId = null;
            let safeTitle = '';
            let poll = null;
            let nextIdx = 1;
            let sent = 0;
            const buffer = new Map();
            let chain = Promise.resolve();

            async function sendOrdered() {
                while (true) {
                    if (failedIdx.has(nextIdx)) { nextIdx++; continue; }
                    if (!buffer.has(nextIdx)) break;
                    const blob = buffer.get(nextIdx);
                    buffer.delete(nextIdx);
                    const page = nextIdx;
                    const fn = 'page-' + String(page).padStart(4, '0') + '.' + IMAGE_CODEC.ext;
                    try {
                        await mokuroStreamPage(sessionId, blob, fn, page);
                        sent++;
                        reportRunProgress(options, 'page-stream', {
                            page: page, pageCount: okIdx.size, total: total
                        });
                    } catch (e) {
                        errors.push('OCR send page ' + page + ': ' + safeLogText((e && e.message) || e));
                    }
                    nextIdx++;
                }
            }

            function schedule() {
                // Keep the concurrent GUI behaviour, but serialize the headless
                // stream so the returned promise cannot race a POST that is
                // still in flight after the last page is decoded.
                if (!options.headless) { sendOrdered(); return; }
                chain = chain.then(sendOrdered, sendOrdered).catch(e => {
                    errors.push('OCR stream: ' + safeLogText((e && e.message) || e));
                });
            }

            function startPoll() {
                if (!sessionId || poll) return;
                // setBackgroundInterval, not setInterval: a hidden tab clamps
                // main-thread timers to one tick per second and, after five
                // minutes, to about one per minute, which starves this bar while
                // the bridge itself keeps working at full speed.
                poll = setBackgroundInterval(async () => {
                    const st = await mokuroStatus(sessionId);
                    if (!st) return;
                    const done = st.pages_ocr_done ?? 0;
                    const got = st.pages_received ?? 0;
                    updateMokuroBar(barMokuro, done, got, total);
                    reportRunProgress(options, 'bridge-status', {
                        pageCount: got, ocrPageCount: done, total: total
                    });
                }, 700);
                registerCleanup(() => { if (poll) { clearBackgroundInterval(poll); poll = null; } });
            }

            return {
                get sessionId() { return sessionId; },
                get safeTitle() { return safeTitle; },
                get sent() { return sent; },

                // Opening the session is deliberately identical for both stores:
                // same bridge health gate, same idle gate, same session title.
                async open() {
                    barWrap.style.display = 'flex';
                    barMokuro.wrap.style.display = 'flex';
                    setBar(barMokuro, 0, '0/' + total);
                    if (!(await ensureBridgeRunning(25000))) {
                        throw new Error(MOKURO_BRIDGE_OFFLINE_MSG);
                    }
                    // Never start a capture while the bridge is still working on a
                    // previous run, unless an automation caller owns the bridge
                    // lifecycle and asks us to skip this wait.
                    if (!options.skipBridgeIdleWait && !(await waitForBridgeIdle(60000))) {
                        throw new Error('The Mokuro Bridge is still busy with a previous OCR/upload — wait for it to finish, then try again.');
                    }
                    const sess = await mokuroStartSession(meta.archiveName || meta.title || 'book');
                    sessionId = sess && sess.session_id;
                    if (options.automation && !sessionId) {
                        throw new Error('Mokuro bridge did not return a session_id');
                    }
                    safeTitle = sess && (sess.safe_title || sess.title) || '';
                    if (runResult) {
                        runResult.sessionId = sessionId;
                        runResult.safeTitle = safeTitle;
                    }
                    reportRunProgress(options, 'session', {
                        sessionId: sessionId || null, safeTitle: safeTitle, total: total
                    });
                    if (options.pollBridgeStatus !== false) startPoll();
                    return sessionId;
                },

                note(idx, blob) {
                    buffer.set(idx, blob);
                    if (idx === nextIdx) schedule();
                },

                // Cover = first page: push it to the destination immediately
                // (before OCR finishes) so the folder and upload bar show life right
                // away. Headless/deferred runs stream pages only, with no cover
                // side effect.
                cover(idx, blob) {
                    if (options.skipCover || idx !== 1 || coverState.fired || !sessionId) return;
                    coverState.fired = true;
                    uploadCoverEarly({
                        ui, barUpload, feed: uploadFeed,
                        mokuroSessionId: sessionId, safeTitle: safeTitle, blob,
                    }).catch(() => {});
                },

                async settle() {
                    if (options.headless) await chain;
                    for (let i = 1; i <= total; i++) {
                        if (failedIdx.has(i)) continue;
                        const blob = buffer.get(i);
                        if (!blob) continue;
                        buffer.delete(i);
                        const fn = 'page-' + String(i).padStart(4, '0') + '.' + IMAGE_CODEC.ext;
                        try {
                            await mokuroStreamPage(sessionId, blob, fn, i);
                            sent++;
                            reportRunProgress(options, 'page-stream', {
                                page: i, pageCount: okIdx.size, total: total
                            });
                        } catch (e) {
                            errors.push('Final OCR send page ' + i + ': ' + safeLogText((e && e.message) || e));
                        }
                    }
                    // Deliberately NOT stopped here. Streaming every page is the
                    // end of the download, not of the OCR: the bridge is still
                    // working through its queue and then uploading, and the
                    // /status poll is the only thing that can report that. The
                    // run's own cleanup stops it when the volume is truly done.
                },

                async finalize() {
                    barMokuro.wrap.style.display = 'flex';
                    const { result, plan } = await finalizeOcrSession(
                        sessionId, ui, barUpload, barMokuro, total, uploadFeed, options);
                    // A partial_upload terminal frame means the volume files are
                    // there but the series index is not. Record it as an issue so
                    // outcome() reports the run as not clean.
                    const partial = !!(result && result.partialUpload);
                    if (partial) errors.push(msgPartialUpload(result));
                    const missing = total - okIdx.size;
                    if (missing > 0) {
                        if (!options.headless) setRunDetails(details, msgOcrPartial(missing, total), errors);
                        return { result, plan, missing, ok: false };
                    }
                    if (!options.headless) {
                        if (partial) {
                            setRunDetails(details, msgPartialUpload(result), errors);
                        } else {
                            if (plan && plan.method === 'local') {
                                const localPath = storedPathOf(result) || plan.localDir;
                                if (localPath) details.textContent = msgStoredLocal(localPath);
                            } else if (plan && plan.method) {
                                const rp = result && (result.remote_path || result.mega_path);
                                if (rp) details.textContent = msgUploadedTo(methodShortLabel(plan.method), rp);
                            }
                            if (errors.length) appendRunDetails(details, errors, 'Issues during the run');
                        }
                    }
                    // Reported even on the headless path: a headless caller
                    // supplies its own UI whose only job is to capture this
                    // result, so it can link the stored file after the run.
                    ui.showReaderButton(result);
                    ui.showStoredButton(result);
                    return { result, plan, missing, ok: !partial };
                },

                // Deferred mode is deliberately page-stream-only: the external
                // CLI owns /finalize (and any upload/delete policy) later.
                deferred() {
                    if (runResult) {
                        runResult.pageCount = okIdx.size;
                        runResult.total = total;
                        runResult.errors = errors;
                        runResult.deferredFinalize = true;
                        runResult.ok = (total - okIdx.size) === 0 && errors.length === 0 && sent === okIdx.size;
                    }
                    reportRunProgress(options, 'deferred-finalize', {
                        pageCount: okIdx.size, total: total, deferredFinalize: true,
                        streamed: sent, ok: runResult ? runResult.ok : false
                    });
                    return runResult;
                },
            };
        })();

        // A successfully fetched+processed page: counted for both bars, added to
        // the archive, cached for a resume, and handed to OCR. Sites call this
        // exactly once per page that produced usable output. `ext` overrides the
        // archive extension for a page whose bytes could not be re-encoded to the
        // selected codec (CMOA passes the real one when it kept raw bytes).
        function notePage(idx, blob, crc, ext) {
            okIdx.add(idx);
            failedIdx.delete(idx);
            if (zip && blob) zip.entries.push({
                path: 'page-' + String(idx).padStart(4, '0') + '.' + (ext || IMAGE_CODEC.ext),
                blob,
                crc: Number.isInteger(crc) ? crc : undefined,
            });
            if (options.usePageCache && meta.cid && blob) {
                try { cachePage(meta.cid, idx, blob, crc); } catch (e) {}
            }
            if (mokuro && blob) {
                mokuro.cover(idx, blob);
                mokuro.note(idx, blob);
            }
            reportPage(idx);
            refreshProgress();
        }

        // A page served from the page cache: already correct, no fetch, no
        // descramble, no re-upload of the source, so it counts as both.
        function noteCached(idx, blob, crc) {
            okIdx.add(idx);
            failedIdx.delete(idx);
            if (zip && blob) zip.entries.push({
                path: 'page-' + String(idx).padStart(4, '0') + '.' + IMAGE_CODEC.ext,
                blob,
                crc: Number.isInteger(crc) ? crc : undefined,
            });
            if (mokuro && blob) mokuro.note(idx, blob);
            refreshProgress();
        }

        async function finishZip() {
            if (!zip || okIdx.size === 0) {
                setRunDetails(details, msgAllFailedZip(), errors);
                return outcome(false);
            }
            const secs = seconds();
            barDownload.wrap.style.display = 'flex';
            barDescramble.wrap.style.display = 'flex';
            barMokuro.wrap.style.display = 'none';
            barDownload.fill.style.width = '0%';
            barDownload.labRate.textContent = 'Storing';
            barDescramble.fill.style.width = '100%';
            barDescramble.labRate.textContent = '100%';

            const entries = zip.entries.slice();
            const zipBlob = await buildStoreZip(entries, done => {
                const pct = Math.round((done / Math.max(1, entries.length)) * 100);
                barDownload.fill.style.width = pct + '%';
                barDownload.labRate.textContent = pct + '%';
            });

            const url = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = (meta.archiveName || zipBaseName(meta.sv, meta.title)) + '.zip';
            const anchorHost = document.body || document.documentElement;
            if (anchorHost) anchorHost.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);

            const missing = total - okIdx.size;
            if (missing > 0) {
                setRunDetails(details, msgZipPartial(okIdx.size, total), errors);
            } else {
                details.textContent = msgZipSaved(entries.length, fmtBytes(zipBlob.size), secs);
                if (errors.length) appendRunDetails(details, errors, 'Issues during the run');
            }
            // Matches the long-standing rule: an error-free run clears the page
            // cache, any run that logged an error keeps it so the next attempt
            // resumes instead of re-fetching the whole volume.
            finishedOk = errors.length === 0;
            return outcome(missing === 0);
        }

        // Normalize the result object for automated callers. Sites pass whether
        // the run was good; the page accounting is filled in here so every store
        // reports identically.
        function outcome(ok) {
            if (!runResult) return ok;
            runResult.total = total;
            runResult.pageCount = okIdx.size;
            runResult.errors = errors;
            runResult.deferredFinalize = false;
            runResult.ok = !!ok && errors.length === 0;
            return runResult;
        }

        async function cleanup() {
            if (cleanedUp) return;
            cleanedUp = true;
            for (let i = cleanups.length - 1; i >= 0; i--) {
                try { cleanups[i](); } catch (e) {}
            }
            cleanups.length = 0;
            if (finishedOk && options.usePageCache) { try { await clearPageCache(); } catch (e) {} }
            // Guarded to match the acquire above: a reduced ui (the headless
            // mirror) must degrade to "no lock", not throw during teardown.
            if (typeof ui.setRunLock === 'function') ui.setRunLock(false);
        }

        function reportFailure(e) {
            const message = (e && e.message) ? safeLogText(e.message)
                : 'something went wrong — see the browser console for details.';
            if (runResult) {
                runResult.ok = false;
                if (message && !runResult.errors.includes(message)) runResult.errors.push(message);
                reportRunProgress(options, 'failed', { ok: false, errors: runResult.errors });
                const error = e instanceof Error ? e : new Error(String(message));
                error.bwddResult = runResult;
                return error;
            }
            details.textContent = 'Error: ' + message;
            return null;
        }

        return {
            mode, options, errors, okIdx, failedIdx, zip, mokuro,
            get total() { return total; },
            get fetched() { return fetched; },
            get runResult() { return runResult; },
            get finishedOk() { return finishedOk; },
            setTotal, showBars, refreshProgress, bumpFetched, bumpCached,
            notePage, noteCached, noteFailure,
            registerCleanup, finishZip, outcome, cleanup, reportFailure, seconds,
            markFinished() { finishedOk = true; },
            details,
        };
    }
