    const MOKURO_BRIDGE_URL = (() => {
        const defaultUrl = 'http://127.0.0.1:62642';
        try {
            const marker = window.__BWDD_CLI__;
            const configured = marker && marker.bridgeUrl;
            if (configured) {
                const parsed = new URL(String(configured));
                if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                    return parsed.toString().replace(/\/+$/, '');
                }
            }
        } catch (_) { /* malformed marker: retain the local default */ }
        return defaultUrl;
    })();
    const MOKURO_BRIDGE_START_URL = 'bw-mokuro-bridge://start';
    const MOKURO_BRIDGE_OFFLINE_MSG =
        'The Mokuro Bridge app is not running.\n\n' +
        'Get and start mokuro-bridge (github.com/GolyBidoof/mokuro-bridge) — its ' +
        'README shows the start command for your OS (macOS/Linux: ./run.sh from ' +
        'its folder), then click “Save and run through Mokuro” again.';

    // Hysteresis so a single dropped /health probe (or a slow response during
    // a heavy upload) can't flip the UI to "offline" and hide the bars. The
    // dot/message only go grey after BRIDGE_FAIL_LIMIT consecutive failures.
    const BRIDGE_FAIL_LIMIT = 3;
    let bridgeConsecFail = 0;
    // Strictly "did the last probe actually answer". bridgeHealth() below is
    // deliberately sticky so the OCR button does not flap on one missed poll,
    // but the pre-flight socket readout must not promise ports that are not
    // reachable this instant, so it reads this instead.
    let bridgeReachableNow = false;
    // Misses are only forgiven once the bridge has actually answered at least
    // once. Without this a cold page load with no bridge advertises "online" for
    // the first BRIDGE_FAIL_LIMIT polls, contradicting the socket readout.
    let bridgeEverReachable = false;
    // One CSP-proof GET against the local bridge, shaped like a fetch Response
    // so every caller keeps its `r.ok` / `r.status` / `r.json()` / `r.text()`
    // code unchanged. ebookjapan serves `connect-src 'self' https: wss:` (no
    // plain http:/ws:), so a page fetch to http://127.0.0.1:62642 is refused
    // there while the same request is fine on BookWalker/CMOA. GM_xmlhttpRequest
    // is issued by the userscript manager and is exempt from the page CSP, so it
    // is tried first whenever the manager grants it, with the page fetch as the
    // fallback. GM hands back the whole body at once, so this helper covers the
    // read-only GET endpoints; mokuroBridgePost does the multipart writes.
    async function mokuroBridgeGet(url, timeoutMs = 5000) {
        if (typeof GM_xmlhttpRequest === 'function') {
            const gm = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET', url, timeout: timeoutMs,
                    headers: { 'Cache-Control': 'no-cache' },
                    onload: (r) => resolve(r),
                    onerror: (e) => reject(new Error('GM_xhr: ' + (e && e.error))),
                    ontimeout: () => reject(new Error('GM_xhr: Timeout')),
                });
            });
            const status = Number(gm && gm.status) || 0;
            const body = gm && gm.responseText != null ? String(gm.responseText) : '';
            return {
                ok: status >= 200 && status < 300,
                status,
                json: async () => JSON.parse(body),
                text: async () => body,
            };
        }
        return await fetchWithTimeout(url, { cache: 'no-store' }, timeoutMs);
    }
    // POST twin of mokuroBridgeGet for the multipart write endpoints
    // (session/start, session/<id>/page, session/<id>/cover, finalize): same
    // contract, GM_xmlhttpRequest first for the same CSP reason, fetchWithTimeout
    // otherwise. The FormData goes over as `data` with no Content-Type set by
    // hand, so Tampermonkey encodes the multipart body and boundary itself.
    async function mokuroBridgePost(url, timeoutMs, formData) {
        if (typeof GM_xmlhttpRequest === 'function') {
            const gm = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST', url, data: formData, timeout: timeoutMs,
                    onload: (r) => resolve(r),
                    onerror: (e) => reject(new Error('GM_xhr: ' + (e && e.error))),
                    ontimeout: () => reject(new Error('GM_xhr: Timeout')),
                });
            });
            const status = Number(gm && gm.status) || 0;
            const body = gm && gm.responseText != null ? String(gm.responseText) : '';
            return {
                ok: status >= 200 && status < 300,
                status,
                json: async () => JSON.parse(body),
                text: async () => body,
            };
        }
        return await fetchWithTimeout(url, { method: 'POST', body: formData }, timeoutMs);
    }
    // A rejected write answers with a JSON {"detail": ...} (or, on a validation
    // error, {"detail": [{msg}]}) before any NDJSON stream exists. Reading it is
    // what turns "closed stream without completing" into the bridge's own reason:
    // an unknown upload account, a session already finalizing, a page conflict.
    function bridgeHttpError(status, detail, action) {
        const text = typeof detail === 'string' ? detail.trim() : '';
        const err = new Error('Mokuro bridge ' + action + ' failed (HTTP ' + status + ')' +
            (text ? ': ' + text : ''));
        err.status = status;
        err.detail = text;
        return err;
    }
    async function bridgeErrorDetail(res) {
        const text = await res.text().catch(() => '');
        try {
            const detail = (JSON.parse(text) || {}).detail;
            if (typeof detail === 'string') return detail;
            if (Array.isArray(detail)) {
                return detail.map(d => (d && (d.msg || d.message)) || '').filter(Boolean).join('; ');
            }
        } catch (e) { /* not JSON: fall through to the raw body */ }
        return String(text || '').trim().slice(0, 300);
    }
    async function bridgeError(res, action) {
        return bridgeHttpError(res.status, await bridgeErrorDetail(res), action);
    }
    async function bridgeHealth() {
        try {
            const r = await mokuroBridgeGet(MOKURO_BRIDGE_URL + '/health', 2000);
            const ok = r.ok;
            bridgeReachableNow = ok;
            if (ok) bridgeEverReachable = true;
            bridgeConsecFail = ok ? 0 : bridgeConsecFail + 1;
            return ok || (bridgeEverReachable && bridgeConsecFail < BRIDGE_FAIL_LIMIT);
        } catch (e) {
            bridgeReachableNow = false;
            bridgeConsecFail++;
            return bridgeEverReachable && bridgeConsecFail < BRIDGE_FAIL_LIMIT;
        }
    }
    let bridgeInfo = null;
    async function refreshBridgeInfo() {
        try {
            const r = await mokuroBridgeGet(MOKURO_BRIDGE_URL + '/health', 3000);
            if (r.ok) { bridgeInfo = await r.json(); return bridgeInfo; }
        } catch (e) {}
        return null;
    }
    // The bridge exposes GET /upload-methods listing every method plus the
    // default; we pick the first configured one (or 'local') and remember its
    // folder. Falls back to /health mega_configured on older bridges.
    let uploadMethods = null;
    async function fetchUploadMethods() {
        try {
            const r = await mokuroBridgeGet(MOKURO_BRIDGE_URL + '/upload-methods', 3000);
            if (r.ok) { uploadMethods = await r.json(); return uploadMethods; }
        } catch (e) {}
        return null;
    }
    // Resolve which upload method + destination folder to use:
    // { method, folder, label }. The bridge's sticky default is reported only
    // when it is actually usable: "local" is always configured, so picking the
    // first *configured* method would always say "saving locally", while an
    // unconfigured default (e.g. drive not set up) must not be advertised as
    // the destination.
    async function mokuroUploadPlan() {
        const methods = uploadMethods || await fetchUploadMethods();
        if (methods && Array.isArray(methods.methods)) {
            const list = methods.methods;
            const def = methods.upload_method_default || 'local';
            const byDefault = list.find(m => m.id === def);
            const usableDefault = byDefault && byDefault.configured ? byDefault : null;
            const firstConfigured = list.find(m => m.configured);
            const picked =
                usableDefault ||
                firstConfigured ||
                list.find(m => m.id === 'local') ||
                list[0];
            if (picked) return { method: picked.id, folder: picked.current_folder || null, label: picked.name || picked.id };
        }
        // older bridge: only /health
        const info = bridgeInfo || await refreshBridgeInfo();
        if (info && info.mega_configured) return { method: 'mega', folder: info.mega_library_root || null, label: 'MEGA' };
        return { method: 'local', folder: info && info.output_dir || null, label: 'Local' };
    }
    async function resolveUploadChoice(ui) {
        const plan = await mokuroUploadPlan().catch(() => ({ method: null, folder: null, label: null }));
        let method = plan.method, folder = plan.folder;
        if (ui && ui.destSelect && ui.destSelect.value) {
            method = ui.destSelect.value;
            folder = null;
            if (method === 'local' && ui.localDirInput && ui.localDirInput.value.trim()) folder = ui.localDirInput.value.trim();
        }
        return { method, folder, label: plan.label || method, localDir: method === 'local' ? folder : null };
    }

    async function ensureBridgeRunning(timeoutMs = 15000) {
        if (await bridgeHealth()) return true;
        // The extension adapter owns bridge discovery and startup. Never click
        // the custom protocol from an automation page: that creates a browser
        // permission prompt and turns a local bridge outage into a surprising
        // UI side effect. The caller receives the same clear offline error.
        let bridgeManaged = false;
        try { bridgeManaged = !!(window.__BWDD_CLI__ && window.__BWDD_CLI__.bridgeManaged); } catch (e) {}
        if (!bridgeManaged) {
            try {
                const a = document.createElement('a');
                a.href = MOKURO_BRIDGE_START_URL;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                a.remove();
            } catch (e) {}
        }
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            await backgroundDelay(600);
            if (await bridgeHealth()) return true;
        }
        return false;
    }
    // Wait for the bridge to report idle (busy=false, which also covers
    // ocr_queue_depth > 0) before starting a capture, so a new run cannot
    // interleave with OCR/upload work already in flight.
    async function waitForBridgeIdle(timeoutMs = 30000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            try {
                const r = await mokuroBridgeGet(MOKURO_BRIDGE_URL + '/health', 3000);
                if (r.ok) {
                    const h = await r.json();
                    if (!h.busy) return true;
                }
            } catch (e) {}
            await backgroundDelay(1000);
        }
        return false;
    }

    function bridgeSessionPath(sessionId, suffix) {
        const id = String(sessionId || '');
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid bridge session id');
        return MOKURO_BRIDGE_URL + '/session/' + encodeURIComponent(id) + suffix;
    }
    async function mokuroStartSession(title) {
        const fd = new FormData();
        fd.append('title', title || 'manga');
        const res = await mokuroBridgePost(MOKURO_BRIDGE_URL + '/session/start', 15000, fd);
        if (!res.ok) throw await bridgeError(res, 'session start');
        return await res.json().catch(() => ({}));
    }
    // Outcomes of one page push:
    //   200 + already_present:true
    //        the bridge already held these exact bytes (idempotent retry).
    //   409 "already has completed OCR" / "already queued or present"
    //        the page is already in the volume, from bytes that were captured
    //        before a restart. The bridge docs call this a cache hit, not a
    //        failure: the volume stays complete either way. Reported as
    //        { cached: true } so the run does not count a spurious error.
    //   409 "currently being OCR'd" / "being ingested"
    //        transient: another request still owns the page. Retried with
    //        backoff, and surfaced only if it never clears.
    //   any other 4xx/5xx
    //        a real conflict (e.g. a filename stem collision) or a bridge
    //        problem, thrown with the bridge's own detail.
    const PAGE_PUSH_RETRIES = 4;
    async function mokuroStreamPage(sessionId, blob, filename, pageNum) {
        const fd = new FormData();
        fd.append('page', blob, filename);
        fd.append('filename', filename);
        fd.append('page_num', String(pageNum));
        const url = bridgeSessionPath(sessionId, '/page');
        for (let attempt = 0; ; attempt++) {
            const res = await mokuroBridgePost(url, 60000, fd);
            if (res.ok) {
                const d = await res.json().catch(() => ({}));
                if (d && d.already_present) d.cached = true;
                return d;
            }
            const detail = await bridgeErrorDetail(res);
            if (res.status === 409 && /already has completed OCR|already queued or present/i.test(detail)) {
                return { ok: true, cached: true, already_present: true, detail: detail };
            }
            if (res.status === 409 && /currently being (OCR'd|ingested)/i.test(detail) &&
                attempt < PAGE_PUSH_RETRIES) {
                await backgroundDelay(250 * (attempt + 1));
                continue;
            }
            throw bridgeHttpError(res.status, detail, 'page ' + pageNum + ' upload');
        }
    }
    // Early cover upload: push the first page to the destination as
    // <title>.webp immediately, before OCR finishes, so the user sees upload
    // activity at once. {method, localDir} must match the run's destination.
    async function mokuroUploadCover(sessionId, blob, opts = {}) {
        const fd = new FormData();
        fd.append('cover', blob, 'cover.jpg');
        if (opts.method) fd.append('upload_method', opts.method);
        if (opts.method === 'local' && opts.localDir) fd.append('local_dir', opts.localDir);
        const res = await mokuroBridgePost(bridgeSessionPath(sessionId, '/cover'), 120000, fd);
        if (!res.ok) throw await bridgeError(res, 'cover upload');
        return await res.json().catch(() => ({}));
    }
    async function mokuroStatus(sessionId) {
        try {
            const res = await mokuroBridgeGet(bridgeSessionPath(sessionId, '/status'), 5000);
            if (!res.ok) return null;
            return await res.json();
        } catch (e) { return null; }
    }
    // Frames of the bridge's finalize NDJSON, shared so the live streaming
    // reader and the buffered GM fallback emit exactly the same callbacks for
    // exactly the same frames.
    function makeNdjsonSink(onStage, onUpload) {
        // Collect per-file storage URLs the bridge reports (upload_file's third
        // value, and/or done.uploads[]). Deduped, exposed as
        //   uploadUrls: [{file, url}]   storedUrl: first http(s).
        const uploadUrls = [];
        let storedUrl = null;
        let finalResult = null;
        function rememberUrl(msg) {
            const seen = new Set();
            const add = (file, url) => {
                const u = typeof url === 'string' ? url.trim() : '';
                if (!u) return;
                const f = typeof file === 'string' ? file : '';
                const key = f + '\u0000' + u;
                if (seen.has(key)) return;
                seen.add(key);
                if (uploadUrls.some(e => e.file === f && e.url === u)) return;
                uploadUrls.push({ file: f, url: u });
                // Prefer the .cbz (the volume archive itself) for the "Open
                // stored file" action; the cover .webp uploads first, so
                // without this preference the button would point at an image.
                if (/^https?:\/\//i.test(u)) {
                    if (!storedUrl || /\.cbz$/i.test(f)) storedUrl = u;
                }
            };
            if (typeof msg.url === 'string' && msg.url) add(msg.file, msg.url);
            const up = msg.upload || {};
            if (typeof up.url === 'string' && up.url) add(up.file || msg.file, up.url);
            if (Array.isArray(msg.uploads)) {
                for (const u of msg.uploads) add(u && u.file, u && u.url);
            }
        }
        function processLine(line) {
            if (!line.trim()) return;
            let msg; try { msg = JSON.parse(line); } catch (e) { return; }
            if (onStage) onStage(msg.stage, msg);
            rememberUrl(msg);
            if ((msg.stage === 'upload_progress' || msg.stage === 'upload') && onUpload) {
                const up = msg.upload || {};
                const hasPayload = !!(up.file || msg.file || up.bytes || msg.bytes != null ||
                    up.current_bytes != null || msg.current_bytes != null ||
                    up.total_bytes != null || msg.total_bytes != null);
                if (hasPayload) {
                    onUpload({
                        file: up.file || msg.file || '',
                        percent: msg.percent != null ? msg.percent : (up.percent != null ? up.percent : null),
                        speed: msg.speed_human || up.speed_human || null,
                        currentBytes: msg.current_bytes != null ? msg.current_bytes :
                            (up.current_bytes != null ? up.current_bytes :
                                (up.bytes != null ? up.bytes : (msg.bytes != null ? msg.bytes : 0))),
                        totalBytes: msg.total_bytes != null ? msg.total_bytes :
                            (up.total_bytes != null ? up.total_bytes : 0),
                        method: msg.method || up.method || null,
                        remotePath: msg.remote_path || msg.mega_path || up.remote_path || up.mega_path || null,
                    });
                }
            }
            if (msg.stage === 'done') finalResult = msg;
            if (msg.stage === 'error') {
                // The bridge's error frames carry a machine-readable status
                // (ocr_failed, ocr_cache_invalid, finalize_error, ...). Keep it on
                // the Error so callers can tell an OCR failure from a transport one.
                const err = new Error(msg.message || 'Mokuro bridge pipeline error');
                err.status = msg.status || 'bridge_error';
                throw err;
            }
        }
        return {
            processLine,
            finish() {
                // A stream that ends without `done` is a truncated upload, never a
                // success: the volume may be half-transferred.
                if (!finalResult) throw new Error('Mokuro bridge ended the finalize stream without a terminal done frame.');
                // A done frame with status=partial_upload means the volume files
                // arrived but the series index did not. The result is kept (the
                // files are usable), flagged so the caller can surface it instead
                // of reporting a clean success.
                if (finalResult.status === 'partial_upload') finalResult.partialUpload = true;
                if (uploadUrls.length) finalResult.uploadUrls = uploadUrls;
                if (storedUrl) finalResult.storedUrl = storedUrl;
                return finalResult;
            },
        };
    }
    //   onUpload(ev), live upload progress {file, percent, speed, currentBytes,
    //     totalBytes, method, remotePath}. The bridge streams one file at a time
    //     with that file's own bytes, so the caller must accumulate across
    //     files: use makeUploadBarUpdater() below.
    async function readNdjsonStream(res, onStage, onUpload) {
        if (!res.body) throw new Error('No streaming response body from bridge');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const sink = makeNdjsonSink(onStage, onUpload);
        let buffer = '';
        // Force-flush a partially-buffered line if nothing arrives for a while:
        // a slow upload's trailing NDJSON line (no newline yet) would otherwise
        // sit in `buffer`, making the bar look stuck. Scheduled in a worker so
        // the flush keeps its cadence in a background tab, where a main-thread
        // timer is clamped to 1/s and then to ~1/min.
        let lastLineAt = Date.now();
        const flushTimer = setBackgroundInterval(() => {
            if (!buffer.trim() || Date.now() - lastLineAt < 4000) return;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) { sink.processLine(line); }
            lastLineAt = Date.now();
        }, 2000);
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                lastLineAt = Date.now();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) { sink.processLine(line); }
            }
            // The tail goes through the same sink as every split line, so a
            // trailing frame without its newline still reaches onUpload.
            if (buffer.trim()) { sink.processLine(buffer); }
            return sink.finish();
        } finally {
            // An error frame or a reader failure must not leave the flush
            // interval (or the stream reader) alive in a Puppeteer page.
            clearBackgroundInterval(flushTimer);
            try { if (reader.cancel) await reader.cancel(); } catch (e) {}
        }
    }
    // Buffered twin of readNdjsonStream for the GM path, where the whole
    // responseText arrives at once: every line goes through the same sink, so
    // onStage/onUpload see the same frames, just in one burst.
    function readNdjsonText(text, onStage, onUpload) {
        const sink = makeNdjsonSink(onStage, onUpload);
        const lines = String(text == null ? '' : text).split('\n');
        for (const line of lines) { sink.processLine(line); }
        return sink.finish();
    }
    // Multi-file upload progress for the Store/Upload bar. Tracks a list of
    // files in upload order (seeded up front from the bridge's "upload" frame
    // `files:` list, then fed live per-file progress). The label reads
    //   "1/3 · 62% · 65.0 MB / 104.8 MB · 5.1 MiB/s"
    // i.e. file k of N · overall % · bytes · speed, no file name clutter. The
    // fill is the byte-weighted overall %, monotonic because every file's total
    // is known before it uploads; the k/N and size totals are kept after
    // completion rather than blanking the bar.
    function makeUploadBarUpdater(bar) {
        const order = [];
        const byName = new Map();
        const rec = (name) => {
            let r = byName.get(name);
            if (!r) { r = { cur: 0, tot: 0 }; byName.set(name, r); order.push(name); }
            return r;
        };
        let seeded = false;            // full plan announced by the bridge
        let done = 0;                  // files fully uploaded (tot>0 && cur>=tot)
        const feed = function onUploadFrame(ev) {
            if (!bar) return;
            bar.wrap.style.display = 'flex';
            const name = ev.file || '';
            if (name) {
                const r = rec(name);
                if (ev.totalBytes > 0) r.tot = Math.max(r.tot, ev.totalBytes);
                if (ev.currentBytes > 0) r.cur = Math.max(r.cur, ev.currentBytes);
            }
            let sumCur = 0, sumTot = 0;
            done = 0;
            for (const n of order) {
                const r = byName.get(n);
                sumCur += r.cur; sumTot += r.tot;
                if (r.tot > 0 && r.cur >= r.tot) done++;
            }
            let overall;
            if (sumTot > 0) overall = Math.min(100, (sumCur / sumTot) * 100);
            else if (ev.percent != null) overall = ev.percent;
            else overall = 0;
            let parts = [];
            if (seeded && order.length > 0) {
                // Always show k/N against the full plan: k = files fully done,
                // never a premature "1/3" just because one file was announced.
                parts.push(Math.min(done, order.length) + '/' + order.length);
            }
            parts.push(overall.toFixed(0) + '%');
            if (sumTot > 0) parts.push(fmtBytes(sumCur) + ' / ' + fmtBytes(sumTot));
            else if (ev.percent != null && ev.totalBytes > 0) parts.push(fmtBytes(ev.currentBytes || 0) + ' / ' + fmtBytes(ev.totalBytes));
            if (ev.speed && overall < 100) parts.push(ev.speed);
            setBar(bar, overall, parts.join(' · '));
        };
        // Pre-register the whole upload plan from the initial "upload" frame
        // ({file, total_bytes}[]): a full denominator up front keeps the overall
        // % honest and makes k/N always count against N.
        feed.seed = function seed(list) {
            if (!Array.isArray(list)) return;
            for (const it of list) {
                if (it && typeof it.file === 'string' && it.file) {
                    const r = rec(it.file);
                    if (it.total_bytes > 0) r.tot = Math.max(r.tot, it.total_bytes);
                }
            }
            if (list.length) seeded = true;
        };
        // True once any file has been registered (used to avoid clobbering
        // early-cover progress when the finalize phase reuses this feed).
        feed.hasAny = function hasAny() { return order.length > 0; };
        feed.summary = function summary() {
            let sumCur = 0, sumTot = 0, d = 0;
            for (const n of order) {
                const r = byName.get(n);
                sumCur += r.cur; sumTot += r.tot;
                if (r.tot > 0 && r.cur >= r.tot) d++;
            }
            return { done: d, total: order.length, sumCur, sumTot };
        };
        return feed;
    }
    //   opts.method     upload_method id (an account alias: local, mega-work,
    //                   drive-other-email, ...); null lets the bridge use its
    //                   sticky default.
    //   opts.localDir   local_dir, only when the resolved method is local.
    //   opts.overwrite  fail (bridge default) | skip | overwrite. Sent only when
    //                   the caller asks for a policy; a first run keeps the
    //                   bridge's safe "fail" so an existing destination file is
    //                   reported, not silently replaced.
    //   opts.forceMega  legacy: send upload_to_mega=true instead of upload_method
    //                   (only when no method is known, i.e. very old bridges).
    // Protocol: github.com/GolyBidoof/mokuro-bridge.
    async function mokuroFinalize(sessionId, opts = {}, onStage, onUpload) {
        const method = opts.method || null;
        const fd = new FormData();
        if (method) {
            fd.append('upload_method', method);
            if (method === 'local' && opts.localDir) fd.append('local_dir', opts.localDir);
        } else if (opts.forceMega) {
            fd.append('upload_to_mega', 'true');
        }
        fd.append('delete_after_upload', 'true');
        // Only the three policies bridge 0.9 documents are accepted, so a typo
        // falls back to the safe default instead of reaching the provider layer.
        const overwrite = typeof opts.overwrite === 'string' ? opts.overwrite.trim() : '';
        if (/^(fail|skip|overwrite)$/.test(overwrite)) fd.append('overwrite', overwrite);
        const url = bridgeSessionPath(sessionId, '/finalize');
        const res = await mokuroBridgePost(url, 3600000, fd);
        // Rejections (unknown upload account, session already finalizing) come
        // back as JSON before the stream starts. Never retry them blindly: the
        // old upload_to_mega fallback turned an unknown account into an upload to
        // MEGA, which is the wrong destination, and re-sent a 409.
        if (!res.ok) throw await bridgeError(res, 'finalize');
        // The page fetch has a real ReadableStream body, so BookWalker/CMOA keep
        // the live streaming reader; the GM response has none, so its whole NDJSON
        // body is parsed in one pass through the same sink.
        if (res.body && typeof res.body.getReader === 'function') {
            return readNdjsonStream(res, onStage, onUpload);
        }
        return readNdjsonText(await res.text(), onStage, onUpload);
    }
    function readerJumpUrl(result) {
        const u = result && result.reader_url;
        if (typeof u === 'string' && /^https?:\/\//i.test(u.trim())) return u.trim();
        return 'https://reader.mokuro.app/';
    }

