// ==UserScript==
// @name         CMOA Native Downloader
// @namespace    http://tampermonkey.net/
// @version      3.0.1
// @description  Saves a book from the CMOA speed reader as a ZIP or CBZ of full-resolution page images, fetched from the CDN and unscrambled offline. Optional Japanese OCR through mokuro-bridge, with upload to MEGA, Google Drive or OneDrive.
// @author       GolyBidoof
// @homepageURL  https://github.com/GolyBidoof/dokuha-userscript
// @supportURL   https://github.com/GolyBidoof/dokuha-userscript/issues
// @updateURL    https://github.com/GolyBidoof/dokuha-userscript/releases/latest/download/cmoa-only.user.js
// @downloadURL  https://github.com/GolyBidoof/dokuha-userscript/releases/latest/download/cmoa-only.user.js
// @match        https://www.cmoa.jp/bib/speedreader/*
// @match        https://www.cmoa.jp/reader/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=cmoa.jp
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      learnnatively.com
// @connect      manga-kotoba.com
// @connect      www.cmoa.jp
// @connect      free-binb-cmoa.akamaized.net
// @connect      binb-cmoa.akamaized.net
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-end
// @license      MIT
//
// CMOA only, built from the same shared core as the BookWalker script. It
// matches nothing outside the CMOA readers and does not carry a single line of
// BookWalker code. Install this OR the combined script, never both: they match
// the same hosts and you would get two panels.
//
// CREDITS
//   - BookWalker viewer protocol reverse-engineered and validated against
//     live HAR captures + the bookworm offline client (github.com/aaa4xu/bookworm).
//   - CMOA speed-reader protocol ported from the original standalone CMOA
//     userscript; the page descriptors and the tile-shuffle geometry come from
//     the store's own SpeedBinb viewer.
//   - Reading stats from LearnNatively (learnnatively.com, by Brandon) and
//     manga-kotoba (manga-kotoba.com, by ChristopherFritz); they own that
//     data and its styling.
//   - OCR via mokuro: a performant fork of kha-white/mokuro
//     (github.com/GolyBidoof/mokuro), run through the companion
//     mokuro-bridge app (github.com/GolyBidoof/mokuro-bridge);
//     upload backend is the bridge's own.
//   - Built with DeepSeek V4 Flash (deepseek.com), the coding model that
//     reverse-engineered and ported the crypto/descramble logic with the author.
//
// NOTE ON PERMISSIONS:
//   On first install Tampermonkey asks for cross-origin access to
//   learnnatively.com, manga-kotoba.com and whichever storefronts this build
//   queries. Those permissions power the reading-stat cards and, in the
//   combined build, the "also available on" store links, which ask each shop's
//   own search page whether it carries the series. If you decline them, the
//   script still works fully for downloading/Mokuro; the LearnNatively card
//   falls back to a public CORS proxy (or hides), and the store links cannot be
//   resolved, so they are simply not shown.
// ==/UserScript==
// Comment-stripped build. Annotated source, tests and explanations: https://github.com/GolyBidoof/dokuha-userscript

(function () {
    'use strict';

    const BWDD_VERSION = (() => {
        try {
            const v = (typeof GM_info !== 'undefined') && GM_info.script && GM_info.script.version;
            if (v) return v;
        } catch (e) { }
        return '3.0.1';
    })();

    const BWDD_DEBUG = (() => {
        try { return new URLSearchParams(location.search).has('bwddDebug'); } catch (e) { return false; }
    })();
    const BWDD_AUTHOR = 'GolyBidoof';
    const BWDD_SCRIPT_NAME = 'dokuha-userscript';
    const BWDD_REPO_URL = 'https://github.com/GolyBidoof/dokuha-userscript';

    function debugRealm() {
        try {
            return (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
        } catch (e) { return window; }
    }

    function isHeadlessPage() {
        try {
            return window.__BWDD_HEADLESS__ === true || !!window.__BWDD_CLI__;
        } catch (e) { return false; }
    }

    function safeLogText(value) {
        let text = String(value == null ? '' : value);
        text = text.replace(/https?:\/\/[^\s"'<>]+/gi, match => {
            try {
                const url = new URL(match);
                if (url.username || url.password) return '[redacted-url]';
                url.search = '';
                url.hash = '';
                return url.toString();
            } catch (_) {
                return '[redacted-url]';
            }
        });
        text = text.replace(
            /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|password|passwd|client-secret|client_secret)\s*([:=])\s*[^\r\n,}]*/gi,
            '$1$2[redacted]'
        );
        return text.replace(
            /\b(auth[_-]?info|policy|signature|key[-_]?pair[-_]?id|token|csrf|xsrf|api[_-]?key|apikey|password|passwd|secret|private[_-]?key|client[_-]?secret)\s*([:=])\s*("[^"]*"|[^\s,;}]+)/gi,
            '$1$2[redacted]'
        );
    }

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
            } catch (e) { }
        }
        try {
            if (typeof window.__bwddProgress === 'function') {
                window.__bwddProgress(Object.assign({}, event, {
                    errors: Array.isArray(event.errors) ? event.errors.slice() : undefined
                }));
            }
        } catch (e) { }
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

    const JPEG_QUALITY = 0.92;

    function resolveImageCodec() {
        let fmt = 'jpeg', quality = JPEG_QUALITY;
        try {
            const f = String((window.__bwddImageFormat != null
                ? window.__bwddImageFormat
                : (!isHeadlessPage() ? localStorage.getItem('bwddImageFormat') : '')) || '').toLowerCase();
            if (f === 'jpeg' || f === 'jpg' || f === 'webp' || f === 'png' || f === 'lossless') {
                fmt = (f === 'jpg') ? 'jpeg' : f;
            }
            const raw = window.__bwddImageQuality != null
                ? window.__bwddImageQuality
                : (!isHeadlessPage() ? localStorage.getItem('bwddImageQuality') : null);
            const qv = parseFloat(raw);
            if (isFinite(qv) && qv > 0 && qv <= 1) quality = qv;
        } catch (e) { }

        if (fmt === 'lossless') return { fmt, type: 'image/webp', quality: 1, ext: 'webp', lossless: true };
        if (fmt === 'webp') return { fmt, type: 'image/webp', quality, ext: 'webp', lossless: false };
        if (fmt === 'png') return { fmt, type: 'image/png', quality, ext: 'png', lossless: true };
        return { fmt: 'jpeg', type: 'image/jpeg', quality, ext: 'jpg', lossless: false };
    }

    function imageExtForMime(type) {
        const t = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
        if (t === 'image/png') return 'png';
        if (t === 'image/webp') return 'webp';
        if (t === 'image/jpeg' || t === 'image/jpg') return 'jpg';
        return '';
    }

    let IMAGE_CODEC = resolveImageCodec();
    function refreshImageCodec() {
        IMAGE_CODEC = resolveImageCodec();
        return IMAGE_CODEC;
    }

let pageDB = null;
    let pageDBPromise = null;
    function openPageDB() {

        if (pageDB) return Promise.resolve(pageDB);
        if (pageDBPromise) return pageDBPromise;
        pageDBPromise = new Promise((resolve, reject) => {
            let req;
            try { req = indexedDB.open('bwdd-pages-v2', 1); } catch (e) { reject(e); return; }
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages');
            };
            req.onsuccess = () => { pageDB = req.result; resolve(pageDB); };
            req.onerror = () => reject(req.error);

            req.onblocked = () => reject(new Error('page cache open blocked'));
        });
        pageDBPromise.catch(() => { pageDBPromise = null; });
        return pageDBPromise;
    }

    function withDeadline(p, ms) {
        return new Promise((resolve) => {
            let done = false;
            const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
            p.then(
                (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
                () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } },
            );
        });
    }

    const PAGE_CACHE_READ_TIMEOUT_MS = 1000;

    const PAGE_CACHE_TTL_MS = 20 * 60 * 1000;
    const PAGE_CACHE_MAX_ENTRIES = 4000;
    const PAGE_CACHE_PRUNE_INTERVAL_MS = 30 * 1000;
    const cachedPageCrc = new WeakMap();
    let pageCachePruneTimer = null;
    let pageCachePruneInFlight = null;
    let pageCachePruneRequested = false;

    let lastPageCachePruneAt = Date.now();
    function schedulePageCachePrune(delayMs) {

        if (isHeadlessPage()) return;

        if (pageCachePruneInFlight) {

            pageCachePruneRequested = true;
            return;
        }
        if (pageCachePruneTimer !== null) return;
        const earliest = lastPageCachePruneAt + PAGE_CACHE_PRUNE_INTERVAL_MS;
        const delay = Math.max(delayMs || 0, earliest - Date.now());
        pageCachePruneTimer = setTimeout(() => {
            pageCachePruneTimer = null;
            lastPageCachePruneAt = Date.now();
            pageCachePruneInFlight = prunePageCache();
            const done = () => {
                pageCachePruneInFlight = null;
                if (pageCachePruneRequested) {
                    pageCachePruneRequested = false;
                    schedulePageCachePrune();
                }
            };
            pageCachePruneInFlight.then(done, done);
        }, delay);
    }
    function pageCacheKey(cid, index) {
        const type = (typeof IMAGE_CODEC !== 'undefined' && IMAGE_CODEC.type) || 'image/jpeg';
        const quality = (typeof IMAGE_CODEC !== 'undefined' && IMAGE_CODEC.quality) || '';
        return cid + ':' + index + ':' + type + ':' + quality;
    }
    async function cachePage(cid, index, blob, crc) {
        try {
            const db = await openPageDB();
            const key = pageCacheKey(cid, index);
            const record = { blob, ts: Date.now() };
            if (Number.isInteger(crc)) record.crc = crc;
            await new Promise((res, rej) => {
                const tx = db.transaction('pages', 'readwrite');
                tx.objectStore('pages').put(record, key);
                tx.oncomplete = () => res(true);
                tx.onerror = () => rej(tx.error);
                tx.onabort = () => rej(tx.error || new Error('page cache put aborted'));
            });
            schedulePageCachePrune();
            return true;
        } catch (e) { return false; }
    }
    function readCachedRecord(db, key) {
        return new Promise((res) => {
            let settled = false;
            const finish = (v) => { if (!settled) { settled = true; res(v); } };
            let tx;
            try { tx = db.transaction('pages', 'readonly'); }
            catch (e) { finish(null); return; }

            tx.onabort = () => finish(null);
            tx.onerror = () => finish(null);
            try {
                const rq = tx.objectStore('pages').get(key);
                rq.onsuccess = () => finish(rq.result || null);
                rq.onerror = () => finish(null);
            } catch (e) { finish(null); }
        });
    }
    async function getCachedPage(cid, index) {
        try {
            const db = await withDeadline(openPageDB(), PAGE_CACHE_READ_TIMEOUT_MS);
            if (!db) return null;
            const v = await withDeadline(readCachedRecord(db, pageCacheKey(cid, index)), PAGE_CACHE_READ_TIMEOUT_MS);
            if (v && v.blob) {
                if (Number.isInteger(v.crc)) cachedPageCrc.set(v.blob, v.crc);
                return v.blob;
            }
            return null;
        } catch (e) { return null; }
    }
    async function prunePageCache() {
        try {
            const db = await openPageDB();
            const now = Date.now();
            await new Promise((res) => {
                const tx = db.transaction('pages', 'readwrite');
                const st = tx.objectStore('pages');
                const req = st.openCursor();
                req.onsuccess = () => {
                    const cur = req.result;
                    if (!cur) { res(true); return; }
                    const val = cur.value;
                    if (val && val.ts && (now - val.ts) > PAGE_CACHE_TTL_MS) {
                        cur.delete();
                    }
                    cur.continue();
                };
                tx.oncomplete = () => res(true);
                req.onerror = () => res(true);
            });
            await new Promise((res) => {
                const tx = db.transaction('pages', 'readwrite');
                const st = tx.objectStore('pages');
                const countReq = st.count();
                countReq.onsuccess = () => {
                    const n = countReq.result;
                    if (n <= PAGE_CACHE_MAX_ENTRIES) { res(true); return; }
                    const delReq = st.openCursor();
                    let toDelete = n - PAGE_CACHE_MAX_ENTRIES;
                    delReq.onsuccess = () => {
                        const cur = delReq.result;
                        if (!cur || toDelete <= 0) { res(true); return; }
                        cur.delete(); toDelete--;
                        cur.continue();
                    };
                    delReq.onerror = () => res(true);
                };
                countReq.onerror = () => res(true);
            });
        } catch (e) {}
    }
    async function clearPageCache() {
        try {
            if (pageCachePruneTimer !== null) {
                clearTimeout(pageCachePruneTimer);
                pageCachePruneTimer = null;
            }
            if (pageCachePruneInFlight) {
                try { await pageCachePruneInFlight; } catch (e) {}
                pageCachePruneInFlight = null;
            }
            if (pageCachePruneTimer !== null) {
                clearTimeout(pageCachePruneTimer);
                pageCachePruneTimer = null;
            }
            pageCachePruneRequested = false;
            const db = await openPageDB();
            await new Promise((res, rej) => {
                const tx = db.transaction('pages', 'readwrite');
                tx.objectStore('pages').clear();
                tx.oncomplete = () => res(true);
                tx.onerror = () => rej(tx.error);
            });
            if (BWDD_DEBUG) console.log('[bwdd] Page cache cleared');
            return true;
        } catch (e) { return false; }
    }

    const TICKER_HELLO_MS = 1500;
    const tickerSource = [
        'const timers = new Map();',
        'onmessage = function (e) {',
        '    const d = e.data || {};',
        '    if (d.op === "start") {',
        '        const previous = timers.get(d.id);',
        '        if (previous !== undefined) clearInterval(previous);',
        '        timers.set(d.id, setInterval(function () { postMessage(d.id); }, d.ms));',
        '    } else if (d.op === "stop") {',
        '        const t = timers.get(d.id);',
        '        if (t !== undefined) clearInterval(t);',
        '        timers.delete(d.id);',
        '    }',
        '};',
        'postMessage("ready");',
    ].join('\n');

    const tickers = new Map();
    let tickerRelay = null;
    let tickerRelayReady = false;
    let tickerHelloTimer = null;
    let tickerSeq = 0;

    function tickerRun(rec) {
        if (rec.stopped) return;
        try { rec.fn(); } catch (e) {}
    }

    function tickerFallback(rec) {
        if (rec.stopped || rec.fallbackId !== null) return;
        rec.fallbackId = setInterval(() => tickerRun(rec), rec.ms);
    }
    function tickerRelayFailed() {
        if (tickerHelloTimer) { clearTimeout(tickerHelloTimer); tickerHelloTimer = null; }
        if (tickerRelay) { try { tickerRelay.terminate(); } catch (e) {} }
        tickerRelay = false;
        tickerRelayReady = false;
        for (const rec of tickers.values()) tickerFallback(rec);
    }
    function ensureTickerRelay() {
        if (tickerRelay !== null) return tickerRelay;
        if (typeof Worker !== 'function' || typeof Blob !== 'function' ||
            typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
            tickerRelay = false;
            return false;
        }
        let worker = null;
        try {
            const url = URL.createObjectURL(new Blob([tickerSource], { type: 'text/javascript' }));
            try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
        } catch (e) {
            tickerRelay = false;
            return false;
        }
        worker.onmessage = (ev) => {
            if (typeof ev.data === 'string') {
                if (ev.data !== 'ready') return;
                tickerRelayReady = true;
                if (tickerHelloTimer) { clearTimeout(tickerHelloTimer); tickerHelloTimer = null; }

                for (const rec of tickers.values()) {
                    if (rec.fallbackId !== null) { clearInterval(rec.fallbackId); rec.fallbackId = null; }
                }
                return;
            }
            const rec = tickers.get(ev.data);
            if (rec) tickerRun(rec);
        };

        worker.onerror = () => tickerRelayFailed();
        tickerRelay = worker;

        tickerHelloTimer = setTimeout(() => { if (!tickerRelayReady) tickerRelayFailed(); }, TICKER_HELLO_MS);
        return worker;
    }
    function setBackgroundInterval(fn, ms) {
        if (typeof fn !== 'function') throw new TypeError('setBackgroundInterval needs a function');
        const delay = Math.max(16, Number(ms) || 0);
        const id = ++tickerSeq;
        const rec = { id, fn, ms: delay, fallbackId: null, stopped: false };
        tickers.set(id, rec);
        const relay = ensureTickerRelay();
        if (relay) {
            try { relay.postMessage({ op: 'start', id, ms: delay }); }
            catch (e) { tickerRelayFailed(); }
        }

        if (!tickerRelayReady) tickerFallback(rec);
        return id;
    }
    function clearBackgroundInterval(id) {
        const rec = tickers.get(id);
        if (!rec) return;
        rec.stopped = true;
        tickers.delete(id);
        if (rec.fallbackId !== null) { clearInterval(rec.fallbackId); rec.fallbackId = null; }

        if (tickerRelay) {
            try { tickerRelay.postMessage({ op: 'stop', id }); } catch (e) {}
        }
    }

    function backgroundDelay(ms) {
        return new Promise(resolve => {
            const id = setBackgroundInterval(() => { clearBackgroundInterval(id); resolve(); }, ms);
        });
    }

    let taskYieldPorts = null;
    function yieldToTasks() {
        if (typeof MessageChannel !== 'function') return new Promise(r => setTimeout(r, 0));
        if (!taskYieldPorts) {
            const ports = { channel: new MessageChannel(), waiters: [] };
            taskYieldPorts = ports;
            ports.channel.port1.onmessage = () => {
                const next = ports.waiters.shift();
                if (next) next();
            };
        }
        return new Promise(resolve => {
            taskYieldPorts.waiters.push(resolve);
            taskYieldPorts.channel.port2.postMessage(0);
        });
    }

const WORKER_BATCH_SIZE = 2;

    function workerBatchSize(type) {

        return type === 'image/jpeg' ? WORKER_BATCH_SIZE : 1;
    }

function workerPoolSize() {
        let cores = 8;
        try { cores = navigator.hardwareConcurrency || 8; } catch (e) {}
        return Math.min(Math.max(4, cores), 16);
    }

    function makePool(size, workerSrc, onDone, jobTimeoutMs, requestedBatchSize, buildMessage) {
        const batchSize = Math.max(1, Math.min(4, requestedBatchSize || WORKER_BATCH_SIZE));
        const queue = [];
        const workers = [];
        const timers = new Map();
        const workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
        let nextBatchId = 1;
        let pumpScheduled = false;

        const messageFor = typeof buildMessage === 'function' ? buildMessage : function (job) {
            const message = {
                id: job.id, relPath: job.relPath, seeds: job.seeds,
                q: job.q, fmt: job.fmt, needCrc: !!job.needCrc, timeoutMs: jobTimeoutMs,
            };

            if (job.blob) message.blob = job.blob;
            else {
                message.auth = job.auth;
                message.baseUrl = job.baseUrl;
            }
            return message;
        };
        function clearJobTimer(id) {
            const timer = timers.get(id);
            if (timer) clearTimeout(timer);
            timers.delete(id);
        }

        function transfersFor(jobs) {
            const out = [];
            for (const job of jobs) {
                if (!job || !Array.isArray(job.transfer)) continue;
                for (const item of job.transfer) if (item) out.push(item);
            }
            return out;
        }
        function replaceWorker(w) {
            const idx = workers.indexOf(w);
            if (idx !== -1) workers[idx] = spawn();
            try { w.terminate(); } catch (e) {}
        }
        function failWorker(w, error) {
            const ids = w.jobIds.slice();
            w.busy = false;
            w.batchId = null;
            w.hadTimeout = false;
            w.jobIds = [];
            for (const id of ids) {
                clearJobTimer(id);
                onDone({ id, error });
            }
            replaceWorker(w);
            pump();
        }
        function timeoutJob(w, id) {
            if (!w.jobIds.includes(id)) return;
            clearJobTimer(id);
            w.jobIds = w.jobIds.filter(jobId => jobId !== id);
            w.hadTimeout = true;
            onDone({ id, error: 'timeout' });
            if (w.jobIds.length === 0) releaseWorker(w);
        }
        function releaseWorker(w) {
            w.busy = false;
            w.batchId = null;
            const recycle = w.hadTimeout;
            w.hadTimeout = false;

            if (recycle) replaceWorker(w);
            pump();
        }
        function spawn() {
            const w = new Worker(workerUrl);
            w.busy = false;
            w.batchId = null;
            w.hadTimeout = false;
            w.jobIds = [];
            w.onmessage = (ev) => {
                const result = ev.data && ev.data.result ? ev.data.result : ev.data;
                if (!result || result.id == null || !w.jobIds.includes(result.id)) return;
                if (ev.data.batchId != null && ev.data.batchId !== w.batchId) return;
                if (!result.error && !(result.blob instanceof Blob)) {
                    clearJobTimer(result.id);
                    w.jobIds = w.jobIds.filter(id => id !== result.id);
                    onDone({ id: result.id, error: 'Worker returned no image Blob' });
                    if (w.jobIds.length === 0) releaseWorker(w);
                    return;
                }
                clearJobTimer(result.id);
                w.jobIds = w.jobIds.filter(id => id !== result.id);
                onDone(result);
                if (w.jobIds.length === 0) releaseWorker(w);
            };
            w.onerror = () => failWorker(w, 'worker crash');
            return w;
        }
        for (let i = 0; i < size; i++) workers.push(spawn());

        function pump() {
            let retry = false;
            for (const w of workers) {
                if (w.busy) continue;
                const jobs = [];
                while (jobs.length < batchSize && queue.length) jobs.push(queue.shift());
                if (!jobs.length) break;
                w.busy = true;
                w.jobIds = jobs.map(job => job.id);
                const batchId = nextBatchId++;
                w.batchId = batchId;
                w.hadTimeout = false;
                for (const job of jobs) {
                    timers.set(job.id, setTimeout(() => timeoutJob(w, job.id), jobTimeoutMs));
                }
                try {
                    w.postMessage({ batchId, jobs: jobs.map(messageFor) }, transfersFor(jobs));
                } catch (e) {
                    for (const job of jobs) {
                        clearJobTimer(job.id);
                        onDone({ id: job.id, error: 'post failed' });
                    }
                    w.busy = false;
                    w.batchId = null;
                    w.hadTimeout = false;
                    w.jobIds = [];
                    retry = true;
                }
            }

            if (retry) schedulePump();
        }
        function schedulePump() {
            if (pumpScheduled) return;
            pumpScheduled = true;
            Promise.resolve().then(() => {
                pumpScheduled = false;
                pump();
            });
        }
        return {

            submit(job) { queue.push(job); schedulePump(); },
            terminate() {
                queue.length = 0;
                for (const w of workers) { try { w.terminate(); } catch (e) {} }
                for (const timer of timers.values()) clearTimeout(timer);
                timers.clear();
                try { URL.revokeObjectURL(workerUrl); } catch (e) {}
            },
        };
    }

    function detectWorkers() {
        try {
            if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;

            if (typeof buildWorkerSource !== 'function') return false;
            const src = buildWorkerSource();
            const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            const w = new Worker(url);
            w.terminate();
            URL.revokeObjectURL(url);
            return true;
        } catch (e) { return false; }
    }

    function canSpawnBlobWorker(timeoutMs) {
        return new Promise(resolve => {
            if (typeof Worker === 'undefined') { resolve(false); return; }
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
            setTimeout(() => finish(false), timeoutMs || 1500);
        });
    }

    async function fetchWithTimeout(url, opts, ms) {
        const ctrl = new AbortController();
        const external = opts && opts.signal;
        const onExternalAbort = () => { try { ctrl.abort(); } catch (e) {} };
        if (external) {
            if (external.aborted) onExternalAbort();
            else { try { external.addEventListener('abort', onExternalAbort, { once: true }); } catch (e) {} }
        }
        let timer = setTimeout(() => ctrl.abort(), ms);
        let cleared = false;
        const clear = () => {
            if (cleared) return;
            cleared = true;
            clearTimeout(timer);
            timer = null;
            if (external) { try { external.removeEventListener('abort', onExternalAbort); } catch (e) {} }
        };
        try {
            const res = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
            try { Object.defineProperty(res, '_bwddClearTimeout', { value: clear, configurable: true }); } catch (e) {}
            for (const name of ['arrayBuffer', 'blob', 'formData', 'json', 'text']) {
                if (typeof res[name] !== 'function') continue;
                const original = res[name].bind(res);
                try {
                    Object.defineProperty(res, name, {
                        configurable: true,
                        value: async (...args) => {
                            try { return await original(...args); }
                            finally { clear(); }
                        },
                    });
                } catch (e) {
                    clear();
                }
            }
            return res;
        } catch (e) {
            clear();
            throw e;
        }
    }

    async function releaseResponse(res) {
        try { if (res && res.body && res.body.cancel) await res.body.cancel(); } catch (e) {}
        try { if (res && res._bwddClearTimeout) res._bwddClearTimeout(); } catch (e) {}
    }

    const PROXY_HOST = 'http://127.0.0.1:';
    const PROXY_BASE_PORT = 7010;

    const PROXY_MAX_PORTS = 64;

    const PROXY_ERROR_PARK = 12;
    const PROXY_PARK_MAX = 5;
    const PROXY_PARK_MS = 4000;
    const PROXY_RETIRE_MS = 90000;
    let gmUsable = (typeof GM_xmlhttpRequest === 'function');

    let proxyRealmBlocked = false;
    const proxyPorts = [];
    const proxyPortSources = new Map();

    const retiredProxyPorts = new Map();
    function proxyRetireMs() {
        try {
            const v = Number(window.__bwddProxyRetireMs);
            if (isFinite(v) && v >= 0) return v;
        } catch (e) {}
        return PROXY_RETIRE_MS;
    }

    const laneStats = {};
    function addLane(name) {
        if (!laneStats[name]) {
            laneStats[name] = {
                inflight: 0, done: 0, bytes: 0, ms: 0, errors: 0,
                parkUntil: 0, parks: 0,
            };
        }
        return laneStats[name];
    }
    addLane('page');
    addLane('gm');

    let dotLaneEnabled = false;
    function dottedUrl(url) {

        return url.replace(/^(https?:\/\/)([^/?#:]+)(:\d+)?/, (m, scheme, hostname, port) => {
            if (hostname.endsWith('.') || /^[\d.]+$/.test(hostname)) return m;
            return scheme + hostname + '.' + (port || '');
        });
    }
    async function probeDotLane(probeUrl) {
        if (!probeUrl) return false;
        try {
            const res = await fetchWithTimeout(dottedUrl(probeUrl), { credentials: 'omit' }, 8000);
            if (res && res.ok) {

                await releaseResponse(res);
                dotLaneEnabled = true;
                addLane('dot');
                const dottedHost = (dottedUrl(probeUrl).match(/^https?:\/\/([^/?#]+)/) || [])[1] || '';
                if (BWDD_DEBUG) {
                    console.info('[bwdd] trailing-dot lane ENABLED: the CDN also serves ' +
                        dottedHost + ' as its own site (+6 sockets)');
                }
                return true;
            }
            await releaseResponse(res);
            if (BWDD_DEBUG) {
                console.info('[bwdd] trailing-dot lane off (probe returned HTTP ' +
                    (res && res.status) + ')');
            }
        } catch (e) {
            if (BWDD_DEBUG) console.info('[bwdd] trailing-dot lane off (' + safeLogText((e && e.message) || e) + ')');
        }
        return false;
    }

    let edgeUrl = '';
    let edgeToken = '';
    let edgeLaneEnabled = false;

    function loadEdgeConfig() {
        try {
            const stored = localStorage.getItem('bwddEdgeMirror');
            if (stored) edgeUrl = String(stored).replace(/\/+$/, '');
            const tok = localStorage.getItem('bwddEdgeToken');
            if (tok) edgeToken = String(tok);
        } catch (e) {}
        try {
            if (window.__bwddEdgeMirror) edgeUrl = String(window.__bwddEdgeMirror).replace(/\/+$/, '');
            if (window.__bwddEdgeToken) edgeToken = String(window.__bwddEdgeToken);
        } catch (e) {}
        return edgeUrl;
    }

    async function probeEdgeMirror() {
        if (edgeLaneEnabled) return true;
        if (!loadEdgeConfig()) return false;
        try {
            const r = await fetchWithTimeout(edgeUrl + '/__bwdd_health',
                { credentials: 'omit', cache: 'no-store' }, 5000);
            if (!r.ok) {
                console.info('[bwdd] edge mirror off: health returned HTTP ' + r.status);
                return false;
            }
            const j = await r.json();
            if (!j || !j.bwddEdgeMirror) {
                console.info('[bwdd] edge mirror off: that URL is not a bwdd worker');
                return false;
            }
            if (j.tokenRequired && !edgeToken) {
                console.warn('[bwdd] edge mirror needs a token; set localStorage.bwddEdgeToken');
                return false;
            }
            edgeLaneEnabled = true;
            addLane('edge');
            console.info('[bwdd] HTTP/2 edge mirror ENABLED at ' + edgeUrl +
                ': multiplexed streams instead of 6 sockets');
            return true;
        } catch (e) {
            console.info('[bwdd] edge mirror off (' + safeLogText((e && e.message) || e) + ')');
        }
        return false;
    }

    function edgeUrlFor(url) {
        return edgeUrl + url.replace(/^https?:\/\/[^/]+/, '');
    }

    function allLanes(onlineOnly) {
        const out = [{ name: 'page', kind: 'page' }];
        if (gmUsable) out.push({ name: 'gm', kind: 'gm' });
        if (dotLaneEnabled) out.push({ name: 'dot', kind: 'dot' });
        if (edgeLaneEnabled) out.push({ name: 'edge', kind: 'edge' });
        const now = Date.now();
        for (const p of proxyPorts) {
            if (onlineOnly && !proxyPortOnline(p)) continue;
            const st = laneStats['px:' + p];
            if (st && st.parkUntil > now) continue;
            out.push({
                name: 'px:' + p, kind: 'proxy', port: p,
                pathUpstream: proxyPortUsesPathUpstream(p),
            });
        }
        return out;
    }

    function laneCapacity(L) {
        return L && L.kind === 'edge' ? 100 : 6;
    }

    const CHROMIUM_SOCKETS_PER_PROCESS = 256;
    const CONTROL_PLANE_SOCKET_RESERVE = 16;
    const MAX_DATA_PLANE_SOCKETS = CHROMIUM_SOCKETS_PER_PROCESS - CONTROL_PLANE_SOCKET_RESERVE;

    function fetchSocketBudget(onlineOnly) {
        let n = 0;
        for (const L of allLanes(onlineOnly)) n += laneCapacity(L);
        n = Math.min(n, MAX_DATA_PLANE_SOCKETS);
        return n;
    }

    function rawSocketBudget(onlineOnly) {
        let n = 0;
        for (const L of allLanes(onlineOnly)) n += laneCapacity(L);
        return n;
    }

    function gmBlobFetch(url, timeoutMs, headers) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const fail = (msg) => {
                if (settled) return;
                settled = true;
                const e = new Error(msg); e.status = 0; reject(e);
            };
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    headers: headers || undefined,
                    timeout: timeoutMs || 45000,
                    responseType: 'blob',
                    onload: (r) => {
                        if (settled) return;
                        settled = true;
                        let body = r.response;
                        if (body instanceof ArrayBuffer) body = new Blob([body], { type: 'image/jpeg' });
                        if (!(body instanceof Blob)) { fail('GM_xhr: no blob body'); return; }
                        const ok = r.status >= 200 && r.status < 300;
                        resolve({ ok, status: r.status, blob: async () => body,
                            headers: gmHeaderShim(r.responseHeaders), _lane: 'gm' });
                    },
                    onerror: () => fail('GM_xhr: request failed'),
                    ontimeout: () => fail('GM_xhr: timeout'),
                    onabort: () => fail('GM_xhr: aborted'),
                });
            } catch (e) { fail('GM_xhr: ' + safeLogText((e && e.message) || e)); }
        });
    }

    function gmHeaderShim(raw) {
        const text = String(raw || '');
        return {
            get(name) {
                const want = String(name || '').toLowerCase();
                for (const line of text.split(/\r?\n/)) {
                    const ix = line.indexOf(':');
                    if (ix === -1) continue;
                    if (line.slice(0, ix).trim().toLowerCase() === want) return line.slice(ix + 1).trim();
                }
                return null;
            },
        };
    }

    async function loopbackJson(url, timeoutMs) {
        if (!proxyRealmBlocked) {
            try {
                const r = await fetchWithTimeout(url, { credentials: 'omit', cache: 'no-store' }, timeoutMs);
                if (r.ok) return await r.json();
            } catch (e) { }
        }

        if (typeof GM_xmlhttpRequest !== 'function') return null;
        try {
            const res = await gmBlobFetch(url, timeoutMs || 2500);
            if (!res || !res.ok) return null;
            const blob = await res.blob();
            const j = JSON.parse(await blob.text());
            proxyRealmBlocked = true;
            return j;
        } catch (e) { return null; }
    }

    let proxyUpstreamPatterns = ['bw-bv-epubs.bookwalker.jp'];
    let proxyDefaultHost = 'bw-bv-epubs.bookwalker.jp';
    function setProxyUpstreams(list, defaultUpstream) {
        if (defaultUpstream) {
            const d = String(defaultUpstream).replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
            if (d) proxyDefaultHost = d;
        }
        if (!Array.isArray(list) || !list.length) return false;
        const patterns = list
            .map(p => String(p || '').toLowerCase().trim())
            .filter(Boolean);
        if (!patterns.length) return false;
        proxyUpstreamPatterns = patterns;
        return true;
    }
    function proxyCanServe(host) {
        const h = String(host || '').toLowerCase();
        if (!h) return false;
        for (const pattern of proxyUpstreamPatterns) {
            if (pattern === '*') return true;
            if (pattern === h) return true;
            if (pattern.indexOf('*') !== -1) {
                const rx = new RegExp('^' + pattern.split('*')
                    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
                    .join('[^.]*') + '$');
                if (rx.test(h)) return true;
            }
        }
        return false;
    }
    function hostOf(url) {
        const m = /^https?:\/\/([^/?#]+)/.exec(String(url || ''));
        return m ? m[1].replace(/:\d+$/, '').toLowerCase() : '';
    }

    function proxyPortOnline(port) {
        const sources = proxyPortSources.get(port);
        return !!(sources && (sources.has('bridge') || sources.has('helper')));
    }

    function activeProxyPortCount() {
        let n = 0;
        for (const sources of proxyPortSources.values()) {
            if (sources.has('bridge') || sources.has('helper')) n++;
        }
        return n;
    }

    const PATH_UPSTREAM_PREFIX = '/_bwdd/';
    const pathUpstreamSources = new Set();

    function proxyPortUsesPathUpstream(port) {
        const sources = proxyPortSources.get(port);
        if (!sources) return false;
        for (const source of sources) {
            if (pathUpstreamSources.has(source)) return true;
        }
        return false;
    }

    function addProxyPorts(list, source, options) {
        const key = source || 'legacy';
        if (options && options.pathUpstream) pathUpstreamSources.add(key);
        else pathUpstreamSources.delete(key);
        const advertised = new Set();
        for (const raw of (Array.isArray(list) ? list : [])) {
            const port = parseInt(raw, 10);
            if (port > 0 && port < 65536) advertised.add(port);
        }
        for (const [port, sources] of proxyPortSources) {
            if (!sources.has(key)) continue;
            if (advertised.has(port)) sources.add(key);
            else {
                sources.delete(key);
                if (!sources.size) proxyPortSources.delete(port);
            }
        }
        pruneProxyPorts();
        for (const port of advertised) {
            if (retiredProxyPorts.has(port)) {
                if (retiredProxyPorts.get(port) > Date.now()) continue;

                retiredProxyPorts.delete(port);
                const st = laneStats['px:' + port];
                if (st) { st.parks = 0; st.errors = 0; st.parkUntil = 0; }
            }
            if (!proxyPorts.includes(port) && activeProxyPortCount() < PROXY_MAX_PORTS) {
                proxyPorts.push(port);
                addLane('px:' + port);
            }
            if (proxyPorts.includes(port)) {
                const sources = proxyPortSources.get(port) || new Set();
                sources.add(key);
                proxyPortSources.set(port, sources);
            }
        }
    }

    function pruneProxyPorts() {
        for (let i = proxyPorts.length - 1; i >= 0; i--) {
            const port = proxyPorts[i];
            if (!proxyPortOnline(port) || retiredProxyPorts.has(port)) {
                proxyPorts.splice(i, 1);
                delete laneStats['px:' + port];
            }
        }
    }

    function clearProxySource(source) {
        pathUpstreamSources.delete(source);
        for (const [port, sources] of proxyPortSources) {
            sources.delete(source);
            if (!sources.size) proxyPortSources.delete(port);
        }
        pruneProxyPorts();
    }

    async function probeBridgeFetchProxy() {

        const j = await loopbackJson(MOKURO_BRIDGE_URL + '/health', 2500);

        if (!j) return;
        clearProxySource('bridge');
        if (j.fetchUpstreams || j.upstream) {
            setProxyUpstreams(j.fetchUpstreams, j.upstream);
        }
        if (Array.isArray(j.fetchProxyPorts) && j.fetchProxyPorts.length) {

            addProxyPorts(j.fetchProxyPorts, 'bridge', { pathUpstream: !!j.fetchPathUpstream });
        }
    }

    async function probeFetchProxy() {
        return await discoverProxyPorts();
    }

    let discoveryInFlight = null;

    async function discoverProxyPorts() {
        if (discoveryInFlight) return await discoveryInFlight;
        discoveryInFlight = discoverProxyPortsOnce();
        try { return await discoveryInFlight; }
        finally { discoveryInFlight = null; }
    }

    async function discoverProxyPortsOnce() {
        let basePort = PROXY_BASE_PORT;
        try {
            if (typeof window !== 'undefined' && window.__bwddProxyBasePort) {
                basePort = parseInt(window.__bwddProxyBasePort, 10) || PROXY_BASE_PORT;
            }
        } catch (e) {}

        const helper = (async () => {
            const j = await loopbackJson(PROXY_HOST + basePort + '/__bwdd_health', 800);
            if (j && j.bwddFetchProxy) {
                clearProxySource('helper');
                if (Array.isArray(j.upstreams) && j.upstreams.length) setProxyUpstreams(j.upstreams);
                addProxyPorts(
                    Array.isArray(j.portList) && j.portList.length
                        ? j.portList
                        : Array.from(
                            { length: Math.min(PROXY_MAX_PORTS, j.ports || 1) },
                            (_, i) => basePort + i),
                    'helper',
                    { pathUpstream: !!j.pathUpstream }
                );
            }
        })();
        await Promise.all([helper, probeBridgeFetchProxy()]);
        return proxyPorts;
    }

    let laneBridgeOnline = false;

    function capabilitySummary() {
        const lanes = allLanes(true);
        const ports = lanes.filter(l => l.kind === 'proxy').length;
        const sockets = fetchSocketBudget(true);
        const rawSockets = rawSocketBudget(true);
        const offlineSockets = 6 + (gmUsable ? 6 : 0) + (dotLaneEnabled ? 6 : 0) +
            (edgeLaneEnabled ? 100 : 0);
        return {
            ports,
            sockets,
            rawSockets,

            socketsClamped: rawSockets > sockets,
            withoutBridge: offlineSockets,
            effectiveSockets: sockets,
            workers: workerPoolSize(),
            decodePages: workerPoolSize() * workerBatchSize(IMAGE_CODEC.type),
            laneCount: lanes.length,
            bridge: ports > 0,
            bridgeOnline: laneBridgeOnline,
        };
    }

    let laneRR = 0;

    function pickLane(allowProxy) {
        let lanes = allLanes(true);
        if (allowProxy === false) {
            lanes = lanes.filter(L => L.kind !== 'proxy');
            if (!lanes.length) lanes = [{ name: 'page', kind: 'page' }];
        }
        const n = lanes.length;
        let best = null, bestScore = Infinity;
        for (let i = 0; i < n; i++) {
            const L = lanes[(laneRR + i) % n];
            const score = laneStats[L.name].inflight / laneCapacity(L);
            if (score < bestScore) { bestScore = score; best = L; }
        }
        laneRR = (laneRR + 1) % Math.max(1, n);
        return best;
    }

    function proxyUrlFor(port, url) {
        return PROXY_HOST + port + url.replace(/^https?:\/\/[^/]+/, '');
    }

    function proxyPathUrlFor(port, host, url) {
        return PROXY_HOST + port + PATH_UPSTREAM_PREFIX + host + url.replace(/^https?:\/\/[^/?#]+/, '');
    }

    function laneRetireLimit(lane) {
        if (lane.kind === 'gm') return 5;
        if (lane.kind === 'proxy') return PROXY_ERROR_PARK;
        return 8;
    }

    function retireLane(lane, err) {
        const st = laneStats[lane.name];
        st.errors = 0;
        const why = safeLogText((err && err.message) || err || '');
        if (lane.kind === 'gm') {
            gmUsable = false;
            console.warn('[bwdd] GM transport disabled after repeated failures:', why);
        } else if (lane.kind === 'edge') {
            edgeLaneEnabled = false;
            console.warn('[bwdd] edge mirror retired: ' + why);
        } else if (lane.kind === 'dot') {
            dotLaneEnabled = false;
            console.warn('[bwdd] trailing-dot lane retired: ' + why);
        } else if (lane.kind === 'proxy') {
            st.parkUntil = Date.now() + PROXY_PARK_MS;
            if (++st.parks >= PROXY_PARK_MAX) {
                const ix = proxyPorts.indexOf(lane.port);
                if (ix !== -1) proxyPorts.splice(ix, 1);
                proxyPortSources.delete(lane.port);
                retiredProxyPorts.set(lane.port, Date.now() + proxyRetireMs());
                console.warn('[bwdd] fetch proxy port ' + lane.port + ' retired after repeated parks');
            }
        }
    }

    async function laneAttempt(lane, url, timeoutMs, signal) {
        const to = timeoutMs || 45000;
        if (lane.kind === 'gm') return await gmBlobFetch(url, to);
        if (lane.kind === 'edge') {
            const opts = { credentials: 'omit' };
            if (edgeToken) opts.headers = { 'x-bwdd-token': edgeToken };
            return await fetchWithTimeout(edgeUrlFor(url), Object.assign({ signal: signal }, opts), to);
        }
        if (lane.kind === 'dot') {
            return await fetchWithTimeout(dottedUrl(url), { credentials: 'omit', signal: signal }, to);
        }
        if (lane.kind === 'proxy') {

            const opts = { credentials: 'omit' };
            const host = hostOf(url);

            let target = proxyUrlFor(lane.port, url);
            if (host && lane.pathUpstream) target = proxyPathUrlFor(lane.port, host, url);
            else if (host && host !== proxyDefaultHost) opts.headers = { 'x-bwdd-upstream': host };

            const gmHeaders = (host && !lane.pathUpstream) ? { 'x-bwdd-upstream': host } : null;
            const viaGm = async () => await gmProxyRequest(target, host, to, gmHeaders);
            if (proxyRealmBlocked) return await viaGm();
            try {
                if (signal) opts.signal = signal;
                const res = await fetchWithTimeout(target, opts, to);
                if (res.status === 403) {
                    const ct = res.headers && res.headers.get && res.headers.get('content-type');
                    if (ct && ct.indexOf('application/json') !== -1) {
                        await releaseResponse(res);
                        throw new Error('fetch proxy refused host ' + host);
                    }
                }
                if (res.status >= 500 && res.status <= 504) {
                    await releaseResponse(res);
                    throw new Error('fetch proxy transport error ' + res.status);
                }
                return res;
            } catch (e) {

                const gm = await viaGm();
                if (!gm) throw e;
                proxyRealmBlocked = true;
                console.warn('[bwdd] this page\u2019s CSP refuses http:// loopback \u2014 ' +
                    'the accelerator now rides GM_xmlhttpRequest');
                return gm;
            }
        }
        return await fetchWithTimeout(url, { credentials: 'omit', signal: signal }, to);
    }

    function resetProxyRealmFlag() { proxyRealmBlocked = false; }

    let gmProxyLastNote = '';
    function gmProxyNote(why) {
        if (why === gmProxyLastNote) return;
        gmProxyLastNote = why;
        console.warn('[bwdd] fetch proxy lane unusable: ' + why);
    }

    async function gmProxyRequest(target, host, timeoutMs, headers) {
        if (typeof GM_xmlhttpRequest !== 'function') return null;
        let gm;
        try { gm = await gmBlobFetch(target, timeoutMs, headers); }
        catch (e) {
            gmProxyNote('unreachable: ' + safeLogText((e && e.message) || e));
            return null;
        }
        if (!gm.ok) gmProxyNote('HTTP ' + gm.status + ' for host ' + (host || '(default)'));
        const ct = gm.headers && gm.headers.get && gm.headers.get('content-type');
        if (gm.status === 403 && ct && ct.indexOf('application/json') !== -1) {
            throw new Error('fetch proxy refused host ' + host);
        }
        if (gm.status >= 500 && gm.status <= 504) {
            throw new Error('fetch proxy transport error ' + gm.status);
        }
        return gm;
    }

    function tagLane(res, name) {
        try { Object.defineProperty(res, '_lane', { value: name, configurable: true }); } catch (e) {}
        return res;
    }

    async function laneFetch(url, timeoutMs, opts) {
        const lane = pickLane(opts && opts.allowProxy);
        const isPage = lane.kind === 'page';
        const signal = opts && opts.signal;
        try {
            return await laneAttemptRated(lane, url, timeoutMs, signal);
        } catch (e) {
            if (isPage) throw e;
        }
        return await onPageLane(url, timeoutMs, signal);
    }

    async function laneAttemptRated(lane, url, timeoutMs, signal) {
        const st = laneStats[lane.name];
        const countsNonOk = lane.kind === 'edge' || lane.kind === 'dot';
        st.inflight++;
        try {
            const res = await laneAttempt(lane, url, timeoutMs, signal);
            if (res && res.status >= 500 && res.status <= 504 &&
                (lane.kind === 'edge' || lane.kind === 'dot' || lane.kind === 'gm')) {
                await releaseResponse(res);
                throw new Error('lane transport HTTP ' + res.status);
            }
            if (res && res.ok) st.errors = 0;
            else if (countsNonOk && ++st.errors >= laneRetireLimit(lane)) retireLane(lane, null);
            return tagLane(res, lane.name);
        } catch (e) {
            if (++st.errors >= laneRetireLimit(lane)) retireLane(lane, e);
            throw e;
        } finally {
            st.inflight--;
        }
    }

    function proxyLaneAvailable() {
        return allLanes(true).some(L => L.kind === 'proxy');
    }

    async function proxyLaneFetch(url, timeoutMs) {

        if (!proxyCanServe(hostOf(url))) return null;
        const px = allLanes(true).filter(L => L.kind === 'proxy');
        if (!px.length) return null;

        const n = px.length;
        let best = px[0], bestScore = Infinity;
        for (let i = 0; i < n; i++) {
            const L = px[(laneRR + i) % n];
            const score = laneStats[L.name].inflight / laneCapacity(L);
            if (score < bestScore) { bestScore = score; best = L; }
        }
        laneRR = (laneRR + 1) % n;
        try { return await laneAttemptRated(best, url, timeoutMs); }
        catch (e) { return null; }
    }

    async function onPageLane(url, timeoutMs, signal) {
        laneStats.page.inflight++;
        try {
            return tagLane(await fetchWithTimeout(url, { credentials: 'omit', signal: signal }, timeoutMs || 45000), 'page');
        } finally {
            laneStats.page.inflight--;
        }
    }

    function recordLane(lane, ms, bytes) {
        const s = laneStats[lane] || laneStats.page;
        s.done++; s.ms += ms; s.bytes += (bytes || 0);
    }

    function laneSummary() {
        const out = {};
        let total = 0;
        for (const k of Object.keys(laneStats)) total += laneStats[k].done;
        for (const k of Object.keys(laneStats)) {
            const s = laneStats[k];
            if (!s.done) continue;
            out[k] = {
                pages: s.done,
                mb: +(s.bytes / 1048576).toFixed(2),
                avgMs: Math.round(s.ms / s.done),
                share: Math.round(100 * s.done / total) + '%',
            };
        }
        return out;
    }

    function dedupeInflight(map, key, start) {
        let p = map.get(key);
        if (!p) {
            p = start();
            map.set(key, p);
            const drop = () => { if (map.get(key) === p) map.delete(key); };
            p.then(drop, drop);
        }
        return p;
    }

let rateLimitCooldownUntil = 0;
    let consecutiveBlocks = 0;
    function corsLikeError(e, status) {
        if (status === 429 || status === 503) return true;
        if (status === 403) return true;
        const msg = safeLogText((e && e.message) || e);
        return /Failed to fetch|NetworkError|load failed|ERR_|TypeError/i.test(msg);
    }
    async function sleepMs(ms) { await new Promise(r => setTimeout(r, ms)); }
    async function waitOutCooldown() {
        while (rateLimitCooldownUntil > Date.now()) {
            const wait = Math.min(rateLimitCooldownUntil - Date.now(), 10000);
            await sleepMs(wait);
        }
    }
    function tripBreaker() {
        const now = Date.now();
        if (rateLimitCooldownUntil > now) return breakerRemainingMs();
        consecutiveBlocks = Math.min(consecutiveBlocks + 1, 3);
        const cooldownMs = [8000, 16000, 30000][consecutiveBlocks - 1] || 30000;
        rateLimitCooldownUntil = now + cooldownMs;
        console.warn(`[bwdd] CDN protection active: cooling down for ${cooldownMs / 1000}s`);
        return cooldownMs;
    }
    function breakerOpen() { return rateLimitCooldownUntil > Date.now(); }
    function breakerRemainingMs() { return Math.max(0, rateLimitCooldownUntil - Date.now()); }

    let reqsSinceAuth = 0;
    const REQS_PER_POLICY_RENEW = 100;
    function authRequestBudgetExhausted() { return reqsSinceAuth >= REQS_PER_POLICY_RENEW; }
    function resetAuthBudget() { reqsSinceAuth = 0; }

function effectiveBurst(base) {
        if (consecutiveBlocks === 0) return base;
        return Math.max(4, Math.floor(base / (consecutiveBlocks + 1)));
    }

    const CORS_PROXIES = [
        'https://corsproxy.io/?url=',
        'https://api.allorigins.win/raw?url=',
    ];
    async function gmFetch(url, timeoutMs = 20000) {
        if (typeof GM_xmlhttpRequest === 'function') {
            try {
                return await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET', url, timeout: timeoutMs,
                        onload: (r) => resolve({ status: r.status, text: r.responseText }),
                        onerror: (e) => reject(new Error('GM_xhr: ' + (e && e.error))),
                        ontimeout: () => reject(new Error('GM_xhr: Timeout')),
                    });
                });
            } catch (e) { }
        }

        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), timeoutMs);
            try {
                const r = await fetch(url, { credentials: 'omit', signal: ctrl.signal });
                return { status: r.status, text: await r.text() };
            } finally { clearTimeout(timer); }
        } catch (e) { }
        for (const proxy of CORS_PROXIES) {
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), timeoutMs);
                let r;
                try {
                    r = await fetch(proxy + encodeURIComponent(url), { signal: ctrl.signal });
                    if (r.ok) return { status: r.status, text: await r.text() };
                } finally { clearTimeout(timer); }
            } catch (e) { }
        }
        throw new Error('fetch failed: ' + url.slice(0, 80));
    }
    function extractVolumeNumber(title) {
        const t = String(title || '');

        const tail = t.match(/[（(]?\s*([0-9０-９]{1,4})\s*[）)]?\s*[巻話]?\s*$/);
        if (tail) {
            const digits = tail[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
            return parseInt(digits, 10);
        }
        const kanjiTail = t.match(/([一二三四五六七八九十百]+)\s*[巻話]\s*$/);
        if (kanjiTail) return kanjiNum(kanjiTail[1]);
        const full = t.match(/([0-9０-９]+)/);
        if (full) {
            const digits = full[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
            return parseInt(digits, 10);
        }
        const kanji = t.match(/[一二三四五六七八九十百]+[巻話]/);
        if (kanji) return kanjiNum(kanji[0]);
        return NaN;
    }
    function kanjiNum(s) {
        const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
        let n = 0, m = 0;
        for (const ch of s) {
            if (map[ch]) m = map[ch];
            else if (ch === '十') { n += (m || 1) * 10; m = 0; }
            else if (ch === '百') { n += (m || 1) * 100; m = 0; }
        }
        return n + m || 1;
    }
    function parseMangaKotobaTable(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const rows = doc.querySelectorAll('#series-volume-stats tbody tr, table#series-volume-stats tr');
        const out = [];
        for (const tr of rows) {
            const a = tr.querySelector('a[href*="/volume/"]');
            if (!a) continue;
            const cells = tr.querySelectorAll('td');
            if (cells.length < 7) continue;
            const num = (s) => parseInt((s || '').replace(/,/g, '').trim(), 10);
            const pct = (s) => parseFloat((s || '').replace('%', '').trim());
            out.push({
                title: a.textContent.trim(),
                href: a.getAttribute('href'),
                total: num(cells[2] ? cells[2].textContent : ''),
                unique: num(cells[3] ? cells[3].textContent : ''),
                usedOnce: num(cells[4] ? cells[4].textContent : ''),
                usedOncePct: pct(cells[5] ? cells[5].textContent : ''),
                newWords: num(cells[6] ? cells[6].textContent : ''),
                density: parseFloat((cells[7] ? cells[7].textContent : '').trim()),
            });
        }
        return out;
    }
    async function lookupMangaKotoba(seriesTitle, volumeNum) {
        try {
            let links = null;
            let search = '';
            let usedTitle = seriesTitle;
            for (const cand of searchTitleCandidates(seriesTitle)) {
                const q = encodeURIComponent(cand);
                const text = (await gmFetch('https://manga-kotoba.com/search/series/?q=' + q)).text;
                const doc = new DOMParser().parseFromString(text, 'text/html');
                const l = [...doc.querySelectorAll('a[href*="/series/"]')];
                if (l.length) { links = l; search = text; usedTitle = cand; break; }
            }
            if (!links) return null;
            const norm = (x) => String(x || '').replace(/[\s　\u30fb・:：()（）]/g, '').toLowerCase();
            const target = norm(usedTitle);

            const titleOf = (a) => {
                const h = a.querySelector('.japanese-title, .series-title, h3');
                if (h) { const x = (h.textContent || '').trim(); if (x) return x; }
                const line = String(a.textContent || '').split(/\n/).map(x => x.trim()).find(Boolean);
                return line || '';
            };
            let best = null, bestScore = 0, bestExtra = Infinity;
            for (const a of links) {
                const t = norm(titleOf(a));
                if (!t || !target) continue;
                let score = 0;
                if (t === target) score = 1000;
                else if (t.indexOf(target) !== -1) score = target.length;
                else if (target.indexOf(t) !== -1) score = t.length;
                if (!score) continue;
                const extra = t.length - target.length;
                if (score > bestScore || (score === bestScore && extra < bestExtra)) {
                    bestScore = score; bestExtra = extra; best = a;
                }
            }
            if (!best) return null;
            const slug = best.getAttribute('href');
            const page = (await gmFetch('https://manga-kotoba.com' + slug)).text;
            const vols = parseMangaKotobaTable(page);
            if (!vols.length) return { seriesUrl: 'https://manga-kotoba.com' + slug, volume: null };
            let vol = null;
            for (const v of vols) {
                const n = extractVolumeNumber(v.title);
                if (n === volumeNum) { vol = v; break; }
            }
            if (!vol && vols.length === 1) vol = vols[0];
            return {
                seriesUrl: 'https://manga-kotoba.com' + slug,
                volume: vol ? { ...vol, url: 'https://manga-kotoba.com' + vol.href } : null,
                volumeCount: vols.length,
            };
        } catch (e) {
            if (BWDD_DEBUG) console.warn('[bwdd] Manga-kotoba lookup error:', safeLogText(e && e.message));
            return null;
        }
    }
    function searchTitleCandidates(raw) {
        const t = String(raw || '').trim();
        const out = [t];
        const seen = new Set([t]);
        const push = (s) => { s = String(s || '').trim(); if (s && !seen.has(s)) { seen.add(s); out.push(s); } };
        let s = t.replace(/【[^】]*】/g, ' ').replace(/[\s　]+/g, ' ').trim();
        push(s);
        let cur = s;
        for (let i = 0; i < 6; i++) {
            const before = cur;
            cur = cur
                .replace(/[\s　]*(文庫版|新装版|完全版|愛蔵版|廉価版|普及版|電子版|特装版|限定版|豪華版|分冊版|合本版|オンデマンド版|デジタル版|単行本版|ノベルズ版|ペーパーバック版)[\s　]*$/u, '')
                .replace(/[\s　]*[(（]*(文庫|新装|完全|愛蔵|廉価|普及)[)）]*[\s　]*$/u, '')

                .replace(/[\s　]*第?[0-9０-９一二三四五六七八九十百]+[巻話版編]?[\s　]*$/u, '')
                .trim();
            push(cur);
            if (cur === before) break;
        }
        push(s.replace(/[\s　]*版$/u, '').trim());
        return out.filter(Boolean);
    }
    async function lnSearchBook(candidates) {
        for (const cand of candidates) {
            const q = encodeURIComponent(cand);
            const r = await gmFetch('https://learnnatively.com/api/ninja/search/books/?language=jpn&q=' + q);
            if (r.status !== 200) continue;
            try {
                const d = JSON.parse(r.text);
                const items = (d.results || []).map(x => x.item).filter(i => i && i.series_id);
                if (items.length) return { cand, items };
            } catch (e) {}
        }
        return null;
    }

    async function lookupLearnNatively(seriesTitle, volumeNum) {
        try {
            const cands = searchTitleCandidates(seriesTitle);
            const found = await lnSearchBook(cands);
            if (!found) return null;
            const items = found.items;
            const first = items[0];
            const sid = first.series_id.replace(/-/g, '').slice(0, 10);
            let volUrl = null, volTitle = null, level = null;
            let matchedNo = null;
            let fallbackNearest = null;
            try {
                const shtml = (await gmFetch('https://learnnatively.com/series/' + sid + '/')).text;
                const sdoc = new DOMParser().parseFromString(shtml, 'text/html');
                const links = [...sdoc.querySelectorAll('a.title[href*="/book/"]')];
                for (const a of links) {
                    const parent = a.closest('.item, .subitems > div, li, div') || a;
                    const notice = parent.querySelector('.item-type-notice');
                    const numMatch = (notice ? notice.textContent : '') + ' ' + (a.getAttribute('title') || a.textContent);

                    const m = numMatch.match(/Book\s*#?\s*(\d+)/i) || numMatch.match(/第?\s*(\d+)\s*巻/) ||
                             numMatch.match(/(\d+)\s*$/) || numMatch.match(/[（(]?([0-9０-９]{1,3})[）)]/);
                    const an = m ? parseInt(m[1].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)), 10) : NaN;
                    if (an === volumeNum) {
                        volUrl = a.getAttribute('href');
                        volTitle = a.getAttribute('title') || a.textContent.trim();
                        matchedNo = an;
                        break;
                    }
                    if (!isNaN(an)) {

                        if (!fallbackNearest || (an > fallbackNearest.an && an <= volumeNum) ||
                            (an <= volumeNum && (fallbackNearest.an > volumeNum || an > fallbackNearest.an))) {
                            fallbackNearest = { an, href: a.getAttribute('href'), title: a.getAttribute('title') || a.textContent.trim() };
                        }
                    }
                }
                if (!volUrl && links.length === 1) {
                    volUrl = links[0].getAttribute('href');
                    volTitle = links[0].getAttribute('title') || links[0].textContent.trim();
                    matchedNo = 1;
                }
                if (!volUrl && fallbackNearest) {
                    volUrl = fallbackNearest.href;
                    volTitle = fallbackNearest.title;
                    matchedNo = fallbackNearest.an;
                }
                const lvl = sdoc.querySelector('.key-tags .level, [class*="level"], [class*="Level"]');
                level = lvl ? lvl.textContent.trim() : null;
            } catch (e) {}
            const lvlFromRating = first.rating ? first.rating.lvl : null;
            const tmpFlag = first.rating ? !!(first.rating.temporary || first.rating.always_temporary) : false;
            const bookUrl = volUrl ? 'https://learnnatively.com' + volUrl : ('https://learnnatively.com' + first.url);

            const rd = first.review_data || {};
            const badges = [];
            if (first.wanikani) badges.push('WK');
            if (first.book_club) badges.push('BC');

            const meta = await fetchLnBookMeta(bookUrl);

            return Object.assign({
                seriesUrl: 'https://learnnatively.com/series/' + sid + '/',
                bookUrl,
                title: volTitle || first.title,
                volume: matchedNo != null ? matchedNo
                    : (first.series_order != null ? first.series_order : null),
                level: lvlFromRating != null ? lvlFromRating : level,
                temporary: tmpFlag,
                avgRating: rd.avg_rating != null ? rd.avg_rating : null,
                ratings: rd.rating_count != null ? rd.rating_count : null,
                reviews: rd.review_count != null ? rd.review_count : null,
                badges,
                altTitles: first.alternative_titles || null,
            }, meta || {});
        } catch (e) {
            if (BWDD_DEBUG) console.warn('[bwdd] LearnNatively lookup error:', safeLogText(e && e.message));
            return null;
        }
    }
    async function fetchLnBookMeta(bookUrl) {
        try {
            const r = await gmFetch(bookUrl);
            if (r.status !== 200) return null;
            const doc = new DOMParser().parseFromString(r.text, 'text/html');
            const out = {};
            const rs = doc.querySelector('.ratings-summary');
            if (rs) {
                const m = rs.textContent.replace(/\s+/g, ' ').match(/([\d,]+)\s*ratings?,?\s*([\d,]+)\s*reviews?/i);
                if (m) {
                    out.ratings = parseInt(m[1].replace(/,/g, ''), 10) || 0;
                    out.reviews = parseInt(m[2].replace(/,/g, ''), 10) || 0;
                }
            }
            const inc = doc.querySelector('.count.in-progress');
            const fin = doc.querySelector('.count.finished');
            const num = (s) => { const v = s && s.textContent.replace(/[^\d]/g, ''); return v ? parseInt(v, 10) : 0; };
            out.reading = num(inc);
            out.finished = num(fin);
            const badges = [...doc.querySelectorAll('.key-tags .wanikani')].map(b => b.textContent.trim()).filter(Boolean);
            if (badges.length) out.badges = badges;
            const alt = doc.querySelector('.alternative-titles .alt-titles');
            if (alt) out.altTitles = alt.textContent.trim();
            return out;
        } catch (e) { return null; }
    }

    function fetchAndRenderStats(statsEl, seriesTitle, volumeNum) {
        if (!statsEl || !seriesTitle) return;
        lookupMangaKotoba(seriesTitle, volumeNum)
            .then(mk => { if (mk) upsertCard(statsEl, 'manga-kotoba', () => renderMangaKotobaCard(mk)); })
            .catch(e => { if (BWDD_DEBUG) console.warn('[bwdd] Manga-kotoba lookup error:', safeLogText(e && e.message)); });
        lookupLearnNatively(seriesTitle, volumeNum)
            .then(ln => { if (ln) upsertCard(statsEl, 'natively', () => renderNativelyCard(ln)); })
            .catch(e => { if (BWDD_DEBUG) console.warn('[bwdd] LearnNatively lookup error:', safeLogText(e && e.message)); });
    }

    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function cardLink(href, label, hint) {
        const a = el('a', 'bwdd-link', label + ' ↗');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.setAttribute('aria-label', hint ? `${label}, ${hint} (new tab)` : `${label} (new tab)`);
        return a;
    }
    function statRow(grid, label, value, tip) {
        const dt = el('dt', null, label);
        if (tip) dt.title = tip;
        grid.append(dt, el('dd', null, value == null ? '—' : String(value)));
    }
    function upsertCard(container, key, buildFn) {
        if (!container) return null;
        const old = container.querySelector('.bwdd-card[data-card="' + key + '"]');
        if (old) old.remove();

        const card = buildFn();
        if (!card) return null;
        card.dataset.card = key;
        const book = container.querySelector('.bwdd-card[data-card="book"]');
        if (key === 'book') {
            if (book) container.insertBefore(card, book);
            else if (container.firstChild) container.insertBefore(card, container.firstChild);
            else container.appendChild(card);
            return card;
        }
        const last = container.querySelector('.bwdd-card:last-child');
        if (last) last.after(card);
        else container.appendChild(card);
        return card;
    }
    function emptyCard(kicker) {
        const card = el('article', 'bwdd-card');
        card.appendChild(el('h3', null, kicker));
        return card;
    }

    function levelInfo(level) {
        const l = Number(level);
        if (isNaN(l)) return ['#5b21b6', ''];
        if (l <= 12) return ['#075985', 'N5'];
        if (l <= 19) return ['#9f1239', 'N4'];
        if (l <= 26) return ['#5b21b6', 'N3'];
        if (l <= 33) return ['#9a3412', 'N2'];
        if (l <= 40) return ['#166534', 'N1'];
        return ['#0e7490', 'N1+'];
    }
    function lightenHex(hex, amount) {
        const n = parseInt(hex.slice(1), 16);
        const mix = (c) => Math.round(c + (255 - c) * amount);
        const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
        return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
    }
    function renderLevelPill(level, temporary) {
        const [bg, jlpt] = levelInfo(level);
        const b = el('span', 'bwdd-nlvl-pill', `Level ${level}${temporary ? '??' : ''}`);
        b.style.background = temporary ? lightenHex(bg, 0.55) : bg;
        b.style.color = temporary ? bg : '#fff';
        b.setAttribute('role', 'img');
        b.setAttribute('aria-label', temporary
            ? `Provisional Natively level ${level}${jlpt ? `, ${jlpt}` : ''}`
            : `Natively level ${level}${jlpt ? `, ${jlpt}` : ''}`);
        return b;
    }
    function renderNativelyCard(ln) {
        const card = emptyCard('LearnNatively');
        const meta = el('div', 'bwdd-ln-meta');
        if (ln.level != null) {
            const [, jlpt] = levelInfo(ln.level);
            meta.appendChild(renderLevelPill(ln.level, ln.temporary));
            if (jlpt) {
                const cap = el('span', 'bwdd-lvl-cap', jlpt);
                cap.setAttribute('aria-hidden', 'true');
                meta.appendChild(cap);
            }
        }
        for (const b of ln.badges || []) {
            const t = { WK: 'WaniKani vocab', BC: 'Book club' }[String(b).toUpperCase()] || '';
            const s = el('span', 'bwdd-lnbadge', String(b).toUpperCase());
            if (t) s.title = t;
            meta.appendChild(s);
        }
        const head = el('div', 'bwdd-ln-head');
        if (meta.childElementCount) head.appendChild(meta);
        if (ln.title) {

            const titleHasVol = ln.volume != null && (() => {

                const t = String(ln.title).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
                return new RegExp('(^|[^0-9])' + ln.volume + '([^0-9]|$)').test(t) ||
                       new RegExp('[（(]' + ln.volume + '[）)]').test(t);
            })();
            const sub = el('div', 'bwdd-card-sub bwdd-ln-title-row',
                ln.title + (ln.volume != null && !titleHasVol ? ` · Vol. ${ln.volume}` : ''));
            head.appendChild(sub);
        }
        if (head.childElementCount) card.appendChild(head);
        const bits = [];
        if (ln.avgRating != null) {
            if (ln.ratings != null) {
                bits.push(`★ ${Number(ln.avgRating).toFixed(1)} · ${Number(ln.ratings).toLocaleString()} ratings`);
            } else if (ln.reviews != null) {
                bits.push(`★ ${Number(ln.avgRating).toFixed(1)} · ${Number(ln.reviews).toLocaleString()} reviews`);
            } else {
                bits.push(`★ ${Number(ln.avgRating).toFixed(1)}`);
            }
        }
        if (ln.reading || ln.finished) bits.push(`${ln.reading || 0} reading · ${ln.finished || 0} finished`);
        if (bits.length) {
            const social = el('div', 'bwdd-ln-social');
            for (const bit of bits) social.appendChild(el('span', null, bit));
            card.appendChild(social);
        }
        const links = el('div', 'bwdd-card-links');
        links.appendChild(cardLink(ln.bookUrl, 'Book', ln.title));
        if (ln.seriesUrl) links.appendChild(cardLink(ln.seriesUrl, 'Series', ln.title));
        card.appendChild(links);
        return card;
    }
    function renderMangaKotobaCard(mk) {
        const card = emptyCard('Manga-Kotoba');
        const v = mk && mk.volume;
        if (!v) {
            if (mk && mk.seriesUrl) {
                card.appendChild(el('p', 'bwdd-none', 'Volume pending — series cataloged.'));
                card.appendChild(cardLink(mk.seriesUrl, 'Series', 'Manga-Kotoba'));
                return card;
            }
            return null;
        }
        if (v.title) card.appendChild(el('div', 'bwdd-card-sub bwdd-mk-title', v.title));
        const grid = el('dl', 'bwdd-grid');
        const pct = String(v.usedOncePct ?? '').replace('%', '');
        const num = (x) => x != null ? Number(x).toLocaleString() : '—';
        statRow(grid, 'Total words', num(v.total), 'All words in this volume, counting repeats');
        statRow(grid, 'Unique words', num(v.unique), 'Distinct words used in this volume');
        statRow(grid, 'Used once', v.usedOnce != null ? `${num(v.usedOnce)}${pct ? ` (${pct}%)` : ''}` : '—', 'Words that appear exactly once in the volume — new-vocabulary fodder');
        statRow(grid, 'Density', v.density, 'Lexical density — share of distinct words in the text');
        card.appendChild(grid);
        const url = v.url || (mk.seriesUrl ? mk.seriesUrl + '/' : null);
        if (url) card.appendChild(cardLink(url, 'Breakdown', v.title));
        return card;
    }
    function renderStatsCards(statsEl, stats) {
        if (!stats) return;
        if (stats.mangaKotoba) upsertCard(statsEl, 'manga-kotoba', () => renderMangaKotobaCard(stats.mangaKotoba));
        if (stats.learnNatively) upsertCard(statsEl, 'natively', () => renderNativelyCard(stats.learnNatively));
    }
    function renderBookCard(statsEl, metaObj) {
        if (!statsEl) return;
        upsertCard(statsEl, 'book', () => {
            const card = emptyCard('Book Details');
            card.setAttribute('role', 'region');
            card.setAttribute('aria-label', 'Current book metadata');

            const titleEl = document.createElement('div');
            titleEl.className = 'bwdd-book-title';
            titleEl.textContent = metaObj.title || 'BookWalker Volume';
            card.appendChild(titleEl);

            const grid = document.createElement('div');
            grid.className = 'bwdd-spec-badges';

            function badge(label, value, tip) {
                const b = document.createElement('div');
                b.className = 'bwdd-spec-badge';
                if (tip) b.title = tip;
                const l = document.createElement('span');
                l.className = 'bwdd-spec-lbl';
                l.textContent = label;
                const v = document.createElement('span');
                v.className = 'bwdd-spec-val';
                v.textContent = value;
                b.append(l, v);
                return b;
            }

            if (metaObj.pages) grid.appendChild(badge('Pages', metaObj.pages, 'Number of page images in this book'));
            if (metaObj.resolution) grid.appendChild(badge('Page Size', metaObj.resolution, 'Resolution of the page images (width × height)'));
            if (metaObj.type) grid.appendChild(badge('Edition', metaObj.type, 'Whether this is a purchased edition or a sample / trial volume'));

            card.appendChild(grid);
            return card;
        });
    }

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
        } catch (_) { }
        return defaultUrl;
    })();
    const MOKURO_BRIDGE_START_URL = 'bw-mokuro-bridge://start';
    const MOKURO_BRIDGE_OFFLINE_MSG =
        'The Mokuro Bridge app is not running.\n\n' +
        'Get and start mokuro-bridge (github.com/GolyBidoof/mokuro-bridge) — its ' +
        'README shows the start command for your OS (macOS/Linux: ./run.sh from ' +
        'its folder), then click “Save and run through Mokuro” again.';

    const BRIDGE_FAIL_LIMIT = 3;
    let bridgeConsecFail = 0;

    let bridgeReachableNow = false;

    let bridgeEverReachable = false;

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
        } catch (e) { }
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

    let uploadMethods = null;
    async function fetchUploadMethods() {
        try {
            const r = await mokuroBridgeGet(MOKURO_BRIDGE_URL + '/upload-methods', 3000);
            if (r.ok) { uploadMethods = await r.json(); return uploadMethods; }
        } catch (e) {}
        return null;
    }

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

    function makeNdjsonSink(onStage, onUpload) {

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

                const err = new Error(msg.message || 'Mokuro bridge pipeline error');
                err.status = msg.status || 'bridge_error';
                throw err;
            }
        }
        return {
            processLine,
            finish() {

                if (!finalResult) throw new Error('Mokuro bridge ended the finalize stream without a terminal done frame.');

                if (finalResult.status === 'partial_upload') finalResult.partialUpload = true;
                if (uploadUrls.length) finalResult.uploadUrls = uploadUrls;
                if (storedUrl) finalResult.storedUrl = storedUrl;
                return finalResult;
            },
        };
    }

    async function readNdjsonStream(res, onStage, onUpload) {
        if (!res.body) throw new Error('No streaming response body from bridge');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const sink = makeNdjsonSink(onStage, onUpload);
        let buffer = '';

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

            if (buffer.trim()) { sink.processLine(buffer); }
            return sink.finish();
        } finally {

            clearBackgroundInterval(flushTimer);
            try { if (reader.cancel) await reader.cancel(); } catch (e) {}
        }
    }

    function readNdjsonText(text, onStage, onUpload) {
        const sink = makeNdjsonSink(onStage, onUpload);
        const lines = String(text == null ? '' : text).split('\n');
        for (const line of lines) { sink.processLine(line); }
        return sink.finish();
    }

    function makeUploadBarUpdater(bar) {
        const order = [];
        const byName = new Map();
        const rec = (name) => {
            let r = byName.get(name);
            if (!r) { r = { cur: 0, tot: 0 }; byName.set(name, r); order.push(name); }
            return r;
        };
        let seeded = false;
        let done = 0;
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

                parts.push(Math.min(done, order.length) + '/' + order.length);
            }
            parts.push(overall.toFixed(0) + '%');
            if (sumTot > 0) parts.push(fmtBytes(sumCur) + ' / ' + fmtBytes(sumTot));
            else if (ev.percent != null && ev.totalBytes > 0) parts.push(fmtBytes(ev.currentBytes || 0) + ' / ' + fmtBytes(ev.totalBytes));
            if (ev.speed && overall < 100) parts.push(ev.speed);
            setBar(bar, overall, parts.join(' · '));
        };

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

        const overwrite = typeof opts.overwrite === 'string' ? opts.overwrite.trim() : '';
        if (/^(fail|skip|overwrite)$/.test(overwrite)) fd.append('overwrite', overwrite);
        const url = bridgeSessionPath(sessionId, '/finalize');
        const res = await mokuroBridgePost(url, 3600000, fd);

        if (!res.ok) throw await bridgeError(res, 'finalize');

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

    const BWDD_UNIFIED_OUT = 'dokuha-userscript.user.js';

    const BWDD_UNIFIED_URL = 'https://greasyfork.org/en/scripts/597313-dokuha-userscript';

    const UNIFIED_CSS = `
.bwdd-unified {
  display: inline-flex; align-items: center;
  flex-shrink: 0; white-space: nowrap;
  height: 17px; padding: 0 6px;
  border: 1px solid var(--bwdd-border); border-radius: 999px;
  font-size: 10px; font-weight: 600; line-height: 1;
  color: var(--bwdd-text-muted); text-decoration: none;
}
.bwdd-unified:hover { color: var(--bwdd-link); border-color: var(--bwdd-link); background: var(--bwdd-link-hover-bg); text-decoration: none; }
.bwdd-unified:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
`;
    let unifiedStylesMounted = false;
    function mountUnifiedStyles() {
        if (unifiedStylesMounted || typeof document === 'undefined') return;
        unifiedStylesMounted = true;
        try {
            const style = document.createElement('style');
            style.textContent = UNIFIED_CSS;
            (document.head || document.documentElement).appendChild(style);
        } catch (e) {}
    }

    function unifiedDownloaderLink() {
        mountUnifiedStyles();

        const a = el('a', 'bwdd-unified', 'all-in-one downloader');
        a.href = BWDD_UNIFIED_URL;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        const tip = 'This build handles one store. One all-in-one downloader covers BookWalker, '
            + 'ebookjapan, CMOA, Kindle and k-manga in a single script (' + BWDD_UNIFIED_OUT + ') - get it here: '
            + BWDD_UNIFIED_URL;
        a.title = tip;
        a.setAttribute('aria-label', tip);
        return a;
    }

function cleanTitle(t) {
        if (!t) return '';
        let s = String(t).replace(/^【[^】]*】\s*/g, '').trim();
        s = s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim();
        return s;
    }
    function splitSeriesVolume(t) {
        let s = String(t || '').trim();
        s = s.replace(/【[^】]*】/g, '').trim();
        let volNum = null;
        let m = s.match(/(.*?)第?\s*([0-9０-９]{1,3}|[一二三四五六七八九十百]+)\s*[巻話](.*)$/);
        if (m && m[1].trim()) {
            const d = m[2].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
            volNum = /[0-9]/.test(d) ? parseInt(d, 10) : kanjiNum(d);
            s = (m[1] + ' ' + m[3]).trim();
        } else {
            m = s.match(/^(.*?)[\s　]*[：（:　]?[\s　]*[（(]?([0-9０-９]{1,3})[）)]?\s*$/);
            if (m && m[1].trim()) {
                const d = m[2].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
                volNum = parseInt(d, 10);
                s = m[1].trim();
            }
        }
        let series = s.replace(/[：:]\s*$/, '').trim();
        series = series.replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim();
        const volumeTitle = (series + ' ' + (volNum != null ? volNum : '')).trim();
        return { series, volNum, volumeTitle };
    }

    const BWDD_RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\..*)?$/i;
    function fsSafePath(name) {
        let s = cleanTitle(name);
        if (!s) return '';

        s = s.replace(/[. ]+$/, '').trim();
        if (!s || s === '.' || s === '..') return '';
        if (BWDD_RESERVED_DEVICE.test(s)) s = '_' + s;
        const cps = Array.from(s);
        if (cps.length > 190) s = cps.slice(0, 190).join('').replace(/[. ]+$/, '');
        return s;
    }

    function archiveDefaultName(rawTitle) {
        let s = String(rawTitle || '').trim();
        s = s.replace(/【[^】]*】/g, ' ');
        s = s.replace(/[ \t　]+/g, ' ').trim();
        return fsSafePath(s);
    }

    function zipBaseName(sv, fallbackTitle) {
        return fsSafePath(sv && sv.series) || fsSafePath(fallbackTitle) || 'book';
    }
    function fmtBytes(n) {
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }

    function msgZipSaved(n, size, secs) {
        return 'ZIP saved: ' + n + ' pages (' + size + ') in ' + secs + 's.';
    }
    function msgZipPartial(ok, total) {
        const missing = total - ok;
        return 'Saved ' + ok + ' of ' + total + ' pages — ' + missing +
            ' could not be fetched. Flip one page in the reader to renew credentials, then click Save as ZIP again — the missing pages resume automatically.';
    }
    function msgAllFailedZip() {
        return 'Every page failed to download — the session auth may have expired. Flip one page in the reader, then click Save as ZIP again.';
    }
    function msgOcrPartial(missing, total) {
        return missing + ' of ' + total + ' pages could not be fetched, so the volume may be incomplete. Flip one page in the reader, then run “Save and run through Mokuro” again.';
    }
    function msgStoredLocal(p) { return 'Stored locally to: ' + p; }
    function msgUploadedTo(label, p) { return 'Uploaded to ' + label + ' → ' + p; }

    function msgPartialUpload(result) {
        const detail = result && typeof result.message === 'string' ? result.message.trim() : '';
        return 'The volume files reached the destination, but the bridge could not finish the upload' +
            (detail ? ': ' + detail : '.');
    }

    function storedPathOf(result) {
        return (result && (result.output_dir || result.staging || result.remote_path)) || null;
    }
    function methodShortLabel(method) {
        const t = { mega: 'MEGA', drive: 'Google Drive', onedrive: 'OneDrive', webdav: 'WebDAV', local: 'Local' };
        return (t && t[method]) || method || '';
    }

    function webdavBaseUrl() {
        const lists = [];
        if (uploadMethods && Array.isArray(uploadMethods.methods)) lists.push(uploadMethods.methods);
        if (bridgeInfo && Array.isArray(bridgeInfo.upload_methods)) lists.push(bridgeInfo.upload_methods);
        for (const list of lists) {
            const w = list.find(m => m && m.id === 'webdav');
            const b = w && w.extra && w.extra.base_url;
            if (typeof b === 'string' && /^https?:\/\//i.test(b.trim())) return b.trim().replace(/\/+$/, '');
        }
        return '';
    }
    function storedOpenTarget(result) {
        if (!result) return null;
        const cands = [];
        const seen = new Set();
        const add = (file, url) => {
            const u = typeof url === 'string' ? url.trim() : '';
            if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
            seen.add(u);
            cands.push({ file: file || '', url: u });
        };
        for (const u of (result.uploadUrls || [])) add(u && u.file, u && u.url);
        if (Array.isArray(result.uploads)) for (const u of result.uploads) add(u && u.file, u && u.url);
        if (result.storedUrl) add('', result.storedUrl);
        if (cands.length) {
            const rank = (f) => {
                const e = String(f || '').toLowerCase();
                return e.endsWith('.cbz') ? 0 : e.endsWith('.mokuro') ? 1 : e.endsWith('.webp') ? 2 : 3;
            };
            cands.sort((a, b) => (rank(a.file) - rank(b.file)) || (a.file < b.file ? -1 : 1));
            return cands[0];
        }
        if (result.method === 'webdav') {
            const base = webdavBaseUrl();
            const folder = result.remote_path || (result.series ? 'mokuro-reader/' + result.series : '');
            const vol = String(result.title || '');
            if (base && folder && vol) {
                const enc = (s) => encodeURIComponent(s).replace(/%2F/gi, '/');
                const url = base + '/' + folder.split('/').map(enc).join('/') + '/' + enc(vol + '.cbz');
                return { file: vol + '.cbz', url };
            }
        }
        return null;
    }

let __crcTable = null;
    function crc32Bytes(buf) {
        if (!__crcTable) {
            __crcTable = new Int32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                __crcTable[n] = c;
            }
        }
        const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        let c = -1;
        for (let i = 0; i < u.length; i++) c = (c >>> 8) ^ __crcTable[(c ^ u[i]) & 0xFF];
        return (c ^ -1) >>> 0;
    }
    function dosDateTime(d) {
        return {
            t: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
            dt: (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
        };
    }
    function leU32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
    function leU16(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }
    function localHeader(nameB, crc, size, dos) {
        const h = new Uint8Array(30 + nameB.length);
        h.set(leU32(0x04034b50), 0);
        h.set(leU16(20), 4);
        h.set(leU16(0x0800), 6);
        h.set(leU16(0), 8);
        h.set(leU16(dos.t), 10);
        h.set(leU16(dos.dt), 12);
        h.set(leU32(crc), 14);
        h.set(leU32(size), 18);
        h.set(leU32(size), 22);
        h.set(leU16(nameB.length), 26);
        h.set(leU16(0), 28);
        h.set(nameB, 30);
        return h;
    }
    function centralEntry(nameB, crc, size, dos, offset) {
        const e = new Uint8Array(46 + nameB.length);
        e.set(leU32(0x02014b50), 0);
        e.set(leU16(20), 4);
        e.set(leU16(20), 6);
        e.set(leU16(0x0800), 8);
        e.set(leU16(0), 10);
        e.set(leU16(dos.t), 12);
        e.set(leU16(dos.dt), 14);
        e.set(leU32(crc), 16);
        e.set(leU32(size), 20);
        e.set(leU32(size), 24);
        e.set(leU16(nameB.length), 28);
        e.set(leU16(0), 30);
        e.set(leU16(0), 32);
        e.set(leU16(0), 34);
        e.set(leU16(0), 36);
        e.set(leU32(0), 38);
        e.set(leU32(offset), 42);
        e.set(nameB, 46);
        return e;
    }
    const enc = new TextEncoder();
    function zipEntryNumber(path) {
        const name = String(path || '').split('/').pop();
        const m = name.match(/^(\d+)(?=[ .])/) || name.match(/page-(\d+)\./i);
        return m ? Number(m[1]) : Infinity;
    }
    async function buildStoreZip(entries, onProgress) {
        const ordered = entries.slice().sort((a, b) => {
            const byPage = zipEntryNumber(a.path) - zipEntryNumber(b.path);
            return byPage || String(a.path).localeCompare(String(b.path));
        });
        const parts = [];
        const centralParts = [];
        let offset = 0;
        const base = new Date(Date.now() - ordered.length * 2000);
        for (let i = 0; i < ordered.length; i++) {
            const ent = ordered[i];
            const dos = dosDateTime(new Date(base.getTime() + i * 2000));
            const nameB = enc.encode(ent.path);
            const size = ent.blob.size;
            let crc = Number.isInteger(ent.crc) ? (ent.crc >>> 0) : null;
            if (crc === null) crc = crc32Bytes(await ent.blob.arrayBuffer());

            parts.push(localHeader(nameB, crc, size, dos), ent.blob);
            centralParts.push(centralEntry(nameB, crc, size, dos, offset));
            offset += 30 + nameB.length + size;
            if (onProgress) onProgress(i + 1, ordered.length);

            if ((i & 15) === 15) await yieldToTasks();
        }
        const cd = new Blob(centralParts);
        const cdBytes = new Uint8Array(await cd.arrayBuffer());
        const cdSize = cdBytes.length;
        const eocd = new Uint8Array(22);
        eocd.set(leU32(0x06054b50), 0);
        eocd.set(leU16(0), 4); eocd.set(leU16(0), 6);
        eocd.set(leU16(entries.length), 8); eocd.set(leU16(entries.length), 10);
        eocd.set(leU32(cdSize), 12);
        eocd.set(leU32(offset), 16);
        eocd.set(leU16(0), 20);
        parts.push(cd, eocd);
        return new Blob(parts, { type: 'application/zip' });
    }

    const bwddTheme = (() => {
        let scheme = 'light';
        let started = false;
        let styleEl = null;
        const subscribers = [];

        function mql(pref) {
            try {
                if (typeof window.matchMedia !== 'function') return null;
                return window.matchMedia('(prefers-color-scheme: ' + pref + ')');
            } catch (e) { return null; }
        }
        function readScheme() {

            const dark = mql('dark');
            if (dark && dark.matches) return 'dark';
            const light = mql('light');
            if (light && light.matches) return 'light';
            return 'light';
        }
        function publish() {
            try {
                if (document.documentElement) document.documentElement.setAttribute('data-bwdd-theme', scheme);
            } catch (e) {}
            for (const fn of subscribers) { try { fn(scheme); } catch (e) {} }
        }
        function gateStyle() {

            if (!styleEl) return;
            const host = (typeof document !== 'undefined' && (document.head || document.documentElement)) || null;
            if (!host) return;
            const connected = typeof styleEl.isConnected === 'boolean' ? styleEl.isConnected : !!styleEl.parentNode;
            const dark = scheme === 'dark';
            try {
                if (dark && !connected) host.appendChild(styleEl);
                else if (!dark && connected && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
            } catch (e) {}
        }
        function onMediaChange() {
            const next = readScheme();
            if (next === scheme) return;
            scheme = next;
            gateStyle();
            publish();
            if (BWDD_DEBUG) { try { console.info('[bwdd] light/dark scheme:', scheme); } catch (e) {} }
        }
        return {
            start() {
                if (started) return scheme;
                started = true;
                scheme = readScheme();
                publish();
                const dark = mql('dark');
                const light = mql('light');
                const attach = (mq) => {
                    if (!mq) return;
                    const fn = () => onMediaChange();
                    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', fn);
                    else if (typeof mq.addListener === 'function') mq.addListener(fn);
                };
                attach(dark); attach(light);
                if (BWDD_DEBUG) { try { console.info('[bwdd] light/dark scheme:', scheme); } catch (e) {} }
                return scheme;
            },
            get current() { return scheme; },
            isDark() { return scheme === 'dark'; },
            onChange(fn) {
                if (typeof fn === 'function') subscribers.push(fn);
                if (started) { try { fn(scheme); } catch (e) {} }
            },
            attachStyle(el) {
                styleEl = el;
                gateStyle();
            },
        };
    })();
    try { bwddTheme.start(); } catch (e) {}
    try {
        console.info('[bwdd] ' + sitePanelTitle() + ' v' + BWDD_VERSION + ' loaded, image codec: ' +
            IMAGE_CODEC.fmt + (IMAGE_CODEC.lossless ? ' (lossless)' : ' q' + IMAGE_CODEC.quality) +
            ', extension .' + IMAGE_CODEC.ext);
    } catch (e) {}
    if (BWDD_DEBUG) { try { window.__bwddTheme = bwddTheme; } catch (e) {} }

    let __bwddCssInjected = false;
    function injectStyles() {
        if (__bwddCssInjected) return;
        __bwddCssInjected = true;

        const font = document.createElement('link');
        font.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap';
        font.rel = 'stylesheet';
        document.head.appendChild(font);

        const css = document.createElement('style');
        css.textContent = `
#bwdd-root {
  --bwdd-accent-fill: #1d4ed8;
  --bwdd-amber-fill: #fcd9a8;
  --bwdd-bg: #ffffff;
  --bwdd-bg-ctrl: #f1f5f9;
  --bwdd-bg-ctrl-hover: #e2e8f0;
  --bwdd-bg-hover: #f1f5f9;
  --bwdd-bg-sunken: #f8fafc;
  --bwdd-border: #e2e8f0;
  --bwdd-border-soft: #f1f5f9;
  --bwdd-border-strong: #cbd5e1;
  --bwdd-code-bg: #f8fafc;
  --bwdd-danger: #b91c1c;
  --bwdd-danger-bg: #fef2f2;
  --bwdd-danger-border: #fecaca;
  --bwdd-glow-offline: 0 0 6px rgba(220, 38, 38, 0.45);
  --bwdd-glow-online: 0 0 6px rgba(21, 128, 61, 0.4);
  --bwdd-icon: #64748b;
  --bwdd-link: #1d4ed8;
  --bwdd-link-hover: #1e40af;
  --bwdd-link-hover-bg: rgba(29, 78, 216, 0.06);
  --bwdd-offline: #dc2626;
  --bwdd-root-fg: #0f172a;
  --bwdd-success: #15803d;
  --bwdd-success-dot: #15803d;
  --bwdd-text: #1e293b;
  --bwdd-text-ctrl: #334155;
  --bwdd-text-faint: #64748b;
  --bwdd-text-fainter: #94a3b8;
  --bwdd-text-muted: #475569;
  --bwdd-text-soft: #334155;
  --bwdd-text-strong: #0f172a;
  --bwdd-title: #1e293b;
  --bwdd-warn-bg: #fffbeb;
  --bwdd-warn-border: #fde68a;
  --bwdd-warn-code-bg: #fef9c3;
  --bwdd-warn-text: #92400e;
  --bwdd-caps-on-bg: #ecfdf5;
  --bwdd-caps-on-border: #a7f3d0;
  --bwdd-caps-on-text: #065f46;
  --bwdd-caps-on-strong: #064e3b;
  --bwdd-caps-off-bg: #f8fafc;
  --bwdd-caps-off-border: #e2e8f0;
  --bwdd-busy: #d97706;   /* amber, bridge busy (OCR/upload) */
  --bwdd-glow-busy: 0 0 6px rgba(217, 119, 6, 0.45);
  --bwdd-white: #ffffff;

  position: fixed;
  top: 16px;
  right: 24px;   /* room to grow leftward when the stats column mounts */
  z-index: 2147483647;
  width: 400px;   /* single-column default; widens to 640px once the stats column mounts */
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 32px);
  min-height: 0;
  background: var(--bwdd-bg);
  color: var(--bwdd-root-fg);
  border-radius: 14px;
  border: 1px solid var(--bwdd-border);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.04);
  font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  line-height: 1.4;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
  transition: height 0.2s ease, opacity 0.15s ease, width 0.25s ease, transform 0.25s ease;
}
#bwdd-root * { box-sizing: border-box; }
/* A store page's own font rules land directly on the panel's divs, so a leaf
   rule like .bwdd-btn { font-family: inherit } picks up the shop's font
   (Meiryo on CMOA) instead of ours. Make the whole subtree inherit from
   #bwdd-root; the only deliberate exception is monospace for code/pre. */
#bwdd-root *:not(code):not(pre):not(kbd):not(samp) { font-family: inherit; }
#bwdd-root.collapsed { height: auto !important; max-height: none !important; }
#bwdd-root.collapsed .bwdd-body { display: none; }
#bwdd-root.bwdd-stats-visible { width: 640px; }   /* two-column width, once there is a stats column to show */
@media (prefers-reduced-motion: reduce) {
  #bwdd-root, #bwdd-root *, .bwdd-btn, .bwdd-bar-fill { transition: none !important; }
}

/* Header with Drag Handle */
.bwdd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 10px 10px 12px;
  background: var(--bwdd-bg);
  border-bottom: 1px solid var(--bwdd-border-soft);
  cursor: grab;
  touch-action: none;
}
.bwdd-head:active { cursor: grabbing; }
.bwdd-title-group { display: flex; flex-direction: column; min-width: 0; }
.bwdd-title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--bwdd-title);
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.2;
}
.bwdd-title .bwdd-icon { font-size: 14px; }
.bwdd-title-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.bwdd-subtitle {
  font-size: 11px;
  color: var(--bwdd-text-muted);
  font-weight: 500;
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 0 1 auto;   /* natural width, the GitHub link sits right after the text */
  min-width: 0;
}
.bwdd-gh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 17px;
  height: 17px;
  border-radius: 5px;
  color: var(--bwdd-text-muted);
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.bwdd-gh svg { width: 12px; height: 12px; fill: currentColor; display: block; }
.bwdd-gh:hover { color: var(--bwdd-link); background: var(--bwdd-link-hover-bg); }
.bwdd-gh:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
/* The shared script mark: a small, quiet link home beside the version line. */
.bwdd-mark {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 10px;
  font-weight: 600;
  color: var(--bwdd-text-muted);
  text-decoration: none;
  padding: 0 2px;
}
.bwdd-mark:hover { color: var(--bwdd-link); text-decoration: underline; }
.bwdd-mark:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
.bwdd-head-controls { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.bwdd-ctrl-btn {
  background: transparent;
  border: none;
  color: var(--bwdd-text-muted);
  font-size: 15px;
  line-height: 1;
  min-width: 32px;
  min-height: 32px;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.bwdd-ctrl-btn:hover { background: var(--bwdd-bg-hover); color: var(--bwdd-text-strong); }
.bwdd-ctrl-btn:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 2px; }
.bwdd-ctrl-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Scrollable Body */
.bwdd-body {
  padding: 10px 12px 12px;
  overflow: hidden;
  display: flex;
  flex-direction: row;
  gap: 10px;
  background: var(--bwdd-bg);
  user-select: text;
  flex: 1 1 auto;
  min-height: 0;
}
.bwdd-col { min-height: 0; }   /* allow the scrollable columns to shrink when the panel is resized vertically */
.bwdd-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.bwdd-col-stats {
  flex: 0 0 250px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.bwdd-col-main {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* Hairline between the controls column and the reading-stats column. It is
   appended together with the stats column, so it only exists once stats do. */
.bwdd-col-sep {
  flex: 0 0 auto;
  align-self: stretch;
  width: 1px;
  margin: 2px 0;
  background: var(--bwdd-border);
}
@media (max-width: 660px) {
  .bwdd-body { flex-direction: column; overflow-y: auto; }
  .bwdd-col-sep { display: none; }
  .bwdd-col-stats, .bwdd-col-main { flex: none; width: 100%; overflow: visible; }
}

/* Bridge Health Indicator */
.bwdd-bridge-pill {
  font-size: 11px;
  color: var(--bwdd-text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px;
  min-height: 24px;
}
.bwdd-indicator-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bwdd-text-fainter);
  display: inline-block;
  flex-shrink: 0;
}
.bwdd-indicator-dot.online { background: var(--bwdd-success-dot); box-shadow: var(--bwdd-glow-online); }

/* "What is the Mokuro Bridge?" help dot + toggleable infobox */
.bwdd-info-dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--bwdd-border-strong);
  background: var(--bwdd-bg-sunken);
  color: var(--bwdd-icon);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  padding: 0;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.bwdd-info-dot:hover,
.bwdd-info-dot:focus-visible,
.bwdd-info-dot[aria-expanded="true"] {
  background: var(--bwdd-accent-fill);
  border-color: var(--bwdd-accent-fill);
  color: var(--bwdd-white);
}
.bwdd-info-dot:focus-visible { outline: 2px solid rgba(29, 78, 216, 0.4); outline-offset: 1px; }
/* "mokuro missing" alert (below the bridge row) + mokuro detail line in the info box */
.bwdd-mokuro-alert {
  margin: 2px 0 6px;
  padding: 7px 9px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--bwdd-danger);
  background: var(--bwdd-danger-bg);
  border: 1px solid var(--bwdd-danger-border);
  border-radius: 8px;
}
.bwdd-mokuro-alert:empty { display: none; }
.bwdd-indicator-dot.offline {
  background: var(--bwdd-offline);
  box-shadow: var(--bwdd-glow-offline);
}
.bwdd-indicator-dot.busy {
  background: var(--bwdd-busy);
  box-shadow: var(--bwdd-glow-busy);
}
.bwdd-bridge-info-mokuro {
  display: block;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--bwdd-success);
}
.bwdd-bridge-info-mokuro.missing { color: var(--bwdd-danger); }
/* The bridge "?" infobox is positioned as an overlay popover (see the shared
   .bwdd-name-pop / .bwdd-bridge-pop box below); this anchor keeps it glued to
   the bridge status row it belongs to. */
.bwdd-bridge-anchor { position: relative; }
.bwdd-bridge-info-title {
  display: block;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--bwdd-text-muted);
  margin-bottom: 7px;
}
.bwdd-bridge-info-section { display: block; }
.bwdd-bridge-info-subhead {
  display: block;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--bwdd-text-muted);
  margin-bottom: 2px;
}
.bwdd-bridge-info-divider {
  border: none;
  border-top: 1px solid var(--bwdd-border);
  margin: 7px 0;
}
.bwdd-bridge-info-body { display: block; }
.bwdd-bridge-info-link {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--bwdd-link);
  text-decoration: none;
  font-weight: 600;
  font-size: 11px;
  line-height: 1.5;
  border: 1px solid currentColor;
  border-radius: 6px;
  padding: 4px 8px;
  min-height: 24px;
  white-space: nowrap;
}
.bwdd-bridge-info-link:hover { text-decoration: underline; background: var(--bwdd-link-hover-bg); }
.bwdd-bridge-info-link:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 2px; }

/* Progress Bars */
.bwdd-bars {
  display: none;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: var(--bwdd-bg-sunken);
  border: 1px solid var(--bwdd-border);
  border-radius: 10px;
}
.bwdd-bar-row { display: none; flex-direction: column; gap: 3px; }
.bwdd-bar-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--bwdd-text-muted);
}
.bwdd-bar-rate { font-variant-numeric: tabular-nums; color: var(--bwdd-text-strong); }
.bwdd-bar-track {
  position: relative;
  height: 6px;
  background: var(--bwdd-border);
  border-radius: 999px;
  overflow: hidden;
}
.bwdd-bar-fill,
.bwdd-bar-fill-bg {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  width: 0%;
  border-radius: 999px;
  transition: width 0.2s ease;
}
.bwdd-bar-fill { z-index: 2; }
.bwdd-bar-fill-bg {
  z-index: 1;
  background: var(--bwdd-amber-fill);   /* faint amber, pages received, not yet OCR'd */
}
.bwdd-bar-legend {
  font-size: 10px;
  line-height: 1.4;
  color: var(--bwdd-text-faint);
  margin-top: 1px;
}

/* Cards & Badges, compact, LearnNatively / Manga-Kotoba inspired */
.bwdd-cards { display: flex; flex-direction: column; gap: 8px; }
.bwdd-cards:empty { display: none; }
.bwdd-card {
  border: 1px solid var(--bwdd-border);
  background: var(--bwdd-bg);
  border-radius: 10px;
  padding: 8px 10px;
}
.bwdd-card h3 {
  margin: 0 0 5px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--bwdd-text-muted);
  line-height: 1.3;
}
.bwdd-card[data-card="book"] {
  background: var(--bwdd-bg-sunken);
  border-color: var(--bwdd-border-strong);
}
.bwdd-book-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--bwdd-text-strong);
  margin-bottom: 5px;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.bwdd-spec-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.bwdd-spec-badges:empty { display: none; }
.bwdd-spec-badge {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-size: 11px;
  background: var(--bwdd-bg);
  border: 1px solid var(--bwdd-border);
  border-radius: 6px;
  padding: 1px 6px;
  line-height: 1.5;
}
.bwdd-spec-lbl { color: var(--bwdd-text-muted); font-weight: 500; }
.bwdd-spec-val { color: var(--bwdd-text-strong); font-weight: 600; font-variant-numeric: tabular-nums; }

.bwdd-card-sub { font-size: 11px; font-weight: 600; color: var(--bwdd-text); margin-bottom: 4px; line-height: 1.35; }
.bwdd-lvl-cap { font-size: 10px; color: var(--bwdd-text-muted); font-weight: 500; }

/* Compact stat rows (shared LN + MK) */
.bwdd-grid {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 1px 10px;
  font-size: 11px;
  margin: 2px 0 4px;
}
.bwdd-grid dt { color: var(--bwdd-text-muted); font-weight: 500; line-height: 1.6; }
.bwdd-grid dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--bwdd-title); line-height: 1.6; }

.bwdd-card-links { display: flex; gap: 6px; margin-top: 6px; font-size: 11px; }
.bwdd-link {
  color: var(--bwdd-link);
  text-decoration: none;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid currentColor;
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  line-height: 1.5;
  min-height: 24px;
}
.bwdd-card-links .bwdd-link { flex: 1; text-align: center; }
.bwdd-link:hover { text-decoration: underline; background: var(--bwdd-link-hover-bg); }
.bwdd-link:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 2px; }

.bwdd-nlvl-pill {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border-radius: 6px;
  padding: 2px 9px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  line-height: 1.5;
  min-height: 22px;
}
/* LearnNatively card: warm cream body, brown text, teal links */
.bwdd-card[data-card="natively"] {
  background: #faf6ee;
  border-color: #e8ddc9;
  color: #3f3227;
  box-shadow: none;
}
.bwdd-card[data-card="natively"] h3 { color: #8a6d3b; }
.bwdd-card[data-card="natively"] .bwdd-card-sub { color: #3f3227; }
.bwdd-card[data-card="natively"] .bwdd-lvl-cap { color: #6f5f4d; }
.bwdd-card[data-card="natively"] .bwdd-link { color: #0f766e; border-color: #0f766e; }
.bwdd-card[data-card="natively"] .bwdd-link:hover { background: rgba(15, 118, 110, 0.08); }
.bwdd-card[data-card="natively"] .bwdd-link:focus-visible { outline-color: #0f766e; }
.bwdd-ln-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.bwdd-ln-title-row {
  display: block;
  flex: 1 1 160px;
  min-width: 0;
  margin-bottom: 0;
  line-height: 1.45;
}
.bwdd-ln-meta {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0;
  flex: 0 0 auto;
}
.bwdd-ln-social {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 3px 16px;
  border-top: 1px solid #e8ddc9;
  padding-top: 6px;
  margin: 6px 0 0;
  line-height: 1.7;
  font-size: 11px;
  color: #6f5f4d;
  text-align: left;
}
/* Manga-Kotoba card: plain white body, sage text, hairline ledger rows */
.bwdd-card[data-card="manga-kotoba"] {
  background: #ffffff;
  border-color: #dfe3d2;
  color: #243b2a;
  box-shadow: none;
}
.bwdd-card[data-card="manga-kotoba"] h3 { color: #6b5d2e; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid { margin-bottom: 2px; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dt,
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dd {
  padding: 1px 0;
  border-bottom: 1px solid #edf0e3;
}
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dt { color: #5b6650; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dd { color: #243b2a; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link { color: #3f6212; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link:hover { background: rgba(63, 98, 18, 0.07); }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link:focus-visible { outline-color: #3f6212; }
.bwdd-mk-title {
  display: block;
  text-align: center;
  margin-bottom: 2px;
}
.bwdd-lnbadge {
  display: inline-block;
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 5px;
  color: var(--bwdd-text-muted);
  font-size: 10px;
  font-weight: 700;
  padding: 0 5px;
  line-height: 1.6;
}
.bwdd-none { font-size: 11px; color: var(--bwdd-text-muted); margin: 0 0 6px; line-height: 1.5; text-align: center; }

/* Action Buttons */
.bwdd-actions { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }

/* Upload destination picker */
.bwdd-dest {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 6px;
  padding: 8px 10px;
  background: var(--bwdd-bg-sunken);
  border: 1px solid var(--bwdd-border);
  border-radius: 10px;
}
.bwdd-dest-label { font-size: 11px; font-weight: 600; color: var(--bwdd-text-muted); }
.bwdd-opt-row { display: flex; align-items: center; gap: 6px; }
.bwdd-opt-row > * { flex: 1 1 0; min-width: 0; }
.bwdd-opt-row > .bwdd-dest-label { flex: 0 0 auto; white-space: nowrap; }
/* Pre-flight numbers, shown inside the bridge row's "?" popover. */
.bwdd-caps-line {
  display: block;
  font-weight: 600;
  color: var(--bwdd-text-strong);
  margin: 2px 0 4px;
}
.bwdd-bridge-info-section.on .bwdd-caps-line { color: var(--bwdd-caps-on-strong); }
.bwdd-caps-note { font-size: 10px; color: var(--bwdd-text-faint); }
/* Advanced image settings, collapsed so they stay out of the way. */
.bwdd-fmt { margin-top: 8px; }
.bwdd-fmt-summary {
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  color: var(--bwdd-text-muted);
  padding: 3px 2px;
  border-radius: 4px;
}
.bwdd-fmt-summary:hover { color: var(--bwdd-link); }
.bwdd-fmt-summary:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
.bwdd-fmt[open] > .bwdd-fmt-summary { margin-bottom: 2px; }

/* The panel's own form controls must look the same on every store. A shop's
   stylesheet lands on bare input/select/textarea elements, and exactly which
   properties it touches differs per store, so this is a scoped reset rather
   than a list tuned to one leak: every property a host page realistically sets
   is pinned once for the whole panel subtree. The #bwdd-root prefix outranks a
   page selector that is an element, a class, or an element plus an attribute,
   so a host rule only wins with !important, which no store stylesheet uses for
   generic form controls. The prefix is also what keeps the reset off the host
   page's own fields. */
#bwdd-root input,
#bwdd-root select,
#bwdd-root textarea {
  box-sizing: border-box;
  height: auto;
  min-height: 0;
  max-height: none;
  margin: 0;
  padding: 5px 7px;
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 6px;
  background: var(--bwdd-bg);
  color: var(--bwdd-root-fg);
  font-family: inherit;
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
  line-height: 1.4;
  letter-spacing: normal;
  text-transform: none;
  text-indent: 0;
  vertical-align: middle;
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
}
/* appearance: none would take the native dropdown affordance with it, and the
   panel draws no caret of its own, so a select keeps the platform control. */
#bwdd-root select { appearance: auto; -webkit-appearance: auto; }
#bwdd-root input:focus-visible,
#bwdd-root select:focus-visible,
#bwdd-root textarea:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
.bwdd-dest-localdir { display: flex; flex-direction: column; gap: 3px; }
.bwdd-dest-hint { font-size: 11px; color: var(--bwdd-warn-text); background: var(--bwdd-warn-bg); border: 1px solid var(--bwdd-warn-border); border-radius: 6px; padding: 5px 7px; line-height: 1.4; }
.bwdd-dest-hint code { font-family: ui-monospace, monospace; font-size: 10px; background: var(--bwdd-warn-code-bg); border-radius: 3px; padding: 0 3px; }
/* Archive-name field (above the action buttons): one compact row of label,
   input and "?" info dot; the popover it opens overlays the buttons below. */
.bwdd-name {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
}
.bwdd-name .bwdd-dest-label { flex: 0 0 auto; }
/* Higher specificity than the subtree reset above, so the name field keeps its
   compact row sizing (natural width, tighter vertical padding). */
#bwdd-root .bwdd-name .bwdd-dest-input { flex: 1 1 auto; width: auto; min-width: 0; padding-top: 4px; padding-bottom: 4px; }
.bwdd-name .bwdd-info-dot {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  min-width: 18px;
  min-height: 18px;
  font-size: 10px;
}
/* "?" popovers (archive-name field + Mokuro Bridge info): one shared overlay
   look. Each popover is absolutely positioned under its own row (its anchor
   sets position:relative) and overlays whatever sits below, so opening one
   never takes layout space or pushes content around. */
.bwdd-name-pop,
.bwdd-bridge-pop {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 8;
  width: 300px;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 9px 11px;
  background: var(--bwdd-bg);
  color: var(--bwdd-text-soft);
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 8px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18), 0 2px 6px rgba(15, 23, 42, 0.08);
  font-size: 11px;
  line-height: 1.5;
}
.bwdd-name-pop > div + div { margin-top: 5px; }
.bwdd-name-pop[hidden], .bwdd-bridge-pop[hidden] { display: none; }
.bwdd-btn-fill {
  flex: 0 0 auto;
  font: 600 11px inherit;
  padding: 5px 8px;
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 6px;
  background: var(--bwdd-bg-ctrl);
  color: var(--bwdd-text-ctrl);
  cursor: pointer;
  white-space: nowrap;
}
.bwdd-btn-fill:hover { background: var(--bwdd-bg-ctrl-hover); }
.bwdd-btn-fill:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
.bwdd-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 8px 12px;
  min-height: 44px;
  border: none;
  border-radius: 10px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--bwdd-white);
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s;
}
.bwdd-btn-sub {
  font-size: 11px;
  font-weight: 400;
  opacity: 0.9;
  margin-top: 1px;
}
.bwdd-btn > span { text-align: center; width: 100%; }
.bwdd-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}
.bwdd-btn:active:not(:disabled) { transform: translateY(0); }
.bwdd-btn:focus-visible { outline: 2px solid var(--bwdd-root-fg); outline-offset: 2px; }
.bwdd-btn:disabled { opacity: 0.6; cursor: not-allowed; }
@media (forced-colors: active) {
  .bwdd-btn, .bwdd-nlvl-pill { forced-color-adjust: none; }
}

.bwdd-btn.zip {
  background: linear-gradient(135deg, #15803d 0%, #166534 100%);
  box-shadow: 0 4px 12px rgba(22, 101, 52, 0.25);
}
.bwdd-btn.zip:hover:not(:disabled) {
  box-shadow: 0 6px 16px rgba(22, 101, 52, 0.35);
}
.bwdd-btn.ocr {
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);
}
.bwdd-btn.ocr:hover:not(:disabled) {
  box-shadow: 0 6px 16px rgba(37, 99, 235, 0.35);
}

/* Destination section dimmed while a run holds the lock */
.bwdd-dest-locked { opacity: 0.7; }

/* "Open Reader Mokuro" + open-file/copy, one quiet row, only after a
   successful OCR run. Both are secondary actions, so they share a calm
   outline-button look instead of loud filled gradients. */
.bwdd-reader-row {
  display: none;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 6px;
  margin-top: 6px;
}
/* The quiet outline button is a component, not a child of one row. Only the
   row's own sizing stays scoped there. */
.bwdd-ghost-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 10px;
  min-height: 30px;
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 8px;
  background: var(--bwdd-bg);
  color: var(--bwdd-text-muted);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.bwdd-reader-row > .bwdd-ghost-btn {
  min-width: 0;
  width: 100%;
}
.bwdd-ghost-btn:hover {
  background: var(--bwdd-bg-sunken);
  color: var(--bwdd-link);
  border-color: var(--bwdd-link);
}
.bwdd-ghost-btn:focus-visible {
  outline: 2px solid var(--bwdd-link);
  outline-offset: 1px;
}

.bwdd-hint-box {
  font-size: 11px;
  color: var(--bwdd-text-muted);
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.45;
}
.bwdd-hint-box:empty { display: none; }
/* Collapsible raw-error block inside the status area (see setRunDetails) */
.bwdd-hint-box details { margin-top: 6px; }
.bwdd-hint-box summary {
  cursor: pointer;
  color: var(--bwdd-link);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.bwdd-hint-box summary:hover { color: var(--bwdd-link-hover); }
.bwdd-hint-box pre {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: var(--bwdd-code-bg);
  border: 1px solid var(--bwdd-border);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--bwdd-text-muted);
  max-height: 140px;
  overflow: auto;
}
/* Panel flapped away to the right, an edge tab stays to bring it back */
#bwdd-root.bwdd-flapped { pointer-events: none; }
.bwdd-edge-tab {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2147483647;
  display: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 76px;
  padding: 0;
  border: none;
  border-radius: 10px 0 0 10px;
  background: #1d4ed8;
  color: #ffffff;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  box-shadow: -3px 0 10px rgba(15, 23, 42, 0.18);
  transition: background 0.15s;
}
.bwdd-edge-tab:hover { background: #2563eb; }
.bwdd-edge-tab:focus-visible { outline: 2px solid #1d4ed8; outline-offset: -2px; }
/* Header drag grip + corner resize handle */
.bwdd-drag-grip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: stretch;
  width: 16px;
  color: var(--bwdd-text-fainter);
  font-size: 11px;
  line-height: 1;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.bwdd-drag-grip:active { cursor: grabbing; }
.bwdd-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 22px;
  height: 22px;
  z-index: 6;
  cursor: nwse-resize;   /* corner: resize both width and height */
  touch-action: none;
  user-select: none;
}
.bwdd-resize::after {
  content: '';
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 9px;
  height: 9px;
  border-right: 2px solid var(--bwdd-text-fainter);
  border-bottom: 2px solid var(--bwdd-text-fainter);
  border-bottom-right-radius: 3px;
  opacity: 0.65;
  transition: opacity 0.15s;
}
.bwdd-resize:hover::after,
.bwdd-resize:active::after { opacity: 1; }
#bwdd-root.collapsed .bwdd-resize,
#bwdd-root.bwdd-flapped .bwdd-resize { display: none; }

`;
        (document.head || document.documentElement).appendChild(css);

        const darkCss = document.createElement('style');
        darkCss.textContent = `
#bwdd-root {
  --bwdd-accent-fill: #3b82f6;
  --bwdd-amber-fill: rgba(245, 158, 11, 0.22);
  --bwdd-bg: #0f172a;
  --bwdd-bg-ctrl: #334155;
  --bwdd-bg-ctrl-hover: #475569;
  --bwdd-bg-hover: #1e293b;
  --bwdd-bg-sunken: #1e293b;
  --bwdd-border: #334155;
  --bwdd-border-soft: #1e293b;
  --bwdd-border-strong: #475569;
  --bwdd-code-bg: #0f172a;
  --bwdd-danger: #f87171;
  --bwdd-danger-bg: rgba(127, 29, 29, 0.28);
  --bwdd-danger-border: #7f1d1d;
  --bwdd-glow-offline: 0 0 6px rgba(248, 113, 113, 0.4);
  --bwdd-glow-online: 0 0 6px rgba(34, 197, 94, 0.45);
  --bwdd-icon: #cbd5e1;
  --bwdd-link: #60a5fa;
  --bwdd-link-hover: #93c5fd;
  --bwdd-link-hover-bg: rgba(96, 165, 250, 0.12);
  --bwdd-offline: #f87171;
  --bwdd-root-fg: #e2e8f0;
  --bwdd-success: #4ade80;
  --bwdd-success-dot: #22c55e;
  --bwdd-text: #e2e8f0;
  --bwdd-text-ctrl: #e2e8f0;
  --bwdd-text-faint: #94a3b8;
  --bwdd-text-fainter: #64748b;
  --bwdd-text-muted: #94a3b8;
  --bwdd-text-soft: #cbd5e1;
  --bwdd-text-strong: #f1f5f9;
  --bwdd-title: #f1f5f9;
  --bwdd-warn-bg: rgba(251, 191, 36, 0.12);
  --bwdd-warn-border: rgba(251, 191, 36, 0.35);
  --bwdd-warn-code-bg: rgba(251, 191, 36, 0.25);
  --bwdd-warn-text: #fcd34d;
  --bwdd-caps-on-bg: rgba(16, 185, 129, 0.14);
  --bwdd-caps-on-border: rgba(16, 185, 129, 0.38);
  --bwdd-caps-on-text: #6ee7b7;
  --bwdd-caps-on-strong: #a7f3d0;
  --bwdd-caps-off-bg: #1e293b;
  --bwdd-caps-off-border: #334155;
  --bwdd-busy: #f59e0b;
  --bwdd-glow-busy: 0 0 6px rgba(245, 158, 11, 0.5);
  --bwdd-white: #ffffff;
  background: var(--bwdd-bg);
  color: var(--bwdd-root-fg);
  border-color: var(--bwdd-border);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.35);
  color-scheme: dark;
}

/* LearnNatively card, dark variant: warm espresso surfaces with cream text.
   The difficulty level rectangles (.bwdd-nlvl-pill) are deliberately NOT
   restyled here, their semantic colors are set inline by JS and already
   read correctly on the dark card. */
.bwdd-card[data-card="natively"] {
  background: #201a12;
  border-color: #463a27;
  color: #e9dcbf;
  box-shadow: none;
}
.bwdd-card[data-card="natively"] h3 { color: #cfa95f; }
.bwdd-card[data-card="natively"] .bwdd-card-sub { color: #f0e6d2; }
.bwdd-card[data-card="natively"] .bwdd-lvl-cap { color: #bfa97f; }
.bwdd-card[data-card="natively"] .bwdd-lnbadge {
  border-color: #574832;
  background: #2a2319;
  color: #d5c5a6;
}
.bwdd-card[data-card="natively"] .bwdd-link { color: #2dd4bf; border-color: #2dd4bf; }
.bwdd-card[data-card="natively"] .bwdd-link:hover { background: rgba(45, 212, 191, 0.12); }
.bwdd-card[data-card="natively"] .bwdd-link:focus-visible { outline-color: #2dd4bf; }
.bwdd-card[data-card="natively"] .bwdd-ln-social {
  border-top-color: #4a3d2a;
  color: #c8b896;
}


/* Manga-Kotoba card, dark variant: deep sage ink with sage/cream text. */
.bwdd-card[data-card="manga-kotoba"] {
  background: #131a14;
  border-color: #2e3f33;
  color: #d9e4da;
  box-shadow: none;
}
.bwdd-card[data-card="manga-kotoba"] h3 { color: #cfbf7a; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-card-sub { color: #e6efe7; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dt,
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dd {
  border-bottom-color: #283a2f;
}
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dt { color: #9db3a1; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dd { color: #e2ebe3; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link { color: #84cc16; border-color: #84cc16; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link:hover { background: rgba(132, 204, 22, 0.14); }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link:focus-visible { outline-color: #84cc16; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-none { color: #a9bcab; }
.bwdd-dest-select:focus-visible, .bwdd-dest-input:focus-visible,
.bwdd-btn-fill:focus-visible { outline-color: #60a5fa; }
.bwdd-hint-box summary { color: #60a5fa; }
.bwdd-hint-box summary:hover { color: #93c5fd; }
.bwdd-hint-box pre { background: #0f172a; border-color: #334155; color: #94a3b8; }
/* Edge restore tab (dark) */
.bwdd-edge-tab { background: #3b82f6; color: #ffffff; box-shadow: -3px 0 10px rgba(0, 0, 0, 0.4); }
.bwdd-edge-tab:hover { background: #60a5fa; }
.bwdd-edge-tab:focus-visible { outline-color: #60a5fa; }
/* Quiet reader/stored row (dark), colors come from --bwdd-* tokens */
.bwdd-ghost-btn { background: var(--bwdd-bg); color: var(--bwdd-text-muted); border-color: var(--bwdd-border-strong); }
.bwdd-ghost-btn:hover { background: var(--bwdd-bg-sunken); color: var(--bwdd-link); border-color: var(--bwdd-link); }

`;
        (document.head || document.documentElement).appendChild(darkCss);
        bwddTheme.attachStyle(darkCss);
    }

const PANEL_POS_KEY = 'bwdd-panel-pos';
    const PANEL_COLLAPSED_KEY = 'bwdd-panel-collapsed';
    const PANEL_WIDTH_KEY = 'bwdd-panel-width';
    const PANEL_HEIGHT_KEY = 'bwdd-panel-height';

    function buildUI() {
        injectStyles();
        const root = document.createElement('section');
        root.id = 'bwdd-root';

        root.setAttribute('role', 'region');
        root.setAttribute('aria-labelledby', 'bwdd-panel-title');

        const head = document.createElement('div');
        head.className = 'bwdd-head';
        head.setAttribute('title', 'Drag to reposition');

        const titleGroup = document.createElement('div');
        titleGroup.className = 'bwdd-title-group';

        const title = document.createElement('h2');
        title.id = 'bwdd-panel-title';
        title.className = 'bwdd-title';
        title.innerHTML = '<span class="bwdd-icon" aria-hidden="true">📖</span> ' + sitePanelTitle();

        const titleSub = document.createElement('div');
        titleSub.className = 'bwdd-title-sub';

        const sub = document.createElement('div');
        sub.className = 'bwdd-subtitle';
        sub.textContent = `v${BWDD_VERSION} by ${BWDD_AUTHOR}`;

        const ghLink = document.createElement('a');
        ghLink.className = 'bwdd-gh';
        ghLink.href = BWDD_REPO_URL;
        ghLink.target = '_blank';
        ghLink.rel = 'noopener noreferrer';
        ghLink.setAttribute('aria-label', 'Open the GitHub repository in a new tab');
        ghLink.title = 'GitHub repository: ' + BWDD_REPO_URL;
        ghLink.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
        const mark = document.createElement('a');
        mark.className = 'bwdd-mark';
        mark.href = BWDD_REPO_URL;
        mark.target = '_blank';
        mark.rel = 'noopener noreferrer';
        mark.textContent = BWDD_SCRIPT_NAME;
        mark.title = BWDD_SCRIPT_NAME + ' \u2014 the combined downloader: ' + BWDD_REPO_URL;
        mark.setAttribute('aria-label', 'Open the ' + BWDD_SCRIPT_NAME + ' repository in a new tab');
        titleSub.append(sub, mark, ghLink);

        if (typeof unifiedDownloaderLink === 'function') {
            const unified = unifiedDownloaderLink();
            if (unified) titleSub.appendChild(unified);
        }
        titleGroup.append(title, titleSub);

        const ctrlGroup = document.createElement('div');
        ctrlGroup.className = 'bwdd-head-controls';

        const minBtn = document.createElement('button');
        minBtn.type = 'button';
        minBtn.className = 'bwdd-ctrl-btn';
        minBtn.setAttribute('aria-label', 'Minimize panel');
        minBtn.setAttribute('aria-expanded', 'true');
        minBtn.setAttribute('aria-controls', 'bwdd-body');
        minBtn.textContent = '–';
        minBtn.setAttribute('title', 'Minimize panel (Esc)');
        function setCollapsed(isCol) {
            root.classList.toggle('collapsed', isCol);
            minBtn.textContent = isCol ? '+' : '–';
            minBtn.setAttribute('aria-label', isCol ? 'Expand panel' : 'Minimize panel');
            minBtn.setAttribute('aria-expanded', String(!isCol));
            try { localStorage.setItem(PANEL_COLLAPSED_KEY, isCol ? '1' : '0'); } catch (e) {}
        }
        minBtn.onclick = () => setCollapsed(!root.classList.contains('collapsed'));

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'bwdd-ctrl-btn';
        closeBtn.setAttribute('aria-label', 'Close downloader panel');
        closeBtn.setAttribute('title', 'Close panel');
        closeBtn.textContent = '×';

        closeBtn.onclick = () => {
            try { if (bridgeTimer) { clearTimeout(bridgeTimer); bridgeTimer = null; } } catch (e) {}
            try { window.removeEventListener('keydown', onPanelKeydown); } catch (e) {}
            try { document.removeEventListener('click', onNameDocClick); } catch (e) {}
            try { statsObs.disconnect(); } catch (e) {}
            try { root.remove(); } catch (e) {}
            try { if (edgeTab) edgeTab.remove(); } catch (e) {}
        };

        const flapBtn = document.createElement('button');
        flapBtn.type = 'button';
        flapBtn.className = 'bwdd-ctrl-btn';
        flapBtn.setAttribute('aria-label', 'Hide the panel to the right edge');
        flapBtn.setAttribute('aria-expanded', 'true');
        flapBtn.setAttribute('title', 'Slide the panel away to the right edge of the screen');
        flapBtn.textContent = '»';

        ctrlGroup.append(flapBtn, minBtn, closeBtn);

        const dragGrip = document.createElement('span');
        dragGrip.className = 'bwdd-drag-grip';
        dragGrip.setAttribute('aria-hidden', 'true');
        dragGrip.textContent = '\u283F';
        head.append(dragGrip, titleGroup, ctrlGroup);

        const body = document.createElement('div');
        body.className = 'bwdd-body';
        body.id = 'bwdd-body';

        const bridgeRow = document.createElement('div');
        bridgeRow.className = 'bwdd-bridge-pill';
        const dot = document.createElement('span');
        dot.className = 'bwdd-indicator-dot';
        dot.setAttribute('aria-hidden', 'true');
        const bridgeText = document.createElement('span');
        bridgeText.className = 'bwdd-bridge-text';
        bridgeText.textContent = 'Looking for the Mokuro Bridge helper…';
        bridgeRow.title = 'mokuro-bridge: a small local app (github.com/GolyBidoof/mokuro-bridge) that runs mokuro OCR on the downloaded pages and can upload the results.';
        bridgeRow.append(dot, bridgeText);

        const mokuroAlert = document.createElement('div');
        mokuroAlert.className = 'bwdd-mokuro-alert';
        mokuroAlert.style.display = 'none';
        mokuroAlert.setAttribute('role', 'alert');

        function placePopover(pop, anchor, align) {
            pop.hidden = false;
            const a = anchor.getBoundingClientRect();
            const w = pop.offsetWidth;
            const h = pop.offsetHeight;
            let left = align === 'right' ? a.right - w : a.left;
            left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
            let top = a.bottom + 4;
            if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 4);
            pop.style.left = Math.round(left) + 'px';
            pop.style.top = Math.round(top) + 'px';
        }

        const infoDot = document.createElement('button');
        infoDot.type = 'button';
        infoDot.className = 'bwdd-info-dot';
        infoDot.setAttribute('aria-label', 'About the Mokuro Bridge and this run\u2019s connection speed');
        infoDot.setAttribute('aria-expanded', 'false');
        infoDot.textContent = '?';
        bridgeRow.insertBefore(infoDot, bridgeText);

        const bridgeInfoPop = document.createElement('div');
        bridgeInfoPop.className = 'bwdd-bridge-pop';
        bridgeInfoPop.hidden = true;
        const infoTitle = document.createElement('span');
        infoTitle.className = 'bwdd-bridge-info-title';
        infoTitle.textContent = 'What is the Mokuro Bridge?';

        const mokuroSection = document.createElement('div');
        mokuroSection.className = 'bwdd-bridge-info-section';
        const mokuroSectionHeading = document.createElement('span');
        mokuroSectionHeading.className = 'bwdd-bridge-info-subhead';
        mokuroSectionHeading.textContent = 'Mokuro engine';
        const infoMokuro = document.createElement('span');
        infoMokuro.className = 'bwdd-bridge-info-mokuro';
        mokuroSection.append(mokuroSectionHeading, infoMokuro);

        const divider1 = document.createElement('hr');
        divider1.className = 'bwdd-bridge-info-divider';

        const aboutSection = document.createElement('div');
        aboutSection.className = 'bwdd-bridge-info-section';
        const aboutSectionHeading = document.createElement('span');
        aboutSectionHeading.className = 'bwdd-bridge-info-subhead';
        aboutSectionHeading.textContent = 'What it does';
        const infoBody = document.createElement('span');
        infoBody.className = 'bwdd-bridge-info-body';
        infoBody.textContent = 'A small companion app that runs locally on your computer. ' +
            'Choosing “Save and run through Mokuro” sends the downloaded pages to it, where ' +
            'mokuro runs Japanese OCR on them; the finished volume is then saved or ' +
            'uploaded wherever you pick. Plain “Save as ZIP” downloads don\'t use it.';
        aboutSection.append(aboutSectionHeading, infoBody);

        const divider2 = document.createElement('hr');
        divider2.className = 'bwdd-bridge-info-divider';

        const divider3 = document.createElement('hr');
        divider3.className = 'bwdd-bridge-info-divider';

        const connSection = document.createElement('div');
        connSection.className = 'bwdd-bridge-info-section';
        const connHeading = document.createElement('span');
        connHeading.className = 'bwdd-bridge-info-subhead';
        connHeading.textContent = 'Connection speed';
        const connNumbers = document.createElement('span');
        connNumbers.className = 'bwdd-caps-line';
        const connBody = document.createElement('span');
        connBody.className = 'bwdd-bridge-info-body';
        connSection.append(connHeading, connNumbers, connBody);

        const infoLink = document.createElement('a');
        infoLink.className = 'bwdd-bridge-info-link';
        infoLink.href = 'https://github.com/GolyBidoof/mokuro-bridge';
        infoLink.target = '_blank';
        infoLink.rel = 'noopener noreferrer';
        infoLink.textContent = 'Download mokuro-bridge ↗';
        bridgeInfoPop.append(infoTitle, mokuroSection, divider1, aboutSection, divider2,
            connSection, divider3, infoLink);
        infoDot.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = bridgeInfoPop.hidden;
            if (open) placePopover(bridgeInfoPop, bridgeRow, 'left');
            else bridgeInfoPop.hidden = true;
            infoDot.setAttribute('aria-expanded', String(open));
        });

        const bridgeAnchor = document.createElement('div');
        bridgeAnchor.className = 'bwdd-bridge-anchor';
        bridgeAnchor.append(bridgeRow, bridgeInfoPop);

        function busyReason(info) {
            if (!info) return '';
            const stage = info.busy_stage;
            if (info.busy) {
                if (stage === 'uploading') return 'Uploading…';
                if (stage === 'ocr') return info.busy_detail || 'OCR running…';
                return info.busy_detail || 'Busy…';
            }
            return '';
        }
        async function updateBridgeDot() {
            if (!root.isConnected) return;
            const ok = await bridgeHealth();
            let mokuroMissing = false;
            let mokuroDetailText = '';
            let bridgeBusy = false;
            let bridgeBusyStage = '';
            let bridgeBusyDetail = '';

            if (ok && bridgeReachableNow) {
                const info = await refreshBridgeInfo().catch(() => null);
                const hasBridgePorts = !!(info && Array.isArray(info.fetchProxyPorts) && info.fetchProxyPorts.length);
                if (!hasBridgePorts) clearProxySource('bridge');

                try {
                    if (info && (Array.isArray(info.fetchUpstreams) || info.upstream)) {
                        setProxyUpstreams(info.fetchUpstreams, info.upstream);
                    }
                    addProxyPorts(info && info.fetchProxyPorts, 'bridge');
                } catch (e) {}
                mokuroMissing = !!(info && info.mokuro_installed === false);
                bridgeBusy = !!(info && info.busy);
                bridgeBusyStage = (info && info.busy_stage) || '';
                bridgeBusyDetail = (info && info.busy_detail) || '';
                if (info && info.mokuro_installed === true) {
                    mokuroDetailText = info.mokuro_version
                        ? 'Mokuro v' + info.mokuro_version + (info.mokuro_custom_fork ? ' (custom fork)' : '') + ' is installed on this machine.'
                        : 'Mokuro is installed on this machine.';
                    infoMokuro.classList.remove('missing');
                } else if (mokuroMissing) {
                    mokuroDetailText = 'Mokuro is not installed on this machine — OCR cannot run.';
                    infoMokuro.classList.add('missing');
                } else {
                    mokuroDetailText = '';
                    infoMokuro.classList.remove('missing');
                }
            } else {
                clearProxySource('bridge');
                mokuroDetailText = 'Bridge not reachable — start it to check the installed mokuro.';
                infoMokuro.classList.remove('missing');
            }
            infoMokuro.textContent = mokuroDetailText;
            bridgeOnline = ok && !mokuroMissing;
            if (ok && mokuroMissing) {
                dot.className = 'bwdd-indicator-dot offline';
                mokuroAlert.style.display = 'block';
                mokuroAlert.textContent = 'Mokuro is not installed on this machine. ' +
                    'OCR cannot run until you install it — e.g. run “pip install mokuro” (or point ' +
                    'the bridge at your mokuro checkout) in the mokuro-bridge folder, then restart the bridge.';
            } else if (ok && bridgeBusy) {
                dot.className = 'bwdd-indicator-dot busy';
                mokuroAlert.style.display = 'none';
            } else {
                dot.className = ok ? 'bwdd-indicator-dot online' : 'bwdd-indicator-dot';
                mokuroAlert.style.display = 'none';
            }
            if (ok && bridgeReachableNow && !mokuroMissing) {
                destWrap.style.display = 'flex';

                if (!runBusy) { try { populateDestMethods(); } catch (e) {} }
                if (bridgeBusy) {

                    bridgeText.textContent = 'Mokuro Bridge busy — ' + (busyReason({ busy: true, busy_stage: bridgeBusyStage, busy_detail: bridgeBusyDetail }) || 'working');
                    bridgeRow.title = 'mokuro-bridge: ' + (bridgeBusyDetail ? bridgeBusyDetail + ' · ' : '') + 'github.com/GolyBidoof/mokuro-bridge';
                } else {

                    try {
                        const hasOptions = !!(destSelect.options && destSelect.options.length);
                        const method = hasOptions ? (destSelect.value || 'local') : 'local';
                        let desc, folder = null;
                        if (method === 'local') {
                            folder = localDirInput.value.trim() || (bridgeInfo && bridgeInfo.output_dir) || null;
                            desc = 'saving locally';
                        } else {
                            const opt = destSelect.selectedOptions && destSelect.selectedOptions[0];
                            const text = opt ? String(opt.textContent) : '';
                            const name = opt ? text.split(' — ')[0].trim() : method;
                            const m = text.match(/—\s*(.+)$/);
                            folder = m ? m[1].trim() : null;
                            desc = 'uploading via ' + (name || method);
                        }
                        bridgeText.textContent = 'Mokuro Bridge + Mokuro online — ' + desc;
                        bridgeRow.title = 'mokuro-bridge: ' + (folder ? 'writes to ' + folder + ' · ' : '') + 'github.com/GolyBidoof/mokuro-bridge';
                    } catch (e) {
                        bridgeText.textContent = 'Mokuro Bridge + Mokuro online';
                    }
                }
            } else {
                destWrap.style.display = 'none';
                bridgeText.textContent = ok
                    ? 'Mokuro Bridge is online but mokuro is missing — install it to enable OCR'
                    : 'Mokuro Bridge is not found on port 62642 — start it to enable OCR';
            }

            setRunLock(runBusy);

            bridgePollFast = !!(bridgeBusy || runBusy);
            laneBridgeOnline = bridgeReachableNow;
            renderCapabilities();
            scheduleBridgePoll();
        }

        let bridgeTimer = null;
        let bridgePollFast = false;
        function scheduleBridgePoll() {
            if (bridgeTimer) { clearTimeout(bridgeTimer); bridgeTimer = null; }
            bridgeTimer = setTimeout(updateBridgeDot, bridgePollFast ? 1000 : 10000);
        }
        updateBridgeDot();

        const statsEl = document.createElement('div');
        statsEl.className = 'bwdd-cards';

        const details = document.createElement('div');
        details.className = 'bwdd-hint-box';
        details.setAttribute('aria-live', 'polite');

        function mkBar(label, gradient, a11yLabel) {
            const row = document.createElement('div');
            row.className = 'bwdd-bar-row';
            const meta = document.createElement('div');
            meta.className = 'bwdd-bar-meta';
            const name = document.createElement('span');
            name.textContent = label;
            const rate = document.createElement('span');
            rate.className = 'bwdd-bar-rate';
            rate.textContent = '—';
            meta.append(name, rate);

            const track = document.createElement('div');
            track.className = 'bwdd-bar-track';

            const fillBg = document.createElement('div');
            fillBg.className = 'bwdd-bar-fill-bg';
            fillBg.style.width = '0%';
            track.appendChild(fillBg);
            const fill = document.createElement('div');
            fill.className = 'bwdd-bar-fill';
            fill.style.background = gradient;
            fill.setAttribute('role', 'progressbar');
            fill.setAttribute('aria-label', a11yLabel);
            fill.setAttribute('aria-valuemin', '0');
            fill.setAttribute('aria-valuemax', '100');
            fill.setAttribute('aria-valuenow', '0');
            track.appendChild(fill);

            row.append(meta, track);
            return { wrap: row, fill, fillBg, labRate: rate, labName: name };
        }

        const barDownload = mkBar('1. Network Fetch', 'linear-gradient(90deg, #10b981, #059669)', 'Download Progress');
        const barDescramble = mkBar('2. Tile Descramble', 'linear-gradient(90deg, #3b82f6, #1d4ed8)', 'Descramble Progress');
        const barMokuro = mkBar('3. Mokuro Bridge', 'linear-gradient(90deg, #f59e0b, #d97706)', 'OCR Pipeline Progress');
        const barUpload = mkBar('4. Upload', 'linear-gradient(90deg, #8b5cf6, #6d28d9)', 'Upload Progress');
        barDownload.wrap.title = 'Pages fetched from ' + siteLabel() + '\u2019s CDN';
        barDescramble.wrap.title = 'Pages reassembled from their scrambled tiles';
        barMokuro.wrap.title = 'Pages OCR\u2019d / pages received by the bridge / total pages \u2014 faint amber = received but not yet OCR\u2019d';
        barUpload.wrap.title = 'Finished volume being stored or uploaded by the mokuro-bridge';

        const barWrap = document.createElement('div');
        barWrap.className = 'bwdd-bars';
        barWrap.setAttribute('role', 'region');
        barWrap.setAttribute('aria-label', 'Task Progress');
        barWrap.append(barDownload.wrap, barDescramble.wrap, barMokuro.wrap, barUpload.wrap);

        const btnRow = document.createElement('div');
        btnRow.className = 'bwdd-actions';

        const btnZip = document.createElement('button');
        btnZip.type = 'button';
        btnZip.className = 'bwdd-btn zip';
        btnZip.innerHTML = '<span>Save as ZIP</span><span class="bwdd-btn-sub">Pages bundled, ready to read offline</span>';

        const btnOcr = document.createElement('button');
        btnOcr.type = 'button';
        btnOcr.className = 'bwdd-btn ocr';
        btnOcr.innerHTML = '<span>Save and run through Mokuro</span><span class="bwdd-btn-sub">Run pages through the local Mokuro Bridge, then optionally upload</span>';
        const btnOcrTip = 'Mokuro = Japanese OCR (mokuro). Runs through the local mokuro-bridge app — see https://github.com/GolyBidoof/mokuro-bridge';
        btnOcr.title = btnOcrTip;

        btnRow.append(btnZip, btnOcr);

        const nameWrap = document.createElement('div');
        nameWrap.className = 'bwdd-name';
        const nameLabel = document.createElement('label');
        nameLabel.className = 'bwdd-dest-label';
        nameLabel.textContent = 'Archive name';
        nameLabel.setAttribute('for', 'bwdd-archive-name');
        const nameInput = document.createElement('input');
        nameInput.id = 'bwdd-archive-name';
        nameInput.type = 'text';
        nameInput.className = 'bwdd-dest-input';
        nameInput.autocomplete = 'off';
        nameInput.spellcheck = false;
        nameInput.placeholder = 'Auto-filled from this book';
        nameInput.setAttribute('aria-label', 'Archive name - the name of the generated download (leave empty to use this book\u2019s series + volume)');
        const nameInfoDot = document.createElement('button');
        nameInfoDot.type = 'button';
        nameInfoDot.className = 'bwdd-info-dot';
        nameInfoDot.setAttribute('aria-label', 'About the archive name field');
        nameInfoDot.setAttribute('aria-expanded', 'false');
        nameInfoDot.setAttribute('aria-controls', 'bwdd-archive-name-pop');
        nameInfoDot.title = 'What this field does';
        nameInfoDot.textContent = '?';

        const namePop = document.createElement('div');
        namePop.className = 'bwdd-name-pop';
        namePop.id = 'bwdd-archive-name-pop';
        namePop.hidden = true;
        namePop.setAttribute('role', 'note');
        const namePopP1 = document.createElement('div');
        namePopP1.textContent = 'Name of the generated archive: the .zip \u201cSave as ZIP\u201d downloads, or the volume the Mokuro bridge stores/uploads when OCR runs.';
        const namePopP2 = document.createElement('div');
        namePopP2.textContent = 'Empty = this book\u2019s series + volume, exactly as the store writes it (e.g. \u2026 1\u5dfb, \uff08\uff11\uff09, \u2026 1).';
        const namePopP3 = document.createElement('div');
        namePopP3.textContent = 'ZIP pages sit flat inside the archive; OCR uploads still land under the series folder. Invalid file-name characters are stripped.';
        namePop.append(namePopP1, namePopP2, namePopP3);
        nameWrap.append(nameLabel, nameInput, nameInfoDot, namePop);
        function setArchivePop(open) {
            if (open) placePopover(namePop, nameWrap, 'right');
            else namePop.hidden = true;
            nameInfoDot.setAttribute('aria-expanded', String(open));
        }
        nameInfoDot.addEventListener('click', (e) => {
            e.stopPropagation();
            setArchivePop(namePop.hidden);
        });

        function onNameDocClick(e) {
            if (!namePop.hidden && !nameWrap.contains(e.target)) setArchivePop(false);
        }
        document.addEventListener('click', onNameDocClick);

        let archiveAutoDefault = null;

        function syncArchiveDefault(rawTitle) {
            const dflt = archiveDefaultName(rawTitle);
            const cur = nameInput.value;
            if (!cur.trim()) {
                if (dflt) { nameInput.value = dflt; archiveAutoDefault = dflt; }
                else { archiveAutoDefault = null; }
            } else if (archiveAutoDefault !== null && cur === archiveAutoDefault && dflt && dflt !== archiveAutoDefault) {
                nameInput.value = dflt;
                archiveAutoDefault = dflt;
            } else {
                archiveAutoDefault = (dflt && cur === dflt) ? dflt : null;
            }
            const safe = fsSafePath(nameInput.value.trim());
            if (safe) return safe;
            return dflt || fsSafePath(siteCid() || '') || 'book';
        }

        const destWrap = document.createElement('div');
        destWrap.className = 'bwdd-dest';
        destWrap.style.display = 'none';
        const destLabel = document.createElement('label');
        destLabel.className = 'bwdd-dest-label';
        destLabel.textContent = 'Mokuro output destination';
        destLabel.setAttribute('for', 'bwdd-upload-method');
        const destSelect = document.createElement('select');
        destSelect.id = 'bwdd-upload-method';
        destSelect.className = 'bwdd-dest-select';
        destSelect.setAttribute('aria-label', 'Mokuro upload method');
        const localDirRow = document.createElement('div');
        localDirRow.className = 'bwdd-dest-localdir';
        localDirRow.style.display = 'none';
        const localDirLabel = document.createElement('label');
        localDirLabel.className = 'bwdd-dest-label';
        localDirLabel.textContent = 'Output folder (on this computer)';
        localDirLabel.setAttribute('for', 'bwdd-local-dir');
        const localDirInput = document.createElement('input');
        localDirInput.id = 'bwdd-local-dir';
        localDirInput.type = 'text';
        localDirInput.className = 'bwdd-dest-input';
        localDirInput.placeholder = 'absolute path on this computer — e.g. C:\\Users\\you\\manga or /home/you/manga';
        localDirInput.title = 'Where mokuro-bridge should write the finished volume. This is a path on the machine running the bridge (your computer).';

        const localDirFill = document.createElement('button');
        localDirFill.type = 'button';
        localDirFill.className = 'bwdd-btn-fill';
        localDirFill.textContent = 'Use bridge default';
        localDirFill.addEventListener('click', async () => {
            const info = bridgeInfo || await refreshBridgeInfo();
            if (info && info.output_dir) localDirInput.value = info.output_dir;
        });
        const localDirWrap = document.createElement('div');
        localDirWrap.style.cssText = 'display:flex;gap:6px;align-items:center;';
        localDirWrap.append(localDirInput, localDirFill);
        localDirRow.append(localDirLabel, localDirWrap);
        const destHint = document.createElement('div');
        destHint.className = 'bwdd-dest-hint';
        destHint.style.display = 'none';
        destWrap.append(destLabel, destSelect, localDirRow, destHint);

        let userMethod = null;

        const hasUsableOption = (v) => v != null && [...destSelect.options]
            .some(o => o.value === v && !o.disabled && !(o.dataset && o.dataset.unconfigured));

        async function populateDestMethods() {
            const methods = await fetchUploadMethods().catch(() => null);

            if (runBusy) return;
            const prevValue = destSelect.value;
            destSelect.textContent = '';
            let def = 'local';
            if (methods && Array.isArray(methods.methods) && methods.methods.length) {
                def = methods.upload_method_default || 'local';
                for (const m of methods.methods) {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    if (m.id === 'local') {
                        opt.textContent = 'Local folder' + (m.current_folder ? ' — ' + m.current_folder : '');
                    } else if (m.configured) {
                        opt.textContent = m.name + (m.current_folder ? ' — ' + m.current_folder : '');
                    } else {

                        opt.textContent = m.name + ' — needs setup';
                        opt.dataset.unconfigured = '1';
                        opt.title = 'Not set up yet — enable it once in the mokuro-bridge terminal (from its folder): python server.py --setup-upload ' + (m.id || '');
                    }
                    destSelect.appendChild(opt);
                }
            } else {
                for (const [id, name] of [['local', 'Local (default output)'], ['mega', 'MEGA']]) {
                    const opt = document.createElement('option');
                    opt.value = id; opt.textContent = name;
                    destSelect.appendChild(opt);
                }
            }

            if (!userMethod && !prevValue) {
                try {
                    const saved = localStorage.getItem('bwdd-upload-method');
                    if (saved && hasUsableOption(saved)) userMethod = saved;
                } catch (e) {}
            }

            let picked = null;
            if (prevValue) {
                const stillThere = [...destSelect.options].some(o => o.value === prevValue);
                if (stillThere) picked = prevValue;
            }
            if (picked == null && userMethod && hasUsableOption(userMethod)) picked = userMethod;
            if (picked == null && hasUsableOption(def)) picked = def;
            if (picked == null) picked = 'local';
            destSelect.value = picked;
            onDestChange();
        }

        function rememberMethod(v) {
            userMethod = v;
            try { localStorage.setItem('bwdd-upload-method', v); } catch (e) {}
        }

        function onDestChange() {
            const v = destSelect.value || 'local';
            const showLocal = v === 'local';
            localDirRow.style.display = showLocal ? 'flex' : 'none';
            if (showLocal) {
                if (!localDirInput.value) {
                    const planDefault = bridgeInfo && bridgeInfo.output_dir || '';
                    if (planDefault) localDirInput.placeholder = 'default: ' + planDefault;
                }
            }
            updateDestHint();
            refreshOcrButton();
        }
        function selectedNeedsSetup() {
            const o = destSelect.selectedOptions && destSelect.selectedOptions[0];
            return !!(o && o.dataset && o.dataset.unconfigured);
        }

        function refreshOcrButton() {
            const blockedBySetup = selectedNeedsSetup();
            btnOcr.disabled = runBusy || !bridgeOnline || blockedBySetup;
            btnOcr.setAttribute('aria-disabled', String(btnOcr.disabled));
            btnOcr.title = blockedBySetup
                ? 'This destination is not set up yet — run the command below once, then it will be usable here.'
                : ((runBusy || bridgeOnline) ? btnOcrTip : 'Start the Mokuro Bridge to enable OCR');
        }
        function updateDestHint() {
            const selOpt = destSelect.selectedOptions && destSelect.selectedOptions[0];
            if (!selOpt || !selOpt.dataset || !selOpt.dataset.unconfigured) {
                destHint.style.display = 'none';
                return;
            }
            destHint.style.display = 'block';
            destHint.textContent = '';
            destHint.appendChild(document.createTextNode('This destination needs one-time setup in the bridge terminal: '));
            const code = document.createElement('code');
            code.textContent = 'python server.py --setup-upload ' + (selOpt.value || '');
            destHint.appendChild(code);
            destHint.appendChild(document.createTextNode('  (from the mokuro-bridge folder)'));
        }
        destSelect.addEventListener('change', () => { rememberMethod(destSelect.value); onDestChange(); });
        localDirInput.addEventListener('change', () => { try { localStorage.setItem('bwdd-local-dir', localDirInput.value); } catch (e) {} });
        try { const saved = localStorage.getItem('bwdd-local-dir'); if (saved) localDirInput.value = saved; } catch (e) {}
        populateDestMethods();

        let bridgeOnline = false;
        let runBusy = false;

        let unloadGuardArmed = false;
        function onBeforeUnload(e) {
            e.preventDefault();

            e.returnValue = '';
            return '';
        }
        function setUnloadGuard(active) {
            if (active === unloadGuardArmed) return;
            unloadGuardArmed = active;
            try {
                if (active) window.addEventListener('beforeunload', onBeforeUnload);
                else window.removeEventListener('beforeunload', onBeforeUnload);
            } catch (e) {}
        }
        function setRunLock(busy) {
            runBusy = busy;
            setUnloadGuard(busy);
            btnZip.disabled = busy;
            btnZip.setAttribute('aria-disabled', String(busy));
            refreshOcrButton();
            const destLocked = busy || !bridgeOnline;
            destSelect.disabled = destLocked;
            localDirInput.disabled = destLocked;
            localDirFill.disabled = destLocked;
            nameInput.disabled = busy;
            destWrap.classList.toggle('bwdd-dest-locked', busy);
            if (busy) {
                destWrap.setAttribute('aria-busy', 'true');
                destWrap.title = 'Locked while a download or OCR run is in progress';
            } else {
                destWrap.removeAttribute('aria-busy');
                destWrap.title = '';
            }

            closeBtn.disabled = busy;
            flapBtn.disabled = busy;
            if (busy) {
                closeBtn.title = 'Closes after the run finishes';
                flapBtn.title = 'Available after the run finishes';
            } else {
                closeBtn.title = 'Close panel';
                flapBtn.title = 'Slide the panel away to the right edge of the screen';
            }
        }

        const postRunRow = document.createElement('div');
        postRunRow.className = 'bwdd-reader-row';
        postRunRow.style.display = 'none';
        const btnReader = document.createElement('button');
        btnReader.type = 'button';
        btnReader.className = 'bwdd-ghost-btn';
        btnReader.textContent = 'Open Reader Mokuro';
        btnReader.setAttribute('aria-label', 'Open Reader Mokuro in a new tab');
        const btnStored = document.createElement('button');
        btnStored.type = 'button';
        btnStored.className = 'bwdd-ghost-btn';
        btnStored.setAttribute('aria-label', 'Open stored file');
        postRunRow.append(btnReader, btnStored);
        let readerReady = false;
        let storedReady = false;
        function syncPostRunRow() {
            btnReader.style.display = readerReady ? '' : 'none';
            btnStored.style.display = storedReady ? '' : 'none';
            postRunRow.style.display = (readerReady || storedReady) ? 'grid' : 'none';
        }
        function showReaderButton(result) {
            btnReader.onclick = () => {
                const a = document.createElement('a');
                a.href = readerJumpUrl(result);
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                a.remove();
            };
            readerReady = true;
            syncPostRunRow();
        }
        function hideReaderButton() {
            btnReader.onclick = null;
            readerReady = false;
            syncPostRunRow();
        }
        function showStoredButton(result) {
            const target = storedOpenTarget(result);
            if (target) {
                const isCbz = /\.cbz$/i.test(target.file || '');
                btnStored.textContent = isCbz ? 'Open stored file (.cbz)' : 'Open stored file';
                btnStored.setAttribute('aria-label', isCbz
                    ? 'Open the stored .cbz file in a new tab'
                    : 'Open the stored file in a new tab');
                btnStored.title = target.url;
                btnStored.onclick = () => {
                    const a = document.createElement('a');
                    a.href = target.url;
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    a.style.display = 'none';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                };
            } else {
                const method = result && result.method;
                const isLocal = !method || method === 'local';
                const copyText = isLocal
                    ? (result && (result.output_dir || result.staging))
                    : (result && (result.remote_path || result.mega_path || result.staging));
                const mainLabel = isLocal ? 'Copy local folder path' : 'Copy destination path';
                const a11yLabel = mainLabel + ' to the clipboard';
                btnStored.textContent = mainLabel;
                btnStored.setAttribute('aria-label', a11yLabel);
                btnStored.title = copyText || '';
                btnStored.onclick = () => {
                    const text = copyText || 'about:blank';
                    try { navigator.clipboard.writeText(text); } catch (e) {}
                    btnStored.textContent = 'Path copied ✓';
                    btnStored.setAttribute('aria-label', 'Path copied to the clipboard');
                    setTimeout(() => {
                        btnStored.textContent = mainLabel;
                        btnStored.setAttribute('aria-label', a11yLabel);
                    }, 1500);
                };
            }
            storedReady = true;
            syncPostRunRow();
        }
        function hideStoredButton() {
            btnStored.onclick = null;
            storedReady = false;
            syncPostRunRow();
        }

        function renderCapabilities() {
            const c = capabilitySummary();
            connSection.classList.toggle('on', c.bridgeOnline);
            connSection.classList.toggle('off', !c.bridgeOnline);

            const speed = c.bridgeOnline ? c.ports + ' ports'
                : (c.ports ? 'bridge offline' : 'no bridge');
            connNumbers.textContent = speed + ' · ' + c.effectiveSockets +
                ' sockets · ' + c.workers + ' workers';

            let explain;
            if (c.bridgeOnline) {
                explain = 'mokuro-bridge is serving ' + c.ports + ' extra local ports. The browser ' +
                    'allows 6 connections per origin, and every port counts as its own origin, so ' +
                    'this run has up to ' + c.sockets + ' network sockets instead of ' +
                    c.withoutBridge + '. Up to ' + c.decodePages + ' pages decode concurrently; ' +
                    'the fetch window is bounded separately to avoid retaining the whole volume.';

                if (c.socketsClamped) {
                    explain += ' Those ports would add up to ' + c.rawSockets + ', but the browser ' +
                        'caps a profile at ' + CHROMIUM_SOCKETS_PER_PROCESS + ' sockets in total, so ' +
                        'the run uses ' + c.sockets + ' and keeps ' + CONTROL_PLANE_SOCKET_RESERVE +
                        ' in reserve for the manifest, policy refresh and bridge checks.';
                }
            } else if (c.ports) {
                explain = 'mokuro-bridge answered earlier (' + c.ports + ' ports) but is not ' +
                    'reachable now, so this run would use ' + c.effectiveSockets + ' connections. ' +
                    'Restart it to get the extra ports back.';
            } else {

                explain = 'mokuro-bridge is not running, so this run uses ' + c.effectiveSockets +
                    ' browser connections. Starting it adds its advertised local ports, ' +
                    'worth up to six connections each. Downloads work the same either way.';
            }
            connBody.textContent = explain + ' ' + c.workers + ' Web Workers unscramble ' +
                workerBatchSize(IMAGE_CODEC.type) + ' page each concurrently as they arrive; that number follows your CPU, not the bridge.';
        }

        const fmtDetails = document.createElement('details');
        fmtDetails.className = 'bwdd-fmt';
        const fmtSummary = document.createElement('summary');
        fmtSummary.className = 'bwdd-fmt-summary';
        const fmtBody = document.createElement('div');
        fmtBody.className = 'bwdd-dest';

        function labelledSelect(labelText, id, options, ariaLabel) {
            const row = document.createElement('div');
            row.className = 'bwdd-opt-row';
            const lab = document.createElement('label');
            lab.className = 'bwdd-dest-label';
            lab.textContent = labelText;
            lab.setAttribute('for', id);
            const sel = document.createElement('select');
            sel.id = id;
            sel.className = 'bwdd-dest-select';
            sel.setAttribute('aria-label', ariaLabel || labelText);
            for (const [v, text] of options) {
                const o = document.createElement('option');
                o.value = v;
                o.textContent = text;
                sel.appendChild(o);
            }
            row.append(lab, sel);
            return { row, sel };
        }

        const FORMAT_LABELS = {
            jpeg: 'JPEG', webp: 'WebP', lossless: 'Lossless', png: 'PNG',
        };
        const fmtCtl = labelledSelect('Format', 'bwdd-image-format', [
            ['jpeg', 'JPEG (smallest)'],
            ['webp', 'WebP (smaller, slower)'],
            ['lossless', 'Lossless (perfect copy)'],
            ['png', 'PNG (largest)'],
        ], 'Page image format');
        const qCtl = labelledSelect('Quality', 'bwdd-image-quality', [
            ['0.95', 'Highest'], ['0.92', 'High (default)'],
            ['0.85', 'Balanced'], ['0.75', 'Small'],
        ], 'Page image quality');
        const fmtNote = document.createElement('div');
        fmtNote.className = 'bwdd-caps-note';

        function onFormatChange(save) {
            if (save !== false) {
                try {
                    localStorage.setItem('bwddImageFormat', fmtCtl.sel.value);
                    localStorage.setItem('bwddImageQuality', qCtl.sel.value);
                } catch (e) {}
            }
            const c = refreshImageCodec();

            qCtl.row.style.display = c.lossless ? 'none' : 'flex';
            fmtSummary.textContent = 'Image format · ' + FORMAT_LABELS[c.fmt] +
                (c.lossless ? '' : ' q' + c.quality);
            fmtNote.textContent = c.lossless
                ? 'Lossless keeps every pixel the CDN sent. Often smaller than JPEG on line art, much larger on photo pages.'
                : 'Pages are re-encoded from the CDN\u2019s own JPEG, so this is a second generation.';
            renderCapabilities();
        }

        {
            const wantedFmt = IMAGE_CODEC.fmt;
            if (![...fmtCtl.sel.options].some(o => o.value === wantedFmt)) {
                const o = document.createElement('option');
                o.value = wantedFmt;
                o.textContent = wantedFmt;
                fmtCtl.sel.appendChild(o);
            }
            fmtCtl.sel.value = wantedFmt;
            const wantedQ = String(IMAGE_CODEC.quality);
            if (![...qCtl.sel.options].some(o => o.value === wantedQ)) {
                const o = document.createElement('option');
                o.value = wantedQ;
                o.textContent = wantedQ;
                qCtl.sel.appendChild(o);
            }
            qCtl.sel.value = wantedQ;
        }
        fmtCtl.sel.addEventListener('change', () => onFormatChange(true));
        qCtl.sel.addEventListener('change', () => onFormatChange(true));
        fmtBody.append(fmtCtl.row, qCtl.row, fmtNote);
        fmtDetails.append(fmtSummary, fmtBody);
        onFormatChange(false);

        const colMain = document.createElement('div');
        colMain.className = 'bwdd-col bwdd-col-main';
        colMain.append(bridgeAnchor, mokuroAlert, destWrap, nameWrap, fmtDetails, btnRow, barWrap, details, postRunRow);

        const colStats = document.createElement('div');
        colStats.className = 'bwdd-col bwdd-col-stats';
        colStats.append(statsEl);

        const colSep = document.createElement('div');
        colSep.className = 'bwdd-col-sep';

        function mountStatsColumn() {
            const manual = parseFloat(root.style.width);
            const manualWide = isFinite(manual) && manual >= 620;
            body.append(colSep, colStats);
            root.classList.add('bwdd-stats-visible');

            if (!manualWide) root.style.width = '';
        }
        let statsMounted = false;
        const statsObs = new MutationObserver(() => {
            if (statsMounted || !statsEl.childElementCount) return;
            statsMounted = true;
            statsObs.disconnect();
            mountStatsColumn();
        });
        statsObs.observe(statsEl, { childList: true });
        if (statsEl.childElementCount) { statsMounted = true; mountStatsColumn(); }

        body.append(colMain);
        root.append(head, body);
        document.documentElement.appendChild(root);

        try { updateBridgeDot(); } catch (e) {}

        const edgeTab = document.createElement('button');
        edgeTab.type = 'button';
        edgeTab.className = 'bwdd-edge-tab';
        edgeTab.setAttribute('aria-label', 'Show the ' + sitePanelTitle() + ' panel');
        edgeTab.title = 'Show the ' + sitePanelTitle() + ' panel';
        edgeTab.textContent = '\u00AB';
        edgeTab.style.display = 'none';
        document.documentElement.appendChild(edgeTab);

        function flapOut() {
            if (edgeTab.style.display === 'flex') return;
            const r = root.getBoundingClientRect();

            const shift = Math.max(24, Math.ceil(window.innerWidth - r.left) + 4);
            root.style.transform = 'translateX(' + shift + 'px)';
            root.classList.add('bwdd-flapped');
            root.setAttribute('aria-hidden', 'true');

            root.inert = true;

            const tabH = 76;
            const vh = window.innerHeight || document.documentElement.clientHeight || 800;
            const tabTop = Math.max(0, Math.min(r.top + (r.height - tabH) / 2, vh - tabH - 8));
            edgeTab.style.top = tabTop + 'px';
            edgeTab.style.display = 'flex';
            flapBtn.setAttribute('aria-expanded', 'false');
            flapBtn.setAttribute('aria-label', 'Show the panel (from the right edge)');
            try { edgeTab.focus(); } catch (e) {}
        }
        function flapIn() {
            if (edgeTab.style.display !== 'flex') return;
            root.classList.remove('bwdd-flapped');
            root.style.transform = '';
            root.removeAttribute('aria-hidden');
            root.inert = false;
            edgeTab.style.display = 'none';
            flapBtn.setAttribute('aria-expanded', 'true');
            flapBtn.setAttribute('aria-label', 'Hide the panel to the right edge');
            try { flapBtn.focus(); } catch (e) {}
        }
        edgeTab.addEventListener('click', () => flapIn());
        flapBtn.onclick = () => flapOut();

        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'bwdd-resize';
        resizeHandle.setAttribute('aria-hidden', 'true');
        resizeHandle.setAttribute('title', 'Drag to resize the panel');
        root.appendChild(resizeHandle);

        let resizing = false;
        let resizeStartX = 0, resizeStartY = 0;
        let resizeStartW = 0, resizeStartH = 0;
        function resizeMinW() {
            return root.classList.contains('bwdd-stats-visible') ? 620 : 360;
        }
        function resizeMinH() { return 120; }
        function persistPanelSize() {
            try {
                const r = root.getBoundingClientRect();
                localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(r.width)));
                localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(r.height)));
            } catch (e) {}
        }
        resizeHandle.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const r = root.getBoundingClientRect();

            root.style.left = r.left + 'px';
            root.style.top = r.top + 'px';
            root.style.right = 'auto';
            resizing = true;
            resizeStartX = e.clientX; resizeStartY = e.clientY;
            resizeStartW = r.width; resizeStartH = r.height;
            try { resizeHandle.setPointerCapture(e.pointerId); } catch (err) {}
        });
        resizeHandle.addEventListener('pointermove', (e) => {
            if (!resizing) return;
            const vw = window.innerWidth || 1200;
            const vh = window.innerHeight || 800;
            const left = root.getBoundingClientRect().left;
            const top = root.getBoundingClientRect().top;
            const minW = resizeMinW();
            const maxW = Math.max(minW, Math.min(1200, vw - left - 12));
            const w = Math.max(minW, Math.min(maxW, resizeStartW + (e.clientX - resizeStartX)));
            root.style.width = Math.round(w) + 'px';

            const minH = resizeMinH();
            const maxH = Math.max(minH, Math.min(1000, vh - top - 12));
            const h = Math.max(minH, Math.min(maxH, resizeStartH + (e.clientY - resizeStartY)));
            root.style.height = Math.round(h) + 'px';
        });
        resizeHandle.addEventListener('pointerup', () => { resizing = false; persistPanelSize(); });
        resizeHandle.addEventListener('pointercancel', () => { resizing = false; });
        resizeHandle.addEventListener('lostpointercapture', () => { if (resizing) { resizing = false; persistPanelSize(); } });

        try {
            const savedW = parseInt(localStorage.getItem(PANEL_WIDTH_KEY) || '', 10);
            if (isFinite(savedW) && savedW > 0) root.style.width = Math.min(Math.max(savedW, 300), 1200) + 'px';
        } catch (e) {}
        try {
            const savedH = parseInt(localStorage.getItem(PANEL_HEIGHT_KEY) || '', 10);
            if (isFinite(savedH) && savedH > 0) root.style.height = Math.min(Math.max(savedH, 120), 1000) + 'px';
        } catch (e) {}

        try {
            const savedPos = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || 'null');
            if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
                root.style.left = clampPanelX(savedPos.x) + 'px';
                root.style.top = clampPanelY(savedPos.y) + 'px';
                root.style.right = 'auto';
            }
        } catch (e) {}
        try { if (localStorage.getItem(PANEL_COLLAPSED_KEY) === '1') setCollapsed(true); } catch (e) {}

        let dragging = false;
        let dragPointerId = null;
        let pos = { x: 0, y: 0 };
        function clampPanelX(x) { return Math.max(0, Math.min(x, Math.max(0, (window.innerWidth || 1200) - 60))); }
        function clampPanelY(y) { return Math.max(0, Math.min(y, Math.max(0, (window.innerHeight || 800) - 70))); }
        function savePanelPos() {
            try {
                const r = root.getBoundingClientRect();
                localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ x: r.left, y: r.top }));
            } catch (e) {}
        }
        function applyDragPos(clientX, clientY) {
            root.style.left = clampPanelX(clientX - pos.x) + 'px';
            root.style.top = clampPanelY(clientY - pos.y) + 'px';
            root.style.right = 'auto';
        }

        head.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (e.target.closest('button, a')) return;
            dragging = true;
            dragPointerId = e.pointerId;
            pos.x = e.clientX - root.offsetLeft;
            pos.y = e.clientY - root.offsetTop;
            try { head.setPointerCapture(e.pointerId); } catch (err) {}
            e.preventDefault();
        });
        head.addEventListener('pointermove', (e) => {
            if (!dragging || dragPointerId !== e.pointerId) return;
            applyDragPos(e.clientX, e.clientY);
        });
        function stopDrag(e) {
            if (!dragging || (e && dragPointerId != null && e.pointerId !== dragPointerId)) return;
            dragging = false;
            dragPointerId = null;
            savePanelPos();
        }
        head.addEventListener('pointerup', stopDrag);
        head.addEventListener('pointercancel', stopDrag);
        head.addEventListener('lostpointercapture', () => {
            if (dragging) savePanelPos();
            dragging = false;
            dragPointerId = null;
        });

        function onPanelKeydown(e) {
            if (e.key !== 'Escape') return;

            if (!namePop.hidden) { setArchivePop(false); return; }

            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
            if (document.contains(root) && !e.defaultPrevented) {
                setCollapsed(!root.classList.contains('collapsed'));
            }
        }
        window.addEventListener('keydown', onPanelKeydown);

        if (BWDD_DEBUG) {
            try {
                window.__bwddUI = Object.assign(window.__bwddUI || {}, {
                    populateDestMethods, onDestChange,
                    renderCapabilities, capabilitySummary, workerPoolSize, discoverProxyPorts,
                    fmtSelect: fmtCtl.sel, qSelect: qCtl.sel,
                    setImageFormat(fmt, quality) {
                        if (fmt) fmtCtl.sel.value = fmt;
                        if (quality != null) qCtl.sel.value = String(quality);
                        onFormatChange(true);
                        return IMAGE_CODEC;
                    },
                });
            } catch (e) { try { console.error('[bwdd] UI export failed:', safeLogText(e)); } catch (e2) {} }
        }
        return { root, details, statsEl, barWrap, barDownload, barDescramble, barMokuro, barUpload, btnZip, btnOcr, btnRow, nameWrap, destSelect, localDirInput, destHint, populateDestMethods, setRunLock, showReaderButton, hideReaderButton, showStoredButton, hideStoredButton, syncArchiveDefault };
    }

    function updateMokuroBar(bar, done, received, total) {
        if (!bar || !bar.fill) return;
        const t = total || 1;
        const r = Math.max(0, Math.min(received || 0, t));
        const d = Math.max(0, Math.min(done || 0, r));
        if (bar.fillBg) bar.fillBg.style.width = Math.round((r / t) * 100) + '%';
        bar.fill.style.width = Math.round((d / t) * 100) + '%';
        bar.fill.setAttribute('aria-valuenow', String(Math.round((d / t) * 100)));
        bar.fill.setAttribute('aria-valuetext', d + ' of ' + t + ' pages OCR\u2019d, ' + r + ' received by the bridge');
        bar.labRate.textContent = d + '/' + r + '/' + t;
    }

    function setBar(bar, pct, text) {
        if (!bar) return;
        const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
        bar.fill.style.width = p + '%';
        bar.fill.setAttribute('aria-valuenow', String(p));
        bar.fill.setAttribute('aria-valuetext', `${p}% complete`);
        if (text != null) bar.labRate.textContent = text;
    }

    function makeTechDetails(rawLines, label) {
        const lines = (rawLines || []).filter(Boolean);
        const capped = lines.slice(0, 15);
        const overflow = lines.length - capped.length;
        if (!capped.length) return null;
        const det = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = (label || 'Technical details') + ' (' + capped.length + (overflow ? '+' : '') + ')';
        const pre = document.createElement('pre');
        pre.textContent = capped.join('\n') + (overflow > 0 ? '\n\u2026 and ' + overflow + ' more' : '');
        det.append(sum, pre);
        return det;
    }
    function setRunDetails(el, summary, rawLines) {
        if (!el) return;
        el.textContent = '';
        el.appendChild(document.createTextNode(summary));
        const det = makeTechDetails(rawLines);
        if (det) el.appendChild(det);
    }
    function appendRunDetails(el, rawLines, label) {
        if (!el) return;
        const det = makeTechDetails(rawLines, label);
        if (det) el.appendChild(det);
    }
    function showBars(ui) {
        ui.barWrap.style.display = 'flex';
        ui.barDownload.wrap.style.display = 'flex';
        ui.barDescramble.wrap.style.display = 'flex';
        setBar(ui.barDownload, 0, '0%');
        setBar(ui.barDescramble, 0, '0%');
    }

async function uploadCoverEarly(opts) {
        const { ui, barUpload, feed, mokuroSessionId, safeTitle, blob } = opts;
        if (!mokuroSessionId || !blob) return null;
        const plan = await resolveUploadChoice(ui).catch(() => ({ method: null, label: null, localDir: null }));
        const coverName = (safeTitle || 'volume') + '.webp';
        try {
            barUpload.labName.textContent = '4. ' + (plan.method === 'local' ? 'Store' : 'Upload');
            barUpload.wrap.style.display = 'flex';

            if (feed.seed) feed.seed([{ file: coverName, total_bytes: blob.size }]);
            feed({ file: coverName, currentBytes: 0, totalBytes: blob.size, percent: 0 });
            const res = await mokuroUploadCover(mokuroSessionId, blob, { method: plan.method || null, localDir: plan.localDir });
            feed({ file: res && res.file ? res.file : coverName, currentBytes: res && res.size ? res.size : blob.size, totalBytes: res && res.size ? res.size : blob.size, percent: 100 });
            return res;
        } catch (e) {

            if (BWDD_DEBUG) console.warn('[bwdd] Early cover upload skipped:', safeLogText(e && e.message || e));
            return null;
        }
    }

    async function finalizeOcrSession(mokuroSessionId, ui, barUpload, barMokuro, total, sharedFeed, options = {}) {
        const plan = await resolveUploadChoice(ui).catch(() => ({ method: null, label: null, localDir: null }));

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

                overwrite: options.overwrite || null,
            }, (stage, msg) => {
                if (stage === 'upload_progress' || stage === 'upload') barUpload.wrap.style.display = 'flex';

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

        const cleanups = [];
        const registerCleanup = fn => { if (typeof fn === 'function') cleanups.push(fn); };
        options.registerRunCleanup = registerCleanup;

        if (typeof ui.setRunLock === 'function') ui.setRunLock(true);

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

        function refreshProgress() {
            const done = okIdx.size;
            const dl = Math.min(fetched, total);
            setBar(barDownload, total ? (dl / total) * 100 : 0, dl + '/' + total);
            setBar(barDescramble, total ? (done / total) * 100 : 0, done + '/' + total);

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
                    const entry = buffer.get(nextIdx);
                    buffer.delete(nextIdx);
                    const blob = entry.blob;
                    const page = nextIdx;
                    const fn = 'page-' + String(page).padStart(4, '0') + '.' + (entry.ext || IMAGE_CODEC.ext);
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

                if (!options.headless) { sendOrdered(); return; }
                chain = chain.then(sendOrdered, sendOrdered).catch(e => {
                    errors.push('OCR stream: ' + safeLogText((e && e.message) || e));
                });
            }

            function startPoll() {
                if (!sessionId || poll) return;

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

                async open() {
                    barWrap.style.display = 'flex';
                    barMokuro.wrap.style.display = 'flex';
                    setBar(barMokuro, 0, '0/' + total);
                    if (!(await ensureBridgeRunning(25000))) {
                        throw new Error(MOKURO_BRIDGE_OFFLINE_MSG);
                    }

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

                note(idx, blob, ext) {
                    buffer.set(idx, { blob, ext: ext || '' });
                    if (idx === nextIdx) schedule();
                },

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
                        const entry = buffer.get(i);
                        if (!entry) continue;
                        buffer.delete(i);
                        const fn = 'page-' + String(i).padStart(4, '0') + '.' + (entry.ext || IMAGE_CODEC.ext);
                        try {
                            await mokuroStreamPage(sessionId, entry.blob, fn, i);
                            sent++;
                            reportRunProgress(options, 'page-stream', {
                                page: i, pageCount: okIdx.size, total: total
                            });
                        } catch (e) {
                            errors.push('Final OCR send page ' + i + ': ' + safeLogText((e && e.message) || e));
                        }
                    }

                },

                async finalize() {
                    barMokuro.wrap.style.display = 'flex';
                    const { result, plan } = await finalizeOcrSession(
                        sessionId, ui, barUpload, barMokuro, total, uploadFeed, options);

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

                    ui.showReaderButton(result);
                    ui.showStoredButton(result);
                    return { result, plan, missing, ok: !partial };
                },

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
                mokuro.note(idx, blob, ext);
            }
            reportPage(idx);
            refreshProgress();
        }

        function noteCached(idx, blob, crc) {
            okIdx.add(idx);
            failedIdx.delete(idx);
            const ext = (blob && imageExtForMime(blob.type)) || IMAGE_CODEC.ext;
            if (zip && blob) zip.entries.push({
                path: 'page-' + String(idx).padStart(4, '0') + '.' + ext,
                blob,
                crc: Number.isInteger(crc) ? crc : undefined,
            });
            if (mokuro && blob) mokuro.note(idx, blob, ext);
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

            finishedOk = errors.length === 0;
            return outcome(missing === 0);
        }

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

    const SITE_REGISTRY = [];
    let ACTIVE_SITE = null;

    function registerSite(adapter) {
        if (adapter && adapter.id) SITE_REGISTRY.push(adapter);
        return adapter;
    }

    function storeOwnsHost() {
        for (const adapter of SITE_REGISTRY) {
            let owns = false;
            try { owns = typeof adapter.ownsHost === 'function' && !!adapter.ownsHost(); } catch (e) { owns = false; }
            if (owns) return true;
        }
        return false;
    }

    function detectSite() {
        for (const adapter of SITE_REGISTRY) {
            let owned = false;
            try { owned = !!adapter.matches(); } catch (e) { owned = false; }
            if (owned) return adapter;
        }

        if (isHeadlessPage()) {
            for (const adapter of SITE_REGISTRY) {
                let owned = false;
                try { owned = typeof adapter.headlessMatches === 'function' && !!adapter.headlessMatches(); } catch (e) { owned = false; }
                if (owned) return adapter;
            }
        }

        if (storeOwnsHost()) return null;

        return SITE_REGISTRY.find(a => a.id === 'bookwalker') || SITE_REGISTRY[0] || null;
    }

    function activeSite() { return ACTIVE_SITE; }
    function siteCid() {
        if (ACTIVE_SITE && typeof ACTIVE_SITE.getCid === 'function') {
            try { return ACTIVE_SITE.getCid() || ''; } catch (e) { return ''; }
        }
        return '';
    }
    function siteRun(ui, mode, options) {
        if (ACTIVE_SITE && typeof ACTIVE_SITE.run === 'function') {
            return ACTIVE_SITE.run(ui, mode, options);
        }
        throw new Error('no site adapter is registered for this page');
    }
    function siteLabel() { return (ACTIVE_SITE && ACTIVE_SITE.label) || 'BookWalker'; }
    function sitePanelTitle() {
        return (ACTIVE_SITE && ACTIVE_SITE.panelTitle) || 'BookWalker Native Downloader';
    }

    function bootSharedPanel(site) {
        ACTIVE_SITE = site;
        installHeadlessAutomation();

        if (isHeadlessPage()) return null;

        try {
            const proto = location.protocol;
            if (proto !== 'http:' && proto !== 'https:') return null;
        } catch (e) {}

        const ui = buildUI();
        const launch = mode => {
            Promise.resolve()
                .then(() => site.run(ui, mode))
                .catch(e => {
                    const text = safeLogText((e && e.message) || e);
                    console.warn('[bwdd] ' + site.id + ' run failed: ' + text);

                    try {
                        setRunDetails(ui.details, 'the run failed: ' + text, []);
                        if (ui.details) ui.details.hidden = false;
                    } catch (e2) {}
                });
        };
        ui.btnZip.onclick = () => launch('zip');
        ui.btnOcr.onclick = () => launch('ocr');

        try { schedulePageCachePrune(0); } catch (e) {}
        if (typeof site.afterBoot === 'function') {
            try { site.afterBoot(ui); } catch (e) {}
        }

        (async () => {
            let statsKicked = false;
            let lastStoresKey = null;
            let lastArchiveSource = null;

            for (let i = 0; i < 40; i++) {
                await new Promise(r => setTimeout(r, 500));

                if (typeof site.refresh === 'function') {
                    try { await site.refresh(); } catch (e) {}
                }
                let book = null;
                try { book = site.getBook(); } catch (e) { book = null; }
                const rawTitle = (book && book.rawTitle) || document.title || '';
                if (rawTitle && rawTitle !== lastArchiveSource) {
                    lastArchiveSource = rawTitle;
                    try { ui.syncArchiveDefault(rawTitle); } catch (e) {}
                }
                if (!statsKicked && book && book.series) {
                    try {
                        fetchAndRenderStats(ui.statsEl, book.series, book.volNum);
                        statsKicked = true;
                    } catch (e) {}
                }

                if (typeof lookupAvailability === 'function' && book && (book.series || book.title)) {
                    const storesKey = String(book.series || book.title).trim() + '|' +
                        (book.volNum == null ? '' : book.volNum);
                    if (storesKey !== lastStoresKey) {
                        lastStoresKey = storesKey;
                        try { lookupAvailability(ui.statsEl, book.series, book.title, book.volNum); } catch (e) {}
                    }
                }
                let preview = null;
                try { preview = site.getPreview(); } catch (e) { preview = null; }
                if (preview) {
                    renderBookCard(ui.statsEl, preview);
                    break;
                }
            }
        })();

        return ui;
    }

    const CMOA_QUALITY_ORDER = (function () {
        try {
            const custom = window.__bwddCmoaQualityOrder;
            if (Array.isArray(custom) && custom.length && custom.every(q => /^[0-9]+$/.test(String(q)))) {
                return custom.map(String);
            }
        } catch (e) {}
        return ['0', '1'];
    })();
    const CMOA_FETCH_CONCURRENCY = 6;
    const cmoaState = {

        running: false,
        cid: null,
        contentsServer: null,
        token: null,
        viewMode: null,
        dmytime: null,
        u0: null,
        u1: null,
        extraParams: {},
        title: null,
        rawTitle: null,
        pages: [],
        quality: null,
        originalQuality: null,
        ready: false,
        collecting: false,
        error: null,
        tokenPool: [],
        lastGoodToken: null,
        reader: null,
        viewer: null,
        qualityBlacklist: new Set(),

        winningRungs: new Set(),

        scrambleTables: null,
        scrambleKey: null,
        protocolTried: false,
        protocolError: null,
    };

    function cmoaPageWindow() {
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow) {
                if (unsafeWindow.SpeedBinb) return unsafeWindow;
            }
        } catch (e) {}
        return window;
    }

    function cmoaLog() {
        if (!BWDD_DEBUG) return;
        try { console.log.apply(console, ['[bwdd/cmoa]'].concat([].slice.call(arguments))); } catch (e) {}
    }

    function cmoaRememberToken(tokenValue, options) {
        options = options || {};
        if (!tokenValue && tokenValue !== 0) return;
        const token = String(tokenValue).trim();
        if (!token || token.toLowerCase() === 'null') return;
        if (!cmoaState.tokenPool.includes(token)) cmoaState.tokenPool.push(token);
        if (options.markGood) cmoaState.lastGoodToken = token;
        if (!cmoaState.token || options.force || (options.prefer && cmoaState.token !== token)) {
            cmoaState.token = token;
        }
    }

    function cmoaEvictToken(tokenValue) {
        if (!tokenValue && tokenValue !== 0) return;
        const token = String(tokenValue).trim();
        if (!token) return;
        cmoaState.tokenPool = cmoaState.tokenPool.filter(t => t !== token);
        if (cmoaState.lastGoodToken === token) cmoaState.lastGoodToken = null;
        if (cmoaState.token === token) {
            cmoaState.token = cmoaState.lastGoodToken || cmoaState.tokenPool[0] || null;
        }
    }

    const CMOA_CID_RE = /^([0-9]{10})_jp_([0-9]{4})$/;
    const CMOA_CONTENT_ID_RE = /^1([0-9]{10})([0-9]{4})$/;
    function cmoaNormalizeCid(value) {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) return '';
        if (CMOA_CID_RE.test(raw)) return raw;
        const m = CMOA_CONTENT_ID_RE.exec(raw);
        if (m) return m[1] + '_jp_' + m[2];
        return raw;
    }

    function cmoaAssignParam(key, rawValue, force) {
        if (rawValue == null) return;
        const value = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue);
        if (!value) return;
        const lower = key.toLowerCase();
        const shouldSet = current => force || current == null || current === '';
        if (lower === 'cid' || lower === 'content_id') {
            const cid = cmoaNormalizeCid(value);
            if (shouldSet(cmoaState.cid)) cmoaState.cid = cid;
            return;
        }
        if (lower === 'contentsserver' || lower === 'sbcurl') {
            if (shouldSet(cmoaState.contentsServer)) cmoaState.contentsServer = value.replace(/\/$/, '');
            return;
        }
        if (lower === 'p' || lower === 'token') { cmoaRememberToken(value, { force: force }); return; }
        if (lower === 'vm' || lower === 'viewmode') { if (shouldSet(cmoaState.viewMode)) cmoaState.viewMode = value; return; }
        if (lower === 'dmytime' || lower === 'contentdate') { if (shouldSet(cmoaState.dmytime)) cmoaState.dmytime = value; return; }
        if (lower === 'qualitymode' || lower === 'quality' || lower === 'q') {
            cmoaState.originalQuality = value;
            if (force || !cmoaState.quality) cmoaState.quality = value;
            return;
        }
        if (lower === 'u0') { if (shouldSet(cmoaState.u0)) cmoaState.u0 = value; return; }
        if (lower === 'u1') { if (shouldSet(cmoaState.u1)) cmoaState.u1 = value; return; }
        cmoaState.extraParams[key] = value;
    }

    function cmoaApplySearchParams(searchParams, force) {
        if (!searchParams || typeof searchParams.forEach !== 'function') return;
        searchParams.forEach((value, key) => cmoaAssignParam(key, value, force));
    }

    function cmoaGatherFromUrl() {
        try {
            cmoaApplySearchParams(new URLSearchParams(location.search || ''));
            if (!cmoaState.cid) {
                const m = location.href.match(/[?&]cid=([^&#]+)/);
                if (m) cmoaState.cid = cmoaNormalizeCid(decodeURIComponent(m[1]));
            }
        } catch (e) {}
    }

    function cmoaGatherFromDataset() {
        let node = null;
        try { node = document.querySelector('[data-ptbinb]'); } catch (e) {}
        if (!node) return;
        const attr = node.getAttribute('data-ptbinb');
        if (attr) {
            try {
                cmoaApplySearchParams(new URL(attr, location.origin).searchParams);
            } catch (e) {
                const i = attr.indexOf('?');
                if (i !== -1) cmoaApplySearchParams(new URLSearchParams(attr.slice(i + 1)));
            }
        }
        const cidAttr = node.getAttribute('data-ptbinb-cid');
        if (cidAttr && !cmoaState.cid) cmoaState.cid = cmoaNormalizeCid(cidAttr);
    }

    function cmoaExtractFromPerformance() {
        if (!window.performance || typeof window.performance.getEntriesByType !== 'function') return;
        let entries = [];
        try { entries = window.performance.getEntriesByType('resource') || []; } catch (e) { return; }
        for (const entry of entries) {
            const name = entry && entry.name;
            if (typeof name !== 'string') continue;
            if (!/sbcGet(?:Cntnt|Img)\.php/i.test(name)) continue;
            let parsed = null;
            try { parsed = new URL(name, location.origin); } catch (e) { continue; }
            const cidParam = parsed.searchParams.get('cid');
            if (cmoaState.cid && cidParam && cidParam !== cmoaState.cid) continue;
            if (/sbcGetCntnt\.php/i.test(parsed.pathname)) {
                const base = new URL('.', parsed).href.replace(/\/$/, '');
                if (!cmoaState.contentsServer) cmoaState.contentsServer = base;
                cmoaApplySearchParams(parsed.searchParams, true);
            } else {
                const q = parsed.searchParams.get('q');
                if (q) cmoaState.originalQuality = q;
                const p = parsed.searchParams.get('p');
                if (p) cmoaRememberToken(p, { prefer: true });
                const vm = parsed.searchParams.get('vm');
                if (vm && !cmoaState.viewMode) cmoaState.viewMode = vm;
                const dmy = parsed.searchParams.get('dmytime');
                if (dmy && !cmoaState.dmytime) cmoaState.dmytime = dmy;
            }
        }
    }

    function cmoaGetViewer() {
        try {
            const w = cmoaPageWindow();
            if (w.SpeedBinb && typeof w.SpeedBinb.getInstance === 'function') {
                return w.SpeedBinb.getInstance('content');
            }
        } catch (e) {}
        return null;
    }

    function cmoaSafe(fn) {
        try { return fn(); } catch (e) { return null; }
    }

    function cmoaIsReader(candidate) {
        return !!(candidate && typeof candidate.getImageDescrambleCoords === 'function');
    }

    function cmoaGetReader() {
        const viewer = cmoaState.viewer || cmoaGetViewer();
        if (!viewer) return cmoaState.reader;
        const direct = cmoaSafe(() => viewer.reader);
        if (cmoaIsReader(direct)) return direct;
        if (typeof direct === 'function') {
            const invoked = cmoaSafe(() => direct.call(viewer));
            if (cmoaIsReader(invoked)) return invoked;
        }
        const viaGetter = cmoaSafe(() => (typeof viewer.getReader === 'function' ? viewer.getReader() : null));
        if (cmoaIsReader(viaGetter)) return viaGetter;
        const seeds = [viewer, cmoaSafe(() => viewer.content), cmoaSafe(() => viewer.state)];
        for (const seed of seeds) {
            if (!seed || typeof seed !== 'object') continue;
            if (cmoaIsReader(seed)) return seed;
            let keys = [];
            try { keys = Object.keys(seed); } catch (e) { keys = []; }
            for (const key of keys) {
                if (!/reader/i.test(key)) continue;
                const value = cmoaSafe(() => seed[key]);
                if (cmoaIsReader(value)) return value;
                if (typeof value === 'function') {
                    const invoked = cmoaSafe(() => value.call(seed));
                    if (cmoaIsReader(invoked)) return invoked;
                }
            }
        }
        return cmoaState.reader;
    }

    function cmoaCollectPages(viewer) {
        const pages = [];
        if (!viewer) return pages;
        const pageArray = cmoaSafe(() => {
            const content = viewer.content;
            return content && content.page;
        });
        if (!Array.isArray(pageArray)) return pages;
        const seen = new Set();
        pageArray.forEach((entry, idx) => {
            const image = cmoaSafe(() => entry && entry.image) || null;
            const src = (image && typeof image.src === 'string') ? image.src.trim()
                : (entry && typeof entry.src === 'string' ? entry.src.trim() : '');
            if (!src || seen.has(src)) return;
            seen.add(src);
            pages.push({
                index: idx,
                src: src,
                id: (entry && entry.id) || (image && image.id) || 'page_' + (idx + 1),
                width: image && Number.isFinite(Number(image.orgwidth)) ? Number(image.orgwidth) : null,
                height: image && Number.isFinite(Number(image.orgheight)) ? Number(image.orgheight) : null,
                spread: image && typeof image.pagespread !== 'undefined' ? image.pagespread : null,
                image: image || null,
            });
        });
        pages.sort((a, b) => a.index - b.index);
        return pages;
    }

    function cmoaViewerCapabilities() {
        const out = { href: '' };
        try { out.href = location.pathname; } catch (e) {}
        const w = cmoaPageWindow();
        try { out.speedbinb = !!(w.SpeedBinb && typeof w.SpeedBinb.getInstance === 'function'); } catch (e) { out.speedbinb = 'throws'; }
        const viewer = cmoaState.viewer || cmoaGetViewer();
        out.viewer = !!viewer;
        if (viewer) {
            const direct = cmoaSafe(() => viewer.reader);
            out.reader = (direct === null || direct === undefined) ? String(direct)
                : (cmoaIsReader(direct) ? 'scrambler' : typeof direct);
            try { out.pageCount = (viewer.content && viewer.content.page && viewer.content.page.length) || 0; } catch (e) {}
            try {
                out.keys = Object.keys(viewer).filter(k => /read|scram|binb|content/i.test(k)).slice(0, 10);
            } catch (e) { out.keys = 'unreadable'; }
        }
        out.stateReader = !!cmoaState.reader;
        out.frames = (function () {
            try { return window.top === window.self ? 'top' : 'frame'; } catch (e) { return 'cross-origin'; }
        })();
        return out;
    }

    function cmoaScrambleParamsFromUrl(url) {
        try {
            const params = new URL(String(url), location.href).searchParams;
            const k = params.get('k');
            if (!k) return null;
            const cid = params.get('cid') || params.get('content_id') || cmoaState.cid;
            return cid ? { cid: cid, key: k } : null;
        } catch (e) { return null; }
    }

    function cmoaContentInfoUrl() {
        const reader = cmoaGetReader();
        const fromReader = cmoaSafe(() => reader && reader.requestUrl);
        if (typeof fromReader === 'string' && /bibGetCntntInfo/i.test(fromReader)) return fromReader;
        if (!cmoaState.cid) return null;
        const u0 = cmoaState.u0 || '1';
        return location.origin + '/bib/sws/bibGetCntntInfo.php?cid=' +
            encodeURIComponent(cmoaState.cid) + '&dmytime=' + Date.now() + '&u0=' + encodeURIComponent(u0);
    }

    function cmoaIngestContentInfo(payload, sourceUrl, scrambleKey, scrambleCid) {
        let data = payload;
        if (typeof payload === 'string') {
            try { data = JSON.parse(payload); } catch (e) { data = null; }
        }
        if (data && typeof data === 'object' && data.result != null) {

            cmoaState.contentResult = Number(data.result);
            if (Number(data.result) !== 1) {
                console.warn('[bwdd/cmoa] bibGetCntntInfo refused the request (result=' +
                    data.result + (data.eurl ? ', ' + data.eurl : '') + ') for ' + sourceUrl);
            }
        }
        if (data && typeof data === 'object' && Array.isArray(data.items) && data.items.length) {
            const item = data.items[0] || {};
            if (item.ContentsServer && !cmoaState.contentsServer) {
                cmoaState.contentsServer = String(item.ContentsServer).replace(/\/$/, '');
            }
            if (item.p) cmoaRememberToken(item.p, { force: !cmoaState.lastGoodToken });

            const fromUrl = cmoaScrambleParamsFromUrl(sourceUrl);
            const decodeCid = scrambleCid || (fromUrl && fromUrl.cid);
            const key = scrambleKey || (fromUrl && fromUrl.key);
            if (decodeCid && key && !cmoaState.scrambleTables) {
                const tables = cmoaDecodeTables(decodeCid, key, item);
                if (tables && (Array.isArray(tables.ctbl) || Array.isArray(tables.ptbl))) {
                    cmoaState.scrambleTables = tables;
                    cmoaState.scrambleKey = key;
                    cmoaLog('scramble tables recovered', Object.keys(tables).join(','));
                }
            }
            if (item.ViewMode != null && cmoaState.viewMode == null) cmoaState.viewMode = String(item.ViewMode);
            if (item.ContentDate && !cmoaState.dmytime) cmoaState.dmytime = String(item.ContentDate);

            const clean = typeof item.SubTitle === 'string' ? item.SubTitle.trim() : '';
            const raw = typeof item.Title === 'string' ? item.Title.trim() : '';
            if (clean) cmoaState.title = clean;
            if (raw) cmoaState.rawTitle = raw;
            if (!cmoaState.title && raw) cmoaState.title = cmoaCleanTitle(raw);
        }
        if (typeof sourceUrl === 'string') {
            try { cmoaApplySearchParams(new URL(sourceUrl, location.href).searchParams, true); } catch (e) {}
        }
    }

    async function cmoaFetchContentInfo() {
        if (cmoaState.title && cmoaState.contentsServer) return true;
        const url = cmoaContentInfoUrl();
        if (!url) return false;
        try {
            const res = await fetchWithTimeout(url, {
                headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01' },
                credentials: 'include',
            }, 15000);
            if (!res || !res.ok) return false;
            const text = await res.text();
            cmoaIngestContentInfo(text, url);
            return true;
        } catch (e) {
            cmoaLog('content info fetch failed', safeLogText(e && e.message));
            return false;
        }
    }

    const CMOA_JUNK_TITLE = /^(?:binb(?:\s*speed\s*reader)?|speed\s*binb(?:\s*reader)?|speed\s*reader|cmoa|コミックシーモア|無料[・･]?試し読み(?:ページ)?|試し読みページ|ローディング|loading)$/i;
    function cmoaCleanTitle(raw) {
        let s = String(raw || '').trim();
        if (!s) return '';
        s = s.split('｜')[0].trim();
        s = s.replace(/^(?:無料[・･]?)?(?:試し読み|立ち読み)(?:ページ)?\s*/, '').trim();

        const m = s.match(/^(.*?[0-9０-９]{1,3}\s*[巻話])\s*[（(][^）)]*[）)]\s*$/);
        if (m && m[1]) s = m[1].trim();

        if (CMOA_JUNK_TITLE.test(s)) return '';
        return s;
    }

    function cmoaTitleFromDom() {

        try {
            const el = document.getElementById('menu_header_tittle');
            const t = el && el.textContent ? el.textContent.trim() : '';
            if (t) return t;
        } catch (e) {}
        return document.title || '';
    }

    function cmoaProtocolTarget() {
        const candidates = [];
        candidates.push(location.href);
        for (const cand of candidates) {
            if (!cand) continue;
            try {
                const u = new URL(String(cand), location.href);
                const cid = u.searchParams.get('cid') || u.searchParams.get('content_id');
                if (cid) return { cid: cmoaNormalizeCid(cid), params: u.searchParams };

                const m = /\/([0-9]{10}_jp_[0-9]{4})\b/.exec(u.pathname);
                if (m) return { cid: cmoaNormalizeCid(m[1]), params: u.searchParams };
            } catch (e) {}
        }
        return cmoaState.cid
            ? { cid: cmoaNormalizeCid(cmoaState.cid), params: new URLSearchParams() }
            : null;
    }

    async function cmoaFetchProtocolState() {
        if (cmoaState.protocolTried) return false;
        cmoaState.protocolTried = true;
        const target = cmoaProtocolTarget();
        if (!target || !target.cid) {
            cmoaState.protocolError = 'no content ID for the viewer-free path';
            return false;
        }
        const cid = target.cid;
        cmoaState.cid = cmoaState.cid || cid;
        const k = cmoaGenerateK(cid);
        cmoaState.scrambleKey = k;

        const forwarded = new URLSearchParams();
        try {
            target.params.forEach(function (value, key) {
                const lower = String(key).toLowerCase();

                if (lower === 'cid' || lower === 'content_id' || lower === 'title_id' ||
                    lower === 'k' || lower === 'dmytime' || lower === 'rurl') return;
                forwarded.set(key, value);
            });
        } catch (e) {}
        if (!forwarded.has('u0')) forwarded.set('u0', String(cmoaState.u0 || '1'));
        const applyForwarded = url => {
            forwarded.forEach(function (value, key) { url.searchParams.set(key, value); });
            return url;
        };
        try {
            const info = new URL('https://www.cmoa.jp/bib/sws/bibGetCntntInfo.php');
            info.searchParams.set('cid', cid);
            info.searchParams.set('dmytime', String(Date.now()));
            info.searchParams.set('k', k);
            applyForwarded(info);
            const infoRes = await fetchWithTimeout(info.toString(), {
                headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01' },
                credentials: 'include',
            }, 15000);
            if (!infoRes || !infoRes.ok) throw new Error('content info HTTP ' + (infoRes && infoRes.status));
            const infoText = await infoRes.text();
            cmoaIngestContentInfo(infoText, info.toString(), k, cid);
            if (!cmoaState.contentsServer || cmoaState.contentResult === -100) {
                throw new Error('bibGetCntntInfo refused this volume (result=' +
                    (cmoaState.contentResult != null ? cmoaState.contentResult : 'none') + ') for ' + cid);
            }
            const token = cmoaState.token;
            const viewMode = cmoaState.viewMode != null ? cmoaState.viewMode : '2';
            const dmytime = cmoaState.dmytime || String(Date.now());
            const list = new URL('sbcGetCntnt.php', cmoaState.contentsServer + '/');
            list.searchParams.set('cid', cid);
            if (token) list.searchParams.set('p', token);
            list.searchParams.set('vm', viewMode);
            list.searchParams.set('dmytime', dmytime);
            applyForwarded(list);

            const listRes = await fetchWithTimeout(list.toString(), { credentials: 'omit' }, 15000);
            if (!listRes || !listRes.ok) throw new Error('page list HTTP ' + (listRes && listRes.status));
            const payload = await listRes.text();
            let doc = payload;
            try {
                const parsed = JSON.parse(payload);

                if (parsed && parsed.result != null && Number(parsed.result) !== 1) {
                    throw new Error('sbcGetCntnt returned result=' + parsed.result);
                }
                doc = parsed && parsed.ttx ? parsed.ttx : payload;
            } catch (e) {
                if (e && /sbcGetCntnt returned result/.test(e.message || '')) throw e;
            }
            const pages = cmoaParsePageList(doc);
            if (!pages.length) throw new Error('the page list came back empty');
            cmoaState.pages = pages.map(function (page, index) {
                return {
                    index: index,
                    src: page.src,
                    id: page.id || ('page_' + (index + 1)),
                    width: page.width,
                    height: page.height,
                    spread: page.spread,
                    image: { src: page.src, id: page.id || '', orgwidth: page.width, orgheight: page.height },
                };
            });
            cmoaLog('viewer-free page list', cmoaState.pages.length, 'pages');
            return true;
        } catch (e) {
            cmoaState.protocolError = safeLogText((e && e.message) || e);
            cmoaLog('viewer-free state failed', cmoaState.protocolError);
            return false;
        }
    }

    function cmoaComputeReadiness() {
        const missing = [];
        if (!cmoaState.cid) missing.push('content ID');
        if (!cmoaState.contentsServer) missing.push('contents server');
        if (!cmoaState.pages.length) missing.push('page list');

        if (!cmoaState.reader && !cmoaState.scrambleTables) missing.push('descramble reader');
        cmoaState.ready = missing.length === 0;
        return missing;
    }

    async function cmoaRefreshState() {
        if (cmoaState.collecting) return;
        cmoaState.collecting = true;
        try {
            cmoaGatherFromUrl();
            cmoaGatherFromDataset();
            cmoaExtractFromPerformance();

            if (!cmoaState.contentsServer || !cmoaState.token || !cmoaState.title) {
                await cmoaFetchContentInfo();
            }
            const viewer = cmoaGetViewer();
            if (viewer) {
                cmoaState.viewer = viewer;
                const pages = cmoaCollectPages(viewer);
                if (pages.length) cmoaState.pages = pages;
                const reader = cmoaGetReader();
                if (reader) cmoaState.reader = reader;
            }
            if (!cmoaState.title) {
                const fromViewer = cmoaSafe(() => viewer && viewer.content && viewer.content.bibliography && viewer.content.bibliography.title);

                const candidates = [cmoaState.rawTitle, cmoaTitleFromDom(), fromViewer, document.title];
                for (const cand of candidates) {
                    const cleaned = cmoaCleanTitle(cand);
                    if (cleaned) {
                        cmoaState.rawTitle = cand;
                        cmoaState.title = cleaned;
                        break;
                    }
                }
            }

            if (!cmoaState.running && cmoaState.quality !== CMOA_QUALITY_ORDER[0]) {
                cmoaState.quality = CMOA_QUALITY_ORDER[0];
            }
            if (BWDD_DEBUG) {
                cmoaLog('state', {
                    cid: cmoaState.cid, title: cmoaState.title, raw: cmoaState.rawTitle,
                    server: cmoaState.contentsServer, token: !!cmoaState.token,
                    quality: cmoaState.quality, pages: cmoaState.pages.length,
                });
            }

            if (!cmoaState.reader || !cmoaState.pages.length) {
                if (!cmoaState.protocolTried || (!cmoaState.pages.length && !cmoaState.protocolError)) {
                    await cmoaFetchProtocolState();
                }
            }
            cmoaComputeReadiness();
        } catch (e) {
            cmoaState.error = e;
            cmoaLog('state refresh failed', safeLogText(e && e.message));
        } finally {
            cmoaState.collecting = false;
        }
    }

    let cmoaCaptureInstalled = false;
    function cmoaInstallCapture() {
        if (cmoaCaptureInstalled) return;
        cmoaCaptureInstalled = true;
        const w = cmoaPageWindow();
        const nativeFetch = typeof w.fetch === 'function' ? w.fetch.bind(w) : null;
        if (!nativeFetch) return;
        try {
            w.fetch = function (...args) {
                let url = '';
                try {
                    const input = args[0];
                    url = typeof input === 'string' ? input : ((input && input.url) || '');
                } catch (e) { url = ''; }
                const promise = nativeFetch(...args);
                if (url && /sbcGet(?:Cntnt|Img)\.php|bibGetCntntInfo\.php/i.test(url)) {
                    promise.then(res => {
                        try {
                            if (/bibGetCntntInfo\.php/i.test(url)) {
                                return res.clone().text().then(text => cmoaIngestContentInfo(text, url)).catch(() => {});
                            }
                            if (/sbcGetImg\.php/i.test(url)) {
                                let parsed = null;
                                try { parsed = new URL(url, location.href); } catch (e) { return; }
                                const token = parsed.searchParams.get('p');
                                if (token) {
                                    if (res.status === 403) cmoaEvictToken(token);
                                    else cmoaRememberToken(token, { markGood: res.ok, force: res.ok && !cmoaState.lastGoodToken });
                                }
                            }
                        } catch (e) {}
                        return null;
                    }).catch(() => {});
                }
                return promise;
            };
        } catch (e) { }
    }

    function cmoaBuildImageUrl(descriptor, qualityOverride, tokenOverride) {
        if (!cmoaState.contentsServer) throw new Error('CMOA contents server is not available');
        if (!cmoaState.cid) throw new Error('CMOA content ID is not available');
        if (!descriptor || !descriptor.src) throw new Error('CMOA page source URL unavailable');
        let base = cmoaState.contentsServer;
        if (!base.endsWith('/')) base += '/';
        const url = new URL('sbcGetImg.php', base);
        url.searchParams.set('cid', cmoaState.cid);
        url.searchParams.set('src', descriptor.src);
        const quality = qualityOverride != null ? qualityOverride : (cmoaState.quality || CMOA_QUALITY_ORDER[0]);
        if (quality != null) url.searchParams.set('q', String(quality));
        const token = tokenOverride != null ? tokenOverride : cmoaState.token;
        if (token) url.searchParams.set('p', token);
        if (cmoaState.viewMode != null) url.searchParams.set('vm', cmoaState.viewMode);
        if (cmoaState.dmytime) url.searchParams.set('dmytime', cmoaState.dmytime);
        if (cmoaState.u0 != null) url.searchParams.set('u0', cmoaState.u0);
        if (cmoaState.u1 != null) url.searchParams.set('u1', cmoaState.u1);
        Object.keys(cmoaState.extraParams).forEach(key => {
            const value = cmoaState.extraParams[key];
            if (value == null || value === '') return;
            const lower = key.toLowerCase();
            if (['cid', 'src', 'p', 'vm', 'q', 'dmytime', 'u0', 'u1'].includes(lower)) return;
            url.searchParams.set(key, value);
        });
        return url.toString();
    }

    function cmoaContentType(headerString) {
        if (!headerString || typeof headerString !== 'string') return null;
        for (const line of headerString.split(/\r?\n/)) {
            const i = line.indexOf(':');
            if (i === -1) continue;
            if (line.slice(0, i).trim().toLowerCase() === 'content-type') {
                return line.slice(i + 1).trim() || null;
            }
        }
        return null;
    }

    async function cmoaFetchViaLanes(url, signal) {
        await waitOutCooldown();
        const t0 = performance.now();

        const allowProxy = proxyCanServe(hostOf(url));
        const res = await laneFetch(url, 45000, { allowProxy: allowProxy, signal: signal });
        if (!res || !res.ok) {
            const e = new Error('HTTP ' + (res ? res.status : '0'));
            e.status = res ? res.status : 0;
            throw e;
        }
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        recordLane(res._lane, performance.now() - t0, bytes.byteLength);
        const type = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || 'image/jpeg';
        return { bytes, type };
    }

    async function cmoaFetchBinary(url, signal) {
        const referer = location.href;
        const viaGM = () => new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('GM_xmlhttpRequest unavailable')); return; }
            let settled = false;
            const finish = fn => { if (!settled) { settled = true; fn(); } };
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: 45000,
                    responseType: 'arraybuffer',
                    headers: { 'Referer': referer, 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
                    onload: r => finish(() => {
                        if (r.status >= 200 && r.status < 300) {
                            const bytes = new Uint8Array(r.response || []);
                            resolve({ bytes, type: cmoaContentType(r.responseHeaders) || 'image/jpeg' });
                        } else {
                            const e = new Error('HTTP ' + r.status);
                            e.status = r.status;
                            reject(e);
                        }
                    }),
                    onerror: () => finish(() => reject(new Error('GM_xhr failed'))),
                    ontimeout: () => finish(() => reject(new Error('GM_xhr timeout'))),
                    onabort: () => finish(() => reject(new Error('GM_xhr aborted'))),
                });
            } catch (e) { finish(() => reject(e)); }
        });
        try {
            return await cmoaFetchViaLanes(url, signal);
        } catch (laneError) {

            if (laneError && laneError.status) throw laneError;
            cmoaLog('lane transport failed, falling back', safeLogText(laneError && laneError.message));
        }
        try {
            return await viaGM();
        } catch (gmError) {
            if (typeof GM_xmlhttpRequest === 'function' && !/unavailable/.test(gmError && gmError.message || '')) throw gmError;

            const res = await fetchWithTimeout(url, { credentials: 'omit', referer: referer, signal: signal }, 45000);
            if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
            const buf = await res.arrayBuffer();
            return { bytes: new Uint8Array(buf), type: res.headers.get('content-type') || 'image/jpeg' };
        }
    }

    async function cmoaDecodeImage(bytes, mimeType) {
        const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const blobType = (typeof mimeType === 'string' && mimeType !== 'application/octet-stream') ? mimeType : undefined;
        const blob = new Blob([buffer], { type: blobType });
        if (typeof createImageBitmap === 'function') {
            try {
                const bmp = await createImageBitmap(blob);
                return {
                    element: bmp, width: bmp.width, height: bmp.height,
                    cleanup: () => { try { if (bmp.close) bmp.close(); } catch (e) {} },
                };
            } catch (e) { }
        }
        return new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.decoding = 'async';
            img.onload = () => resolve({
                element: img,
                width: img.naturalWidth || img.width,
                height: img.naturalHeight || img.height,
                cleanup: () => { try { URL.revokeObjectURL(objectUrl); img.src = ''; } catch (e) {} },
            });
            img.onerror = e => { try { URL.revokeObjectURL(objectUrl); } catch (_) {} reject(e || new Error('image decode failed')); };
            img.src = objectUrl;
        });
    }

    async function cmoaCanvasToBlob(canvas, mime, quality) {
        const q = typeof quality === 'number' ? quality : undefined;
        if (typeof canvas.toBlob === 'function') {
            const direct = await new Promise(resolve => canvas.toBlob(resolve, mime, q));
            if (direct) return direct;
            if (mime && mime !== 'image/png') {
                const fallback = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                if (fallback) return fallback;
            }
        }
        const dataUrl = canvas.toDataURL(mime || 'image/png');
        const comma = dataUrl.indexOf(',');
        const binary = atob(comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return new Blob([out], { type: mime || 'image/png' });
    }

    function cmoaExtFor(type) {
        const t = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
        if (t === 'image/png') return 'png';
        if (t === 'image/webp') return 'webp';
        if (t === 'image/jpeg' || t === 'image/jpg') return 'jpg';
        return null;
    }

    function cmoaReadJpegSize(bytes) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
        let pos = 2;
        while (pos + 9 < data.length) {
            if (data[pos] !== 0xff) { pos++; continue; }
            const marker = data[pos + 1];
            if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { pos += 2; continue; }
            const length = (data[pos + 2] << 8) | data[pos + 3];

            const isFrame = marker >= 0xc0 && marker <= 0xcf &&
                marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isFrame) {
                const height = (data[pos + 5] << 8) | data[pos + 6];
                const width = (data[pos + 7] << 8) | data[pos + 8];
                return (width > 0 && height > 0) ? { width: width, height: height } : null;
            }
            if (length < 2) return null;
            pos += 2 + length;
        }
        return null;
    }

    function cmoaIsJpegType(type) {
        const t = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
        return t === 'image/jpeg' || t === 'image/jpg';
    }

    function cmoaNeedsNoWork(descriptor, width, height) {
        try {
            const reader = cmoaState.reader || cmoaGetReader();
            if (reader && typeof reader.getImageDescrambleCoords === 'function') {
                const plan = reader.getImageDescrambleCoords(descriptor.image || descriptor, width, height);
                return !plan || !plan.transfers;
            }
            const picked = cmoaSelectScramble(descriptor.src, cmoaState.scrambleTables);
            if (!picked) return false;
            const plan = cmoaScramblePlan(picked.coordTable, picked.pieceTable, width, height);
            return !plan || !plan.transfers;
        } catch (e) {
            return false;
        }
    }

    function cmoaBlitPlan(plan) {
        const out = [];
        if (!plan || !Array.isArray(plan.transfers) || !plan.transfers.length) return out;
        plan.transfers.forEach(transfer => {
            if (!transfer || (typeof transfer.index === 'number' && transfer.index !== 0)) return;
            const coords = Array.isArray(transfer.coords) ? transfer.coords : [];
            coords.forEach(piece => {
                if (!piece) return;
                const w = piece.width || 0, h = piece.height || 0;
                if (w <= 0 || h <= 0) return;
                out.push({
                    sx: piece.xsrc || 0, sy: piece.ysrc || 0,
                    dx: piece.xdest || 0, dy: piece.ydest || 0,
                    w: w, h: h,
                });
            });
        });
        return out;
    }

    function cmoaDescrambleError(index, why, cause) {
        const err = new Error('Cannot descramble page ' + (index + 1) + ': ' + why +
            '. CMOA pages are scrambled, so it is not being saved rather than saved unreadable.');
        err.fatal = true;
        if (cause) err.cause = cause;
        return err;
    }

    async function cmoaPreparePage(descriptor, payload) {
        const reader = cmoaState.reader || cmoaGetReader();
        const hasReader = !!(reader && typeof reader.getImageDescrambleCoords === 'function');
        if (!descriptor) throw cmoaDescrambleError(0, 'the page descriptor is missing');
        if (!hasReader && !cmoaState.scrambleTables) {
            console.warn('[bwdd/cmoa] nothing can descramble this frame: no reader and no scramble ' +
                'tables on ' + location.href + ' (viewer=' + !!cmoaState.viewer + ')');
            throw cmoaDescrambleError(descriptor.index,
                'neither the volume\u2019s reader nor its scramble tables are available on ' + location.href);
        }

        if (IMAGE_CODEC.type === 'image/jpeg' && cmoaIsJpegType(payload.type)) {
            const header = cmoaReadJpegSize(payload.bytes);
            if (header && cmoaNeedsNoWork(descriptor, header.width, header.height)) {
                cmoaReassembly.passthrough++;
                cmoaLog('page ' + (descriptor.index + 1) + ' needs no reassembly; kept as delivered');
                return { keepOriginal: true, close: function () {} };
            }
        }
        let decoded = null;
        try {
            decoded = await cmoaDecodeImage(payload.bytes, payload.type);
        } catch (e) {
            throw cmoaDescrambleError(descriptor.index, 'the image could not be decoded', e);
        }
        if (!decoded || !decoded.element || !decoded.width || !decoded.height) {
            if (decoded && decoded.cleanup) decoded.cleanup();
            throw cmoaDescrambleError(descriptor.index, 'the image decoded to nothing');
        }
        let plan = null;
        if (hasReader) {
            try {

                plan = reader.getImageDescrambleCoords(descriptor.image || descriptor, decoded.width, decoded.height);
            } catch (e) {
                if (decoded.cleanup) decoded.cleanup();
                throw cmoaDescrambleError(descriptor.index, 'the reader refused the page geometry', e);
            }
        } else {

            const picked = cmoaSelectScramble(descriptor.src, cmoaState.scrambleTables);
            if (!picked) {
                if (decoded.cleanup) decoded.cleanup();
                throw cmoaDescrambleError(descriptor.index,
                    'the volume\u2019s scramble tables do not cover this page');
            }
            try {
                plan = cmoaScramblePlan(picked.coordTable, picked.pieceTable, decoded.width, decoded.height);
            } catch (e) {
                if (decoded.cleanup) decoded.cleanup();
                throw cmoaDescrambleError(descriptor.index, 'the scramble tables were rejected', e);
            }
            if (plan.kind === 'none') {
                cmoaLog('page ' + (descriptor.index + 1) + ' is served whole (no scramble tables for it)');
            }
        }
        if (!plan || !plan.transfers) {

            console.warn('[bwdd/cmoa] the reader returned no scramble plan for page ' +
                (descriptor.index + 1) + '; keeping the image as delivered');
        }
        return {
            element: decoded.element,

            bitmap: (typeof ImageBitmap !== 'undefined' && decoded.element instanceof ImageBitmap)
                ? decoded.element : null,
            blits: cmoaBlitPlan(plan),
            width: (plan && plan.width > 0) ? plan.width : decoded.width,
            height: (plan && plan.height > 0) ? plan.height : decoded.height,
            close: () => { try { if (decoded.cleanup) decoded.cleanup(); } catch (e) {} },
        };
    }

    async function cmoaBlitInline(prepared) {
        const canvas = document.createElement('canvas');
        canvas.width = prepared.width;
        canvas.height = prepared.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2D context');

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (prepared.blits.length) {
            for (const b of prepared.blits) {
                try {
                    ctx.drawImage(prepared.element, b.sx, b.sy, b.w, b.h, b.dx, b.dy, b.w, b.h);
                } catch (drawError) { }
            }
        } else {
            ctx.drawImage(prepared.element, 0, 0);
        }
        const blob = await cmoaCanvasToBlob(canvas, IMAGE_CODEC.type, IMAGE_CODEC.quality);
        if (!blob) throw new Error('canvas encode produced nothing');
        return { blob, ext: cmoaExtFor(blob.type) };
    }

    function cmoaBlitInWorker(prepared, id) {
        return cmoaPoolSubmit({
            id: id,
            bitmap: prepared.bitmap,
            blits: prepared.blits,
            width: prepared.width,
            height: prepared.height,
            codec: { type: IMAGE_CODEC.type, quality: IMAGE_CODEC.quality },

            transfer: [prepared.bitmap],
        }).then(res => ({ blob: res.blob, ext: cmoaExtFor(res.blob.type) }));
    }

    async function cmoaProcessPage(descriptor, payload, id) {
        const passthrough = () => ({
            blob: new Blob([payload.bytes], { type: payload.type }),
            ext: cmoaExtFor(payload.type),
        });

        await cmoaAcquireSlot();
        let prepared = null;
        try {
            prepared = await cmoaPreparePage(descriptor, payload);
            if (!prepared) return passthrough();
            if (prepared.keepOriginal) return passthrough();
            if (cmoaPool && prepared.bitmap) {
                try {
                    const out = await cmoaBlitInWorker(prepared, id);
                    cmoaReassembly.worker++;
                    return out;
                } catch (e) {

                    cmoaReassembly.fallback++;
                    cmoaLog('worker descramble failed, reassembling inline', safeLogText(e && e.message));
                    try { prepared.close(); } catch (e2) {}
                    prepared = await cmoaPreparePage(descriptor, payload);
                    if (!prepared) return passthrough();
                    if (prepared.keepOriginal) return passthrough();
                }
            }
            const inline = await cmoaBlitInline(prepared);
            cmoaReassembly.inline++;
            return inline;
        } catch (e) {

            if (e && e.fatal) throw e;
            cmoaLog('descramble pipeline failed', safeLogText(e && e.message));
            return passthrough();
        } finally {
            if (prepared) { try { prepared.close(); } catch (e) {} }
            cmoaReleaseSlot();
        }
    }

    async function cmoaFetchPage(descriptor, index, signal) {
        const preferred = cmoaState.quality || CMOA_QUALITY_ORDER[0];
        const collectQualities = () => {
            const list = [];
            const push = q => {
                if (q == null) return;
                const s = String(q);
                if (list.includes(s)) return;
                if (cmoaState.qualityBlacklist.has(s)) return;
                list.push(s);
            };
            push(preferred);
            CMOA_QUALITY_ORDER.forEach(push);
            return list;
        };
        let qualities = collectQualities();

        if (!qualities.length) {
            cmoaState.qualityBlacklist.clear();
            qualities = collectQualities();
        }
        if (!qualities.length) qualities = [String(preferred || '1')];

        const tokens = [];
        const pushToken = t => {
            if (!t) return;
            const s = String(t);
            if (!tokens.includes(s)) tokens.push(s);
        };
        pushToken(cmoaState.lastGoodToken);
        pushToken(cmoaState.token);
        cmoaState.tokenPool.forEach(pushToken);
        if (!tokens.length) tokens.push(null);

        let lastError = null;
        for (const token of tokens) {

            let trustedRefusal = false;
            for (const quality of qualities) {
                if (cmoaState.qualityBlacklist.has(String(quality))) continue;
                try {
                    const url = cmoaBuildImageUrl(descriptor, quality, token);
                    cmoaLog('fetching page', index, 'quality', quality, 'token', token);
                    const tFetch = performance.now();
                    const payload = await cmoaFetchBinary(url, signal);
                    const fetchMs = performance.now() - tFetch;
                    if (quality !== cmoaState.quality) cmoaState.quality = quality;
                    if (token) cmoaRememberToken(token, { markGood: true, force: true });
                    cmoaState.qualityBlacklist.delete(String(quality));
                    cmoaState.winningRungs.add(String(quality));
                    const tProc = performance.now();
                    const processed = await cmoaProcessPage(descriptor, payload, descriptor.index);
                    if (BWDD_DEBUG) {
                        cmoaLog('page timing', index, {
                            fetchMs: Math.round(fetchMs),
                            processMs: Math.round(performance.now() - tProc),
                            bytes: payload.bytes ? payload.bytes.length : 0,
                            quality: quality,
                        });
                    }
                    return processed;
                } catch (e) {

                    if (e && e.fatal) throw e;
                    lastError = e || new Error('fetch failed');
                    const text = safeLogText((e && e.message) || e);
                    const status = Number(e && e.status) || 0;
                    cmoaLog('page fetch failed', index, 'quality', quality, text);

                    if (status === 429 || status === 503 || (status >= 500 && status < 600)) {
                        await new Promise(r => setTimeout(r, 120 + Math.round(Math.random() * 280)));
                        continue;
                    }
                    if (status === 403 || /(^|\D)403(\D|$)/.test(text)) {
                        if (cmoaState.winningRungs.has(String(quality))) trustedRefusal = true;
                        cmoaState.qualityBlacklist.add(String(quality));
                    }
                }
            }
            if (token && trustedRefusal) cmoaEvictToken(token);
        }
        if (lastError) throw lastError;
        throw new Error('Failed to download page ' + (index + 1) + ' \u2014 every image quality (' +
            CMOA_QUALITY_ORDER.join('/') + ') was refused for this volume.');
    }

    async function cmoaWarmQualityRung(descriptor) {
        try {
            const processed = await cmoaFetchPage(descriptor, 0);
            return !!(processed && processed.blob);
        } catch (e) {
            cmoaLog('rung warm failed', safeLogText(e && e.message));
            return false;
        }
    }

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

            cmoaState.winningRungs.clear();
            cmoaState.running = true;

            cmoaState.quality = CMOA_QUALITY_ORDER[0];

            let ready = false;
            for (let i = 0; i < 30; i++) {
                await cmoaRefreshState();
                if (cmoaState.ready) { ready = true; break; }
                await new Promise(r => setTimeout(r, 500));
            }
            if (!ready) {
                const missing = cmoaComputeReadiness();

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

            cmoaSetSlotLimit(await cmoaOpenProcessPool());

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

            let nextIndex = 0;
            try {
                const first = descriptors[0];
                const cachedFirst = (runOptions.usePageCache && cmoaState.cid)
                    ? await getCachedPage(cmoaState.cid, first.index)
                    : null;
                if (cachedFirst) {

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

                cmoaLog('rung probe failed, the fan-out will run the ladder per page',
                    safeLogText((e && e.message) || e));
            }

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
                    })) return;
                    noteLatency(performance.now() - t0);
                } catch (e) {

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
                    return;
                }
            }, 250);

            const LANE_SLOTS = fetchSocketBudget(true);

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

            if (hedgeTimer !== null) { clearBackgroundInterval(hedgeTimer); hedgeTimer = null; }
            while (hedgeTasks.size) { await Promise.all(Array.from(hedgeTasks)); }
            if (hedgedPages) cmoaLog('hedged ' + hedgedPages + ' slow page(s) this run');

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
                        } catch (e) { }
                    }
                };

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

        refresh() { return cmoaRefreshState(); },
        afterBoot() {

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

        debug: {
            cmoaState,
            get cmoaReassembly() { return cmoaReassembly; },
            get cmoaProcessDepth() { return cmoaProcessDepth; },
        },
        debugGlobals: {
            __bwddCmoa: cmoaState,

            __bwddCmoaScramble: {
                decodeTables: cmoaDecodeTables,
                selectScramble: cmoaSelectScramble,
                plan: cmoaScramblePlan,
                parsePageList: cmoaParsePageList,
            },
        },
    });

    const CMOA_JOB_TIMEOUT = 60000;

    const cmoaReassembly = { worker: 0, inline: 0, fallback: 0, passthrough: 0 };

    function cmoaInlineForced() {
        try { return typeof window !== 'undefined' && window.__bwddCmoaInline === true; }
        catch (e) { return false; }
    }

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

    let cmoaPool = null;
    let cmoaPoolSize = 0;

    let cmoaLastWorkers = 0;
    const cmoaPoolWaiters = new Map();

    function cmoaPoolDone(result) {
        const waiter = result && cmoaPoolWaiters.get(result.id);
        if (!waiter) return;
        cmoaPoolWaiters.delete(result.id);
        if (result.error || !result.blob) waiter.no(new Error(result.error || 'the worker returned no image'));
        else waiter.ok(result);
    }

    let cmoaJobSeq = 0;
    function cmoaPoolSubmit(job) {
        return new Promise((ok, no) => {
            const id = String(job.id) + ':' + (++cmoaJobSeq);
            cmoaPoolWaiters.set(id, { ok: ok, no: no });
            cmoaPool.submit(Object.assign({}, job, { id: id }));
        });
    }

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

    const CMOA_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const CMOA_CHAR_VALUE = (function () {
        const table = new Int8Array(128).fill(-1);
        for (let i = 0; i < CMOA_B64.length; i++) table[CMOA_B64.charCodeAt(i)] = i;
        return table;
    })();

    function cmoaCharValue(ch) {
        const code = ch.charCodeAt(0);
        return code < 128 ? CMOA_CHAR_VALUE[code] : -1;
    }

    function cmoaRandomString(length) {
        let out = '';
        for (let i = 0; i < length; i++) out += CMOA_B64[(Math.random() * CMOA_B64.length) | 0];
        return out;
    }

    function cmoaGenerateK(cid) {
        const nonce = cmoaRandomString(16);
        const repeated = new Array(Math.ceil(16 / String(cid).length) + 1).join(String(cid));
        const head = repeated.substr(0, 16);
        const tail = repeated.substr(-16, 16);
        let xorNonce = 0, xorHead = 0, xorTail = 0;
        return nonce.split('').map(function (ch, i) {
            xorNonce ^= nonce.charCodeAt(i);
            xorHead ^= head.charCodeAt(i);
            xorTail ^= tail.charCodeAt(i);
            return ch + CMOA_B64[(xorNonce + xorHead + xorTail) & 63];
        }).join('');
    }

    function cmoaDecodeTable(cid, k, encoded) {
        if (typeof encoded !== 'string') throw new TypeError('cmoaDecodeTable: encoded table must be a string');
        const seed = cid + ':' + k;
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {

            hash += seed.charCodeAt(i) << (i % 16);
        }
        hash &= 0x7fffffff;
        if (hash === 0) hash = 0x12345678;
        let state = hash;
        let out = '';
        for (let i = 0; i < encoded.length; i++) {
            state = ((state >>> 1) ^ (1210056708 & -(state & 1))) >>> 0;
            out += String.fromCharCode(((encoded.charCodeAt(i) - 32 + state) % 94) + 32);
        }
        return JSON.parse(out);
    }

    function cmoaDecodeTables(cid, k, item) {
        const out = {};
        for (const key of ['stbl', 'ttbl', 'ctbl', 'ptbl']) {
            const encoded = item ? item[key] : null;
            if (typeof encoded !== 'string' || !encoded) continue;
            try {
                out[key] = cmoaDecodeTable(cid, k, encoded);
            } catch (e) {
                cmoaLog('scramble table ' + key + ' did not decode', safeLogText(e && e.message));
            }
        }
        return out;
    }

    function cmoaSelectScramble(src, tables) {
        const sums = [0, 0];
        if (src && tables) {
            const start = String(src).lastIndexOf('/') + 1;
            for (let i = 0; i < String(src).length - start; i++) {
                sums[i % 2] += String(src).charCodeAt(start + i);
            }
            sums[0] %= 8;
            sums[1] %= 8;
        }
        if (!tables || !Array.isArray(tables.ptbl) || !Array.isArray(tables.ctbl)) return null;
        return {
            checksum: sums,
            pieceTable: tables.ptbl[sums[0]],
            coordTable: tables.ctbl[sums[1]],
        };
    }

    function cmoaDescribeScramble(coordTable, pieceTable) {
        const coord = String(coordTable == null ? '' : coordTable);
        const piece = String(pieceTable == null ? '' : pieceTable);
        if (coord === '' && piece === '') return 'none';
        if (coord.charAt(0) === '=' && piece.charAt(0) === '=') return 'tiled';
        if (/^[0-9]/.test(coord) && /^[0-9]/.test(piece)) return 'numeric';
        return 'unknown';
    }

    function cmoaParseTiledPattern(pattern) {
        const m = /^=([0-9]+)-([0-9]+)([-+])([0-9]+)-([-_0-9A-Za-z]+)$/.exec(String(pattern));
        if (!m) return null;
        return {
            rows: parseInt(m[1], 10),
            cols: parseInt(m[2], 10),
            sign: m[3],
            padding: parseInt(m[4], 10),
            body: m[5],
        };
    }

    function cmoaTiledSection(T, j, body) {
        const values = [];
        for (let i = 0; i < T + j + T * j; i++) {
            const value = cmoaCharValue(body.charAt(i));
            values.push(value < 0 ? 0 : value);
        }
        return {
            colShift: values.slice(0, T),
            rowShift: values.slice(T, T + j),
            perm: values.slice(T + j),
        };
    }

    function cmoaTiledDescrambler(coordTable, pieceTable) {
        const coord = cmoaParseTiledPattern(coordTable);
        const piece = cmoaParseTiledPattern(pieceTable);
        if (!coord || !piece) throw new Error('invalid tiled scramble pattern');
        if (coord.rows !== piece.rows || coord.cols !== piece.cols ||
            coord.padding !== piece.padding || coord.sign !== '+' || piece.sign !== '-') {
            throw new Error('tiled scramble patterns disagree');
        }
        const T = coord.rows;
        const j = coord.cols;
        const Dt = coord.padding;
        if (T > 8 || j > 8 || T * j > 64) throw new Error('tiled scramble pattern too large');
        const expected = T + j + T * j;
        if (coord.body.length !== expected || piece.body.length !== expected) {
            throw new Error('tiled scramble body has the wrong length');
        }
        const s = cmoaTiledSection(T, j, coord.body);
        const h = cmoaTiledSection(T, j, piece.body);

        const Rt = s.rowShift, Ft = s.colShift, Lt = h.rowShift, Nt = h.colShift;
        const kt = [];
        for (let i = 0; i < T * j; i++) kt.push(s.perm[h.perm[i]]);

        const applies = (width, height) => {
            const t = 2 * T * Dt;
            const jj = 2 * j * Dt;
            return width >= 64 + t && height >= 64 + jj && width * height >= (320 + t) * (320 + jj);
        };
        return {
            kind: 'tiled',
            applies: applies,
            displaySize: function (width, height) {
                if (!applies(width, height)) return { width: width, height: height };
                return { width: width - 2 * T * Dt, height: height - 2 * j * Dt };
            },

            regions: function (width, height) {
                const identity = [{ xsrc: 0, ysrc: 0, width: width, height: height, xdest: 0, ydest: 0 }];
                if (!applies(width, height)) return identity;
                const i = width - 2 * T * Dt;
                const n = height - 2 * j * Dt;
                const r = Math.floor((i + T - 1) / T);
                const e = i - (T - 1) * r;
                const sz = Math.floor((n + j - 1) / j);
                const hh = n - (j - 1) * sz;
                const out = [];
                for (let o = 0; o < T * j; o++) {
                    const a = o % T;
                    const f = Math.floor(o / T);
                    const c = Dt + a * (r + 2 * Dt) + (Lt[f] < a ? e - r : 0);
                    const l = Dt + f * (sz + 2 * Dt) + (Nt[a] < f ? hh - sz : 0);
                    const v = kt[o] % T;
                    const d = Math.floor(kt[o] / T);
                    const ws = v * r + (Rt[d] < v ? e - r : 0);
                    const hs = d * sz + (Ft[v] < d ? hh - sz : 0);
                    const w = Lt[f] === a ? e : r;
                    const m = Nt[a] === f ? hh : sz;
                    if (i > 0 && n > 0) {
                        out.push({ xsrc: c, ysrc: l, width: w, height: m, xdest: ws, ydest: hs });
                    }
                }
                return out;
            },
        };
    }

    function cmoaCompileDescrambler(coordTable, pieceTable, where) {
        const kind = cmoaDescribeScramble(coordTable, pieceTable);
        if (kind === 'tiled') return cmoaTiledDescrambler(coordTable, pieceTable);
        if (kind === 'numeric') {
            throw new Error('this volume uses the numeric scramble layout, which is not implemented' +
                (where ? ' (' + where + ')' : '') + '; only the tiled layout has been verified');
        }
        if (kind === 'unknown') {
            throw new Error('unrecognised CMOA scramble tables' + (where ? ' (' + where + ')' : '') +
                ': coord=' + JSON.stringify(String(coordTable).slice(0, 24)) +
                ' piece=' + JSON.stringify(String(pieceTable).slice(0, 24)));
        }
        return {
            kind: 'none',
            applies: function () { return false; },
            displaySize: function (width, height) { return { width: width, height: height }; },
            regions: function (width, height) {
                return [{ xsrc: 0, ysrc: 0, width: width, height: height, xdest: 0, ydest: 0 }];
            },
        };
    }

    function cmoaScramblePlan(coordTable, pieceTable, width, height) {
        const engine = cmoaCompileDescrambler(coordTable, pieceTable, 'page ' + width + 'x' + height);
        const size = engine.displaySize(width, height);
        return {
            kind: engine.kind,
            width: size.width,
            height: size.height,
            transfers: [{ index: 0, coords: engine.regions(width, height) }],
        };
    }

    function cmoaTtxAttributes(text) {
        const out = {};
        const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
        let m;
        while ((m = re.exec(text)) !== null) out[m[1].toLowerCase()] = m[2];
        return out;
    }

    function cmoaTtxPages(ttx) {
        const pages = [];
        const re = /<(t-pb|t-img|img|a)(\s+([^>]*)|)>/gi;
        let match;
        while ((match = re.exec(ttx)) !== null) {
            const tag = match[1].toLowerCase();
            if (tag !== 't-img' && tag !== 'img') continue;
            const attrs = cmoaTtxAttributes(match[2] || '');
            const src = String(attrs.src || '').trim();
            const width = parseInt(attrs.orgwidth, 10) || 0;
            const height = parseInt(attrs.orgheight, 10) || 0;
            if (!src || !width || !height) continue;
            pages.push({
                src: src,
                id: attrs.id || '',
                width: width,
                height: height,
                spread: attrs.a != null ? attrs.a : '',
            });
        }
        return pages;
    }

    function cmoaParsePageList(ttx) {
        if (typeof ttx !== 'string' || !ttx) return [];
        const landscape = ttx.replace(/<t-case\s+[^>]*screen\.portrait[^>]*>([\s\S]*?)<\/t-case>/gi, '');
        return cmoaTtxPages(landscape);
    }

    const BWDD_SITE = detectSite();
    ACTIVE_SITE = BWDD_SITE;
    if (BWDD_SITE) {
        if (typeof BWDD_SITE.install === 'function') {
            try { BWDD_SITE.install(); } catch (e) {}
        }

        installHeadlessAutomation();

        try {
            if (typeof probeFetchProxy === 'function' && !isHeadlessPage()) {
                const refreshPorts = () => { try { probeFetchProxy().catch(() => {}); } catch (e) {} };
                refreshPorts();
                if (typeof setBackgroundInterval === 'function') setBackgroundInterval(refreshPorts, 30000);
            }
        } catch (e) {}
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => bootSharedPanel(BWDD_SITE));
        } else {
            bootSharedPanel(BWDD_SITE);
        }
    }

    if (BWDD_SITE && BWDD_DEBUG && !isHeadlessPage()) {
        try {
            const dbg = {
                cleanTitle, splitSeriesVolume, fsSafePath, zipBaseName, crc32Bytes, buildStoreZip,
                get imageCodec() { return IMAGE_CODEC; }, resolveImageCodec,

                allLanes, fetchSocketBudget, rawSocketBudget, laneStats, laneSummary, recordLane, dedupeInflight,
                addProxyPorts, clearProxySource,
                CHROMIUM_SOCKETS_PER_PROCESS, CONTROL_PLANE_SOCKET_RESERVE, MAX_DATA_PLANE_SOCKETS,
                probeFetchProxy, probeDotLane, probeEdgeMirror, discoverProxyPorts,
                setProxyUpstreams, proxyCanServe,
                dottedUrl, edgeUrlFor, proxyPorts, laneFetch, capabilitySummary, workerPoolSize, workerBatchSize, makePool,
                proxyLaneFetch, proxyLaneAvailable,
                canSpawnBlobWorker, clearPageCache,

                setBackgroundInterval, clearBackgroundInterval, backgroundDelay, yieldToTasks,

                mokuroClient: {
                    bridgeUrl: MOKURO_BRIDGE_URL,
                    startSession: mokuroStartSession,
                    streamPage: mokuroStreamPage,
                    uploadCover: mokuroUploadCover,
                    status: mokuroStatus,
                    finalize: mokuroFinalize,
                    uploadPlan: mokuroUploadPlan,
                    readerJumpUrl,
                    makeNdjsonSink,
                    readNdjsonText,
                    readNdjsonStream,
                },
                get gmUsable() { return gmUsable; },
                get proxyRealmBlocked() { return proxyRealmBlocked; },
                resetProxyRealmFlag,
            };

            Object.assign(dbg, (BWDD_SITE && BWDD_SITE.debug) || {});
            debugRealm().__bwdd = dbg;
        } catch (e) {}
        try {
            debugRealm().__bwddUI = Object.assign(debugRealm().__bwddUI || {},
                { renderStatsCards, renderBookCard, renderNativelyCard, renderMangaKotobaCard, setBar, showBars });
        } catch (e) {}

        try { debugRealm().__bwddSite = BWDD_SITE; } catch (e) {}
        for (const k in ((BWDD_SITE && BWDD_SITE.debugGlobals) || {})) {
            try { debugRealm()[k] = BWDD_SITE.debugGlobals[k]; } catch (e) {}

            try { window[k] = debugRealm()[k]; } catch (e) {}
        }
    }

})();
