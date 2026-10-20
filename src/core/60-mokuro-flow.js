    async function uploadCoverEarly(opts) {
        const { ui, barUpload, feed, mokuroSessionId, safeTitle, blob } = opts;
        if (!mokuroSessionId || !blob) return null;
        const plan = await resolveUploadChoice(ui).catch(() => ({ method: null, label: null, localDir: null }));
        const coverName = (safeTitle || 'volume') + '.webp';
        try {
            barUpload.labName.textContent = '4. ' + (plan.method === 'local' ? 'Store' : 'Upload');
            barUpload.wrap.style.display = 'flex';
            // Seed the 1-file plan up front so the bar reads "1/1 · 0%" from
            // the very first moment (no bare "0%" without a file count).
            if (feed.seed) feed.seed([{ file: coverName, total_bytes: blob.size }]);
            feed({ file: coverName, currentBytes: 0, totalBytes: blob.size, percent: 0 });
            const res = await mokuroUploadCover(mokuroSessionId, blob, { method: plan.method || null, localDir: plan.localDir });
            feed({ file: res && res.file ? res.file : coverName, currentBytes: res && res.size ? res.size : blob.size, totalBytes: res && res.size ? res.size : blob.size, percent: 100 });
            return res;
        } catch (e) {
            // A failed early cover must never break the download/OCR run.
            if (BWDD_DEBUG) console.warn('[bwdd] Early cover upload skipped:', safeLogText(e && e.message || e));
            return null;
        }
    }

    // Finalize phase shared by the trial and full OCR pipelines (kept in one
    // place so the two paths can never drift apart again): ask the bridge to
    // finalize the session (store locally or upload), stream live byte/percent
    // progress into the Store/Upload bar via the NDJSON frames, and keep the
    // Mokuro bar polled until the stream closes. Returns { result, plan }.
    async function finalizeOcrSession(mokuroSessionId, ui, barUpload, barMokuro, total, sharedFeed, options = {}) {
        const plan = await resolveUploadChoice(ui).catch(() => ({ method: null, label: null, localDir: null }));
        // The 4th stage only uploads when the destination is remote, so name the
        // bar honestly. If the early cover upload already started this feed, keep
        // the visible progress and just seed the rest.
        barUpload.labName.textContent = '4. ' + (plan.method === 'local' ? 'Store' : 'Upload');
        const uploadFeed = sharedFeed || makeUploadBarUpdater(barUpload);
        if (!sharedFeed || !sharedFeed.hasAny || !sharedFeed.hasAny()) {
            barUpload.wrap.style.display = 'none';
            setBar(barUpload, 0, '0%');
        }
        const result = await new Promise((resolve, reject) => {
            const fp = mokuroFinalize(mokuroSessionId, {
                method: plan.method || null,
                localDir: plan.localDir,
                // An automation caller may ask the bridge to replace a file a
                // previous run left at the destination; the panel never does, so
                // a normal run keeps the bridge's safe "fail" policy.
                overwrite: options.overwrite || null,
            }, (stage, msg) => {
                if (stage === 'upload_progress' || stage === 'upload') barUpload.wrap.style.display = 'flex';
                // The initial "upload" frame announces every file + size, so
                // pre-size the bar before the first byte arrives.
                if (stage === 'upload' && msg && Array.isArray(msg.files) && uploadFeed.seed) {
                    uploadFeed.seed(msg.files);
                }
                if (stage === 'done' && uploadFeed.summary) {
                    const s = uploadFeed.summary();
                    if (barUpload.wrap.style.display === 'flex' && s.total > 0) {
                        setBar(barUpload, 100, s.done + '/' + s.total + ' · 100% · ' + fmtBytes(s.sumTot) + ' / ' + fmtBytes(s.sumTot));
                    } else if (barUpload.wrap.style.display === 'flex') {
                        setBar(barUpload, 100, '100%');
                    }
                }
                if (options.automation) reportRunProgress(options, 'finalize', { stage: stage || null });
            }, uploadFeed);
            // Poll the bridge's OCR status ~2.5/s so the Mokuro bar keeps moving
            // while the finalize stream is open; the bridge also publishes live
            // upload progress to the same /status endpoint, which keeps the bar
            // moving even with older bridges that buffer their NDJSON frames.
            // Headless callers can opt out. The tick is scheduled in a worker
            // (setBackgroundInterval) because a plain interval is clamped to one
            // tick per second - and to one per minute once the tab has been
            // hidden for five minutes - which is exactly when a long finalize is
            // most likely to be left running in the background.
            let poll = null;
            if (options.pollBridgeStatus !== false) {
                poll = setBackgroundInterval(async () => {
                    try {
                        const st = await mokuroStatus(mokuroSessionId);
                        if (!st) return;
                        updateMokuroBar(barMokuro, st.pages_ocr_done ?? 0, st.pages_received ?? 0, total);
                        const up = st.upload;
                        if (up && (up.active === true || (up.current_bytes || 0) > 0 || (up.percent || 0) > 0)) {
                            barUpload.wrap.style.display = 'flex';
                            uploadFeed({
                                file: up.file || '',
                                currentBytes: up.current_bytes || 0,
                                totalBytes: up.total_bytes || 0,
                                percent: up.percent,
                                speed: up.speed_human || null,
                            });
                        }
                    } catch (e) {}
                }, 400);
            }
            if (poll && options.registerRunCleanup) {
                options.registerRunCleanup(() => { if (poll) { clearBackgroundInterval(poll); poll = null; } });
            }
            fp.then(r => { if (poll) { clearBackgroundInterval(poll); poll = null; } resolve(r); },
                   e => { if (poll) { clearBackgroundInterval(poll); poll = null; } reject(e); });
        });
        return { result, plan };
    }

