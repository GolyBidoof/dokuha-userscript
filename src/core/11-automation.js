    const automationMemory = {
        status: {
            state: 'idle', status: 'idle', ok: false, mode: null, cid: '', title: '',
            total: 0, pageCount: 0, sessionId: null, safeTitle: null,
            deferredFinalize: false, errors: []
        },
        events: [], listeners: new Set(), running: null, lastEvent: null
    };
    function automationSnapshot() {
        const s = automationMemory.status;
        return {
            state: s.state, status: s.status || s.state || 'idle', ok: !!s.ok, mode: s.mode || null,
            cid: s.cid || '', title: s.title || '', total: s.total || 0,
            pageCount: s.pageCount || 0, sessionId: s.sessionId || null,
            bridgeSessionId: s.sessionId || null,
            safeTitle: s.safeTitle || null, deferredFinalize: !!s.deferredFinalize,
            errors: Array.isArray(s.errors) ? s.errors.slice() : []
        };
    }
    function automationEvent(event, runtime) {
        const ev = Object.assign({ at: Date.now() }, event || {});
        automationMemory.events.push(ev);
        if (automationMemory.events.length > 200) automationMemory.events.shift();
        automationMemory.lastEvent = ev;
        for (const fn of automationMemory.listeners) {
            try { fn(Object.assign({}, ev, { errors: Array.isArray(ev.errors) ? ev.errors.slice() : undefined })); } catch (e) {}
        }
        if (runtime && typeof runtime.onEvent === 'function') {
            try { runtime.onEvent(Object.assign({}, ev)); } catch (e) {}
        }
    }
    function reportRunProgress(options, type, fields) {
        if (!options) return;
        const patch = fields || {};
        const event = Object.assign({
            type: type || 'progress', mode: options.mode || null
        }, patch);
        if (options.automation) {
            const s = automationMemory.status;
            const keys = ['ok', 'status', 'mode', 'cid', 'title', 'total', 'pageCount', 'sessionId', 'safeTitle', 'deferredFinalize', 'errors'];
            for (const key of keys) if (Object.prototype.hasOwnProperty.call(patch, key)) s[key] = patch[key];
            s.state = type === 'complete' ? 'complete' : (type === 'failed' ? 'failed' : 'running');
            s.status = type === 'complete' ? (s.deferredFinalize ? 'ocr_pending' : 'completed')
                : (type === 'failed' ? 'failed' : 'running');
            automationEvent(Object.assign({}, automationSnapshot(), event), options.automationRuntime);
        }
        if (typeof options.onProgress === 'function') {
            try {
                options.onProgress(Object.assign({}, event, {
                    errors: Array.isArray(event.errors) ? event.errors.slice() : undefined
                }));
            } catch (e) { /* a consumer callback must never break a download */ }
        }
        try {
            if (typeof window.__bwddProgress === 'function') {
                window.__bwddProgress(Object.assign({}, event, {
                    errors: Array.isArray(event.errors) ? event.errors.slice() : undefined
                }));
            }
        } catch (e) {  }
    }
    function newAutomationResult(mode, cid, deferredFinalize) {
        return {
            ok: false, mode: mode, cid: cid || '', title: '', total: 0,
            pageCount: 0, errors: [], deferredFinalize: !!deferredFinalize
        };
    }
    function headlessBar() {
        return {
            style: {}, wrap: { style: {} },
            fill: { style: {}, setAttribute() {} },
            labName: { textContent: '' }, labRate: { textContent: '' }
        };
    }
    function makeHeadlessUI() {
        const details = {
            textContent: '',
            append() {}, appendChild() {}, removeChild() {}
        };
        return {
            details: details, statsEl: null,
            barWrap: headlessBar(), barDownload: headlessBar(),
            barDescramble: headlessBar(), barMokuro: headlessBar(),
            barUpload: headlessBar(), destSelect: null, localDirInput: null,
            setRunLock() {}, hideReaderButton() {}, hideStoredButton() {},
            showReaderButton() {}, showStoredButton() {},
            syncArchiveDefault(raw) {
                if (ACTIVE_SITE && typeof ACTIVE_SITE.archiveDefault === 'function') {
                    return ACTIVE_SITE.archiveDefault(raw) || 'book';
                }
                return archiveDefaultName(raw) || fsSafePath(siteCid()) || 'book';
            }
        };
    }
    function normalizeRunOptions(options, mode) {
        const o = options && typeof options === 'object' ? Object.assign({}, options) : {};
        const headless = o.headless === true || o.automation === true || isHeadlessPage();
        const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
        const deferredFinalize = mode === 'ocr' && (
            o.deferFinalize === true || o.deferredFinalize === true || o.finalize === false || o.finalizeLater === true
        );
        return Object.assign({}, o, {
            mode: mode,
            automation: headless || o.automation === true,
            headless: headless,
            deferFinalize: deferredFinalize,
            deferredFinalize: deferredFinalize,
            skipBridgeIdleWait: o.skipBridgeIdleWait === true || o.skipBridgeIdle === true || o.skipIdleWait === true,
            skipCover: headless || o.skipCover === true,
            pollBridgeStatus: o.pollBridgeStatus === true || (!headless && o.pollBridgeStatus !== false),
            usePageCache: !headless && o.usePageCache !== false,
            onProgress: onProgress,
            result: o.result || null,
            automationRuntime: o.automationRuntime || null
        });
    }
    function installHeadlessAutomation() {
        if (!isHeadlessPage()) return;
        const api = {
            version: BWDD_VERSION,
            get status() { return automationSnapshot(); },
            get lastStatus() { return automationMemory.lastEvent ? Object.assign({}, automationMemory.lastEvent) : null; },
            get events() { return automationMemory.events.slice(); },
            getState() { return automationSnapshot(); },
            progress() { return automationSnapshot(); },
            getProgress() { return automationSnapshot(); },
            activateCapture() {
                try {
                    if (ACTIVE_SITE && typeof ACTIVE_SITE.install === 'function') ACTIVE_SITE.install();
                    return true;
                } catch (_) {
                    return false;
                }
            },
            subscribe(fn) {
                if (typeof fn !== 'function') throw new TypeError('Automation event listener must be a function');
                automationMemory.listeners.add(fn);
                return () => automationMemory.listeners.delete(fn);
            },
            onEvent(fn) { return api.subscribe(fn); },
            async start(options) {
                if (automationMemory.running) {
                    throw new Error('A BookWalker downloader automation run is already in progress');
                }
                const requestedMode = options && options.mode ? String(options.mode).toLowerCase() : 'ocr';
                if (requestedMode !== 'ocr' && requestedMode !== 'zip') {
                    throw new Error('Automation mode must be "ocr" or "zip"');
                }
                if (ACTIVE_SITE && typeof ACTIVE_SITE.install === 'function') {
                    try { ACTIVE_SITE.install(); } catch (_) {}
                }
                const runOptions = normalizeRunOptions(options, requestedMode);
                const result = runOptions.result || newAutomationResult(requestedMode, siteCid(), runOptions.deferFinalize);
                runOptions.result = result;
                runOptions.automation = true;
                runOptions.headless = true;
                runOptions.automationRuntime = { onEvent: options && options.onEvent };
                automationMemory.running = runOptions.automationRuntime;
                Object.assign(automationMemory.status, automationSnapshot(), result, {
                    state: 'starting', status: 'running', ok: false, errors: result.errors
                });
                automationEvent(Object.assign({}, automationSnapshot(), { type: 'starting' }), runOptions.automationRuntime);
                try {
                    const finished = await siteRun(makeHeadlessUI(), requestedMode, runOptions);
                    const value = finished && finished.ok !== undefined ? finished : result;
                    value.bridgeSessionId = value.sessionId || value.bridgeSessionId || null;
                    value.pageCount = Number(value.pageCount || 0);
                    value.total = Number(value.total || 0);
                    value.ok = value.ok === true && value.errors.length === 0;
                    value.status = value.deferFinalize || value.deferredFinalize
                        ? (value.ok ? 'ocr_pending' : 'failed')
                        : (value.ok ? 'completed' : 'failed');
                    reportRunProgress(runOptions, value.ok ? 'complete' : 'failed', value);
                    automationMemory.running = null;
                    return value;
                } catch (e) {
                    const error = e instanceof Error ? e : new Error(String(e && e.message || e || 'Automation failed'));
                    reportRunProgress(runOptions, 'failed', {
                        ok: false, errors: result.errors.concat([error.message])
                    });
                    automationMemory.running = null;
                    throw error;
                }
            }
        };
        window.__bwddAutomation = api;
    }

