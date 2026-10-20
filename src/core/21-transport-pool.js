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

        // The job envelope belongs to the site module: BookWalker ships its own
        // relPath/seeds/q shape, ebookjapan ships page geometry and session
        // material. A site that supplies no builder keeps the original shape.
        const messageFor = typeof buildMessage === 'function' ? buildMessage : function (job) {
            const message = {
                id: job.id, relPath: job.relPath, seeds: job.seeds,
                q: job.q, fmt: job.fmt, needCrc: !!job.needCrc, timeoutMs: jobTimeoutMs,
            };
            // The main-thread prefetcher already downloaded this page, so pass
            // the Blob (structured-cloneable, unlike an ArrayBuffer) instead of
            // re-fetching through the six-socket origin.
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
        // A job may name objects that must be *moved* into the worker rather than
        // copied. An ImageBitmap is a whole decoded frame, so structured-cloning
        // one costs about as much as the decode it is meant to avoid. A site
        // lists them on the job and its buildMessage puts the same objects in the
        // message; BookWalker and ebookjapan ship only plain data and never set
        // this, so their envelopes transfer nothing.
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
            // A timed-out page may still own native codec work. Preserve every
            // sibling that did finish, but never reuse that worker.
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
            // A failed structured clone leaves this worker idle. Revisit the
            // queue once so one bad job cannot stall every page behind it.
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
            // Coalesce synchronous submissions: pumping on every submit would
            // defeat batching before the second page ever reached the queue.
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
            // The worker source belongs to a site module, so a build without
            // one simply has no worker pool rather than a broken reference.
            if (typeof buildWorkerSource !== 'function') return false;
            const src = buildWorkerSource();
            const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            const w = new Worker(url);
            w.terminate();
            URL.revokeObjectURL(url);
            return true;
        } catch (e) { return false; }
    }

    // A page Content-Security-Policy that forbids blob: workers does not make
    // `new Worker(blobUrl)` throw — the constructor succeeds and the worker
    // fires `error` instead. A synchronous probe therefore reports success on a
    // page that can never run one, and the pool would respawn a blocked worker
    // on every job and bury the console. This waits for a real round trip.
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

    // Chrome allows 6 concurrent HTTP/1.1 connections per origin (scheme + host
    // + PORT), and the CDN is a single HTTP/1.1 host, so the page alone is pinned
    // at 6. Extra lanes: `gm` (Tampermonkey's own pool) and `px:N` (a local helper
    // port; each is a separate origin and the script bounds the fan-out).
    const PROXY_HOST = 'http://127.0.0.1:';
    const PROXY_BASE_PORT = 7010;
    // Each localhost port is a separate HTTP/1.1 origin. Chromium's normal
    // group limit is 6 per origin; it is not a 300-socket global cap. Keep a
    // finite bridge fan-out so a misconfigured helper cannot create unbounded
    // work, while allowing a bridge that exposes more ports to use them.
    const PROXY_MAX_PORTS = 64;
    // A failing port is parked, not deleted: a wide burst can fail every port at
    // once, and deleting them collapses the run onto the 6-socket page lane.
    const PROXY_ERROR_PARK = 12;
    const PROXY_PARK_MAX = 5;
    const PROXY_PARK_MS = 4000;
    const PROXY_RETIRE_MS = 90000;
    let gmUsable = (typeof GM_xmlhttpRequest === 'function');
    // Set when the page realm demonstrably cannot reach loopback at all, which is
    // not a bridge fault: ebookjapan serves `connect-src 'self' https: wss:`, so
    // `fetch('http://127.0.0.1:<port>')` is refused by CSP before a socket opens.
    // GM_xmlhttpRequest runs in the extension's context and is not subject to the
    // page's CSP, so every later loopback request rides GM instead of paying a
    // refused request first. It stays false for a page that is merely offline.
    let proxyRealmBlocked = false;
    const proxyPorts = [];
    const proxyPortSources = new Map();
    // A retired port is on a cooldown, not dead for the page's lifetime: the
    // burst that killed it may have passed, and the bridge may have restarted
    // its proxy since. Without this, a long run can only ever lose lanes.
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

    // Chrome keys its socket pool by *site*, so a subdomain of a host we can
    // already reach buys nothing; "host." (trailing dot) is a distinct host and
    // gets its own pool. The signed policy covers a path wildcard, so the dot
    // cannot break the signature, but whether CloudFront serves it is not
    // knowable in advance, so the lane self-verifies on a real page and a
    // rejection costs one request.
    let dotLaneEnabled = false;
    function dottedUrl(url) {
        // Dot the HOSTNAME only: appending it to the authority would give
        // "host:8443." and corrupt the port. The rest of
        // the URL is left byte-identical so the signed query is untouched.
        //   https://a.example.com:8443/x -> https://a.example.com.:8443/x
        return url.replace(/^(https?:\/\/)([^/?#:]+)(:\d+)?/, (m, scheme, hostname, port) => {
            if (hostname.endsWith('.') || /^[\d.]+$/.test(hostname)) return m; // already dotted / an IP
            return scheme + hostname + '.' + (port || '');
        });
    }
    async function probeDotLane(probeUrl) {
        if (!probeUrl) return false;
        try {
            const res = await fetchWithTimeout(dottedUrl(probeUrl), { credentials: 'omit' }, 8000);
            if (res && res.ok) {
                // Only the status matters, and the body is a whole page (173 KB
                // on a real CMOA volume) that would otherwise be pulled down and
                // thrown away. Cancelling it also frees the socket for the run.
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

    // HTTP/2 edge-mirror lane (self-verifying, strictly opt-in). The CDN answers
    // "http/1.1 only" over ALPN, which is what makes the 6-socket cap bind; a host
    // speaking HTTP/2 multiplexes many streams over one connection (measured: 100
    // concurrent, ~8.9x the direct path). It is the only route past the cap with
    // nothing running locally, but it sends the signed URL through whoever runs
    // the mirror, so it stays opt-in. See bw-edge-mirror.js.
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
    // Six everywhere except the edge mirror, which multiplexes many streams over
    // one HTTP/2 connection, so it should absorb proportionally more traffic.
    function laneCapacity(L) {
        return L && L.kind === 'edge' ? 100 : 6;
    }
    // Per-*origin* capacity is 6, but that is not the only ceiling: Chromium's
    // socket pools also bound a profile. "Currently these are set to 32 sockets
    // per proxy, 6 sockets per destination host, and 256 sockets per process
    // (not implemented exactly correctly, but good enough)."
    //       https://www.chromium.org/developers/design-documents/network-stack/
    // Summing 6 per advertised port is right per origin and wrong in total: a
    // bridge advertising 48 ports computes 300 sockets, so ~20% of the budget is
    // unreachable and — worse — the pool is shared with the requests that must
    // not queue behind a page burst (the auth policy refresh, the manifest, and
    // the bridge /health polls). Reserving headroom keeps the control plane
    // responsive while the data plane still uses everything the profile allows.
    const CHROMIUM_SOCKETS_PER_PROCESS = 256;
    const CONTROL_PLANE_SOCKET_RESERVE = 16;
    const MAX_DATA_PLANE_SOCKETS = CHROMIUM_SOCKETS_PER_PROCESS - CONTROL_PLANE_SOCKET_RESERVE;
    // Sizes the prefetch window: a small multiple of the real socket capacity.
    function fetchSocketBudget(onlineOnly) {
        let n = 0;
        for (const L of allLanes(onlineOnly)) n += laneCapacity(L);
        n = Math.min(n, MAX_DATA_PLANE_SOCKETS);
        return n;
    }
    // The unclamped sum, only so the panel and the tests can say how much of the
    // advertised fan-out the profile can actually carry.
    function rawSocketBudget(onlineOnly) {
        let n = 0;
        for (const L of allLanes(onlineOnly)) n += laneCapacity(L);
        return n;
    }

    // NOTE: named gmBlobFetch, not gmFetch, the stats section further down
    // already declares a `gmFetch` in this same scope, and a duplicate function
    // declaration hoists with the *last* one winning for the whole scope.
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

    // GM_xmlhttpRequest hands the response headers back as one raw block rather
    // than a Headers object. Only one caller needs them (telling the bridge's
    // JSON refusal of a host apart from a CDN answer), so this exposes that much.
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

    // Read a JSON document from loopback without assuming the page realm is
    // allowed to. The page fetch is tried first because it is cheaper and is what
    // every non-sealed site (BookWalker, CMOA) has always used; GM is the retry.
    // If GM then answers a host the realm just failed on, the realm is sealed and
    // the flag sticks for the rest of the page's life.
    async function loopbackJson(url, timeoutMs) {
        if (!proxyRealmBlocked) {
            try {
                const r = await fetchWithTimeout(url, { credentials: 'omit', cache: 'no-store' }, timeoutMs);
                if (r.ok) return await r.json();
            } catch (e) { /* refused or nothing listening; GM gets the deciding vote */ }
        }
        // Gated on the API, not on `gmUsable`: the gm lane clears that flag after
        // five failures of its own, and discovery must not stop working because
        // some other request retired an unrelated lane.
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

    // Which hosts the bridge's proxy ports will fetch: it rewrites the request
    // onto x-bwdd-upstream and refuses any host outside its own allowlist, so a
    // port is only usable for a CDN the bridge accepts ("*" = generic). A bridge
    // too old to advertise the list is assumed to serve only the BookWalker CDN,
    // which keeps an existing setup working without aiming a CMOA path at a host
    // that would answer from the wrong CDN.
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

    // How a proxy port is told which CDN to fetch. The older contract is the
    // x-bwdd-upstream header; naming the host as a path segment is worth having
    // because a custom header makes the request "non-simple", and a browser
    // answers every *unique* URL with its own CORS preflight - one per page,
    // since every page has its own signed query. A path-named host stays a
    // simple request, so nothing is preflighted at all. Measured on a 160-page
    // CMOA volume: 299 preflights, each blocking its own page's GET, worth
    // ~3.8 s of the run. Only sources that advertise the capability use it.
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
                // Cooled down: let it back in with a clean slate, or its very
                // next park would retire it again on the old count.
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

    // mokuro-bridge doubles as an accelerator: it serves the CDN on extra
    // localhost ports (each its own 6-socket origin) advertised in /health, so a
    // user already running it for OCR gets those lanes with no setup.
    // Downloading never *depends* on it, no bridge simply means no lanes.
    async function probeBridgeFetchProxy() {
        // loopbackJson falls back to GM, so a page whose CSP forbids http://
        // loopback still finds the bridge instead of silently running unaccelerated.
        const j = await loopbackJson(MOKURO_BRIDGE_URL + '/health', 2500);
        // Cleared only on an answer. Wiping first meant a /health that timed out
        // threw away a port list that was working, and the next run found nothing
        // to size against and paid for the probe again - the number the prep line
        // kept reporting. A bridge that is genuinely gone has its ports fail and
        // retire on their own.
        if (!j) return;
        clearProxySource('bridge');
        if (j.fetchUpstreams || j.upstream) {
            setProxyUpstreams(j.fetchUpstreams, j.upstream);
        }
        if (Array.isArray(j.fetchProxyPorts) && j.fetchProxyPorts.length) {
            // fetchPathUpstream is the bridge saying it will take the CDN
            // from a path segment, which is what keeps a page request simple
            // and therefore un-preflighted. A bridge too old to advertise it
            // keeps the header, i.e. exactly today's behaviour.
            addProxyPorts(j.fetchProxyPorts, 'bridge', { pathUpstream: !!j.fetchPathUpstream });
        }
    }

    // Discover the optional local fetch proxy. If the helper is not running this
    // is one failed request to a closed local port and the run proceeds on the
    // page + gm lanes exactly as before. If it had to move off 7010 (port in use),
    // point the script at it with `window.__bwddProxyBasePort = 7100;`.
    async function probeFetchProxy() {
        return await discoverProxyPorts();
    }

    // Discovery is asked for by the panel's poll and by every run, and it costs a
    // real round trip: the bridge's /health is ~0.7s server-side on this machine
    // and more once GM has carried it. Callers that overlap share one probe.
    // Deliberately *not* cached by time: a bridge can be restarted or reconfigured
    // while a page is open, and an answer from twenty seconds ago is not the
    // current capability set. Freshness belongs to the caller, which is why a run
    // with ports already in hand does not wait for this at all.
    let discoveryInFlight = null;

    // Re-run discovery so the panel's pre-flight indicator lights up bridge ports
    // that started *after* the page loaded; source ownership and retirement decide
    // which lanes remain selectable.
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
        // The helper and the bridge answer on different ports and neither needs
        // the other's answer first, so ask both at once. In series the run paid
        // both timeouts end to end, and the helper's is the one that always
        // expires when only the bridge is running - which is every normal setup.
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

    // Last known bridge reachability, mirrored out of buildUI's poll, for the
    // bridge/OCR status shown in the panel; the per-port source map decides which
    // discovered proxy lanes are usable now.
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
            // True when the advertised fan-out is past the profile ceiling, so
            // the panel can say so instead of promising sockets that cannot open.
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

    // Least-*utilised* lane wins (in-flight divided by capacity), so the 6-socket
    // lanes fill up while the edge mirror keeps absorbing work; the tie-break
    // rotates so even a low-concurrency run touches every lane.
    let laneRR = 0;
    // allowProxy=false keeps a request off the local fetch-proxy lanes: they are
    // not transparent forwarders, so a port advertised for one store's CDN would
    // answer every other store's path from the wrong host (a 404 at best). A
    // caller fetching a CDN the proxy was not configured for must opt out.
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

    // The same mirroring, with the CDN named as a path segment instead of a
    // header. A GET with no custom header is a CORS "simple request", so the
    // browser sends it without asking permission first; the x-bwdd-upstream
    // form is not, and every unique page URL then costs its own OPTIONS.
    function proxyPathUrlFor(port, host, url) {
        return PROXY_HOST + port + PATH_UPSTREAM_PREFIX + host + url.replace(/^https?:\/\/[^/?#]+/, '');
    }


    // A failing lane is parked (helper port) or retired rather than deleted
    // outright: a wide burst can fail every lane at once, and dropping them
    // collapses the run onto the page lane.
    function laneRetireLimit(lane) {
        if (lane.kind === 'gm') return 5;
        if (lane.kind === 'proxy') return PROXY_ERROR_PARK;
        return 8;   // edge, dot
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
            // The proxy carries only path + query, so it must be told which CDN
            // the bytes come from. The bridge rejects any host outside its
            // allowlist with a JSON 403, which laneFetch treats as a lane failure
            // rather than an answer from the CDN. A request for the CDN the
            // bridge already defaults to names nothing at all; only a different
            // CDN has to identify itself, which is what lets one bridge serve
            // several stores without a second instance.
            //
            // Naming it in a header costs a CORS preflight per unique URL - one
            // per page - because a custom header is not a CORS-simple request.
            // A bridge that advertises the path form takes the host from the URL
            // instead, so the request stays simple and nothing is preflighted.
            const opts = { credentials: 'omit' };
            const host = hostOf(url);
            // The path form names the CDN outright, so use it whenever the bridge
            // understands it - including when the host happens to equal the
            // bridge's own default upstream. Skipping the name in that case makes
            // the request depend on the bridge's default being right, and a stale
            // or reassigned default answers from the wrong CDN, which arrives as a
            // 404 or a wrong-page body rather than as an error. The header form is
            // the older spelling and costs a preflight, so it stays limited to the
            // case that needs it.
            let target = proxyUrlFor(lane.port, url);
            if (host && lane.pathUpstream) target = proxyPathUrlFor(lane.port, host, url);
            else if (host && host !== proxyDefaultHost) opts.headers = { 'x-bwdd-upstream': host };
            // A sealed page realm cannot open the port at all, and the port is
            // worth more here than anywhere else: each one is its own origin, so
            // GM_xhr across 48 ports is 48 socket pools instead of the single one
            // a direct GM request to the CDN gets. Same mirroring, same refusals.
            // GM is not subject to CORS or to the page's CSP, so it can always
            // name the host - no preflight to pay and no trust in the bridge's
            // default. A bridge that predates the path form gets the header.
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
                // The realm failing is the evidence, not a probe that ran earlier:
                // ebookjapan allows `connect-src 'self' https:` only, so
                // http://127.0.0.1:<port> is refused before a socket opens, and an
                // up-front check can be stale by the time a page is fetched (the gm
                // lane can be retired for unrelated reasons, discovery can have run
                // before the flag existed). If GM reaches the same port, the realm
                // is sealed, and no later page pays this attempt again.
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

    // Put the transport back into its cold-page state: nothing has yet learned
    // whether this page's realm can reach a loopback port. Discovery normally runs
    // at page load and settles the question before a run starts, so this exists to
    // exercise the self-heal path that a click-immediately-after-load still takes.
    function resetProxyRealmFlag() { proxyRealmBlocked = false; }

    // Say once per run why a port did not answer. Swallowing this is what turned
    // "every page fell back to the CDN" into a hunt: the run reported lanes gm
    // and nothing anywhere said the ports had been asked and refused.
    let gmProxyLastNote = '';
    function gmProxyNote(why) {
        if (why === gmProxyLastNote) return;
        gmProxyLastNote = why;
        console.warn('[bwdd] fetch proxy lane unusable: ' + why);
    }

    // The accelerator mirror over GM_xmlhttpRequest, for a page whose CSP forbids
    // the realm from opening a loopback port. Gated on the API *existing* rather
    // than on `gmUsable`, which the gm lane clears after five unrelated failures:
    // retiring that lane must not take the accelerator down with it.
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

    // The attempt plus its lane bookkeeping, without laneFetch's page-lane
    // fallback: a caller that must know whether the accelerator answered (rather
    // than silently getting the page origin) needs the failure to surface.
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

    // Whether any accelerator port is usable right now, for a caller that would
    // otherwise have to guess whether asking for one is worth the round trip.
    function proxyLaneAvailable() {
        return allLanes(true).some(L => L.kind === 'proxy');
    }

    // Fetch through an accelerator port and nothing else, returning null when no
    // port is online or the attempt failed. This exists for a site whose only
    // alternative is a single origin: 48 ports are 48 socket pools, and a caller
    // that cannot tell the difference would not know it was leaving them idle.
    async function proxyLaneFetch(url, timeoutMs) {
        // The proxy is not a transparent forwarder: a port aimed at another
        // store's CDN would answer this path from the wrong host (a 404 at best),
        // so a caller that cannot opt out per request has to be refused here.
        if (!proxyCanServe(hostOf(url))) return null;
        const px = allLanes(true).filter(L => L.kind === 'proxy');
        if (!px.length) return null;
        // Least-utilised of the ports, so a wide run actually spreads across all
        // of them instead of walking the list from the front.
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

    // Deliberately no per-lane pages/sec: a lane has no wall-clock window of its
    // own, so dividing pages by *summed request time* just reports 1/latency (a
    // real run printed 0.7/s per lane while the batch did 15 pages/s, ~21 requests
    // in flight). Share plus mean latency shows whether a lane is pulling weight.
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
    // Collapse concurrent requests for the same key onto one promise: retry rounds
    // and duplicated manifest entries legitimately ask for the same page twice
    // otherwise. The entry is dropped as soon as it settles, so a later retry
    // round can still re-fetch a page that genuinely failed.
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


