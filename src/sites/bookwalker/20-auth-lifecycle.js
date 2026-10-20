    let authRefreshPromise = null;
    let pbCounter = 0;
    // Refresh the CloudFront auth policy, coalesced so concurrent callers share
    // one in-flight request. A fresh public viewer must use its native opening
    // exchange first; rolling renewal uses the viewer's bookmark channel:
    //   'c' , GET /browserWebApi/c with the params the viewer sends when
    //          opening a book; a fresh reply replaces auth/baseUrl/cti.
    //   'pb', POST a reading-position bookmark to the viewer's own
    //          token-renewal channel; only used after capture starts.
    function refreshAuthOnce(mode) {
        if (!authRefreshPromise) {
            authRefreshPromise = (async () => {
                let d;
                if (mode === 'pb') {
                    const ts = new Date();
                    const pad = n => String(n).padStart(2, '0');
                    const dateStr = ts.getFullYear() + '-' + pad(ts.getMonth() + 1) + '-' + pad(ts.getDate()) +
                        'T' + pad(ts.getHours()) + ':' + pad(ts.getMinutes()) + ':' + pad(ts.getSeconds()) + '+0900';
                    pbCounter = (pbCounter || 0) + 1;
                    const pbPos = 'OEBPS/text/p-' + String((pbCounter % 900) + 1).padStart(4, '0') + '.xhtml';
                    const bookmark = JSON.stringify({
                        date: dateStr, position: pbPos,
                        position_later_page: '', pr: (pbCounter % 7), type: 'epub', finished: 0,
                        bookmark_suffix_max: 1, bookmarks: [],
                    });
                    const form = new URLSearchParams();
                    form.set('cid', state.cid);
                    if (getU1()) form.set('u1', getU1());
                    form.set('BID', getBID());
                    form.set('timestamp', '');
                    form.set('bookmark', bookmark);
                    const res = await fetchWithTimeout(apiBase() + '/browserWebApi/pb', {
                        method: 'POST',
                        credentials: isPublicBootstrapPage() ? 'include' : (isHeadlessPage() ? 'omit' : 'include'),
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                        body: form.toString(),
                    }, isPublicBootstrapPage() ? 12000 : 20000);
                    d = await res.json();
                    if (d && d.auth_info) {
                        // pb merges over the current auth; only a changed
                        // policy/signature resets the request-count budget.
                        const before = authPolicySig();
                        state.auth = Object.assign({}, state.auth || {}, d.auth_info);
                        if (authPolicySig() !== before) resetAuthBudget();
                    }
                } else {
                    const cr = Math.floor(Math.random() * 9e18);
                    const u1 = getU1();
                    const bid = getBID();
                    // The native viewer's opening exchange sends only cid/BID/cr.
                    // It has no u1 cookie on this route, so u1 is optional and must
                    // never fail the request closed. (The previous guard returned a
                    // fabricated status 503 whenever u1 was absent, which is why the
                    // free-volume capture never reached the server.)
                    let url = apiBase() + '/browserWebApi/c?cid=' + encodeURIComponent(state.cid);
                    if (u1) url += '&u1=' + encodeURIComponent(u1);
                    url += '&BID=' + encodeURIComponent(bid) + '&cr=' + cr;
                    const res = await fetchWithTimeout(url, { credentials: isPublicBootstrapPage() ? 'include' : (isHeadlessPage() ? 'omit' : 'include') }, isPublicBootstrapPage() ? 12000 : 20000);
                    d = await res.json();
                    if (d.status === '200' && d.auth_info && d.url) {
                        state.auth = d.auth_info;
                        state.baseUrl = d.url;
                        state.cti = d.cti || state.cti;
                    }
                }
                return d;
            })();
            // Attach both cleanup branches explicitly. A bare finally() returns
            // a second promise that can become an unhandled rejection when the
            // refresh request itself fails, even though its caller catches the
            // original promise.
            authRefreshPromise.then(
                () => { authRefreshPromise = null; },
                () => { authRefreshPromise = null; }
            );
        }
        return authRefreshPromise;
    }
    const refreshAuthViaPb = () => refreshAuthOnce('pb');
    const refreshAuthViaC = () => refreshAuthOnce('c');

    async function refreshAuthBest() {
        const before = authPolicySig();
        try {
            const d = await refreshAuthViaPb();
            if (authPolicySig() !== before) return { method: 'pb', fresh: true, d };
        } catch (e) {}
        try {
            const d = await refreshAuthViaC();
            if (authPolicySig() !== before) return { method: 'c', fresh: true, d };
        } catch (e) {}
        return { method: 'none', fresh: false };
    }

    async function refreshAuthTrial() {
        const cr = Math.floor(Math.random() * 9e18);
        const bid = getBID();
        const url = apiBase() + '/trial-page/c?cid=' + encodeURIComponent(state.cid) + '&BID=' + encodeURIComponent(bid) + '&cr=' + cr;
        const res = await fetchWithTimeout(url, { credentials: isPublicBootstrapPage() ? 'include' : (isHeadlessPage() ? 'omit' : 'include') }, 20000);
        const d = await res.json();
        if (d && d.auth_info) {
            const before = authPolicySig();
            state.auth = Object.assign({}, state.auth || {}, d.auth_info);
            if (d.url) state.baseUrl = d.url;
            if (d.cti) state.cti = d.cti;
            if (authPolicySig() !== before) resetAuthBudget();
            return d;
        }
        return d;
    }

    function authLooksFresh() {
        try {
            const p = state.auth && state.auth['Policy'];
            if (!p) return false;
            const json = JSON.parse(atob(p));
            const lt = json && json.Statement && json.Statement[0] && json.Statement[0].Condition &&
                json.Statement[0].Condition.DateLessThan && json.Statement[0].Condition.DateLessThan['AWS:EpochTime'];
            if (!lt) return true;
            return (lt * 1000) > Date.now() + 10000;
        } catch (e) { return true; }
    }

    function configPrio(dir) {
        if (dir.indexOf('normal_default') !== -1) return 0;
        if (dir.indexOf('large_default') !== -1) return 1;
        if (dir.indexOf('x-large_default') !== -1) return 2;
        if (dir.indexOf('small_default') !== -1) return 3;
        return 4;
    }

    function deriveAuthFromResources() {
        try {
            let entries = state.viewerEntries && state.viewerEntries.length
                ? state.viewerEntries.map(name => ({ name }))
                : (performance.getEntriesByType('resource') || []);
            const hosts = ['bw-bv-epubs.bookwalker.jp', 'viewer-epubs-trial.bookwalker.jp', 'viewer-epubs.bookwalker.jp'];
            let best = null;
            let bestConfig = null;
            for (const e of entries) {
                const u = e.name;
                if (!u) continue;
                const hostMatch = hosts.find(h => u.indexOf(h) !== -1);
                if (!hostMatch) continue;
                const qIdx = u.indexOf('?');
                if (qIdx === -1) continue;
                const params = new URLSearchParams(u.slice(qIdx + 1));
                const auth = {};
                for (const k of AUTH_PARAM_KEYS) {
                    const v = params.get(k);
                    if (v !== null && v !== undefined) auth[k] = v;
                }
                if (!auth['Policy'] || !auth['Signature']) continue;
                const path = u.split('?')[0];
                if (state.cid && path.indexOf(state.cid) === -1) continue;
                if (path.indexOf('configuration_pack.json') !== -1) {
                    const dir = path.replace(/configuration_pack\.json$/, '');
                    const prio = configPrio(dir);
                    if (!bestConfig || prio < bestConfig.prio) {
                        bestConfig = { baseUrl: dir, auth, prio };
                    }
                    continue;
                }
                const m = path.match(/^(https?:\/\/[^\/]+\/[^\/]+\/[^\/]+\/.*?)\/item\//);
                if (m) {
                    const dir = m[1] + '/';
                    const fm = path.match(/item\/xhtml\/(p-[^/]+)\.xhtml/);
                    if (fm) {
                        if (!state.fileBases) state.fileBases = {};
                        state.fileBases[fm[1] + '.xhtml'] = dir;
                    }
                    const prio = configPrio(dir);
                    const depth = (dir.match(/\//g) || []).length;
                    if (!best) {
                        best = { baseUrl: dir, auth, prio, depth };
                    } else if (depth > best.depth) {
                        best = { baseUrl: dir, auth, prio, depth };
                    } else if (depth === best.depth && prio < (best.prio === undefined ? 9 : best.prio)) {
                        best = { baseUrl: dir, auth, prio, depth };
                    }
                }
            }
            const chosen = best || bestConfig;
            if (chosen) {
                state.baseUrl = chosen.baseUrl;
                state.auth = chosen.auth;
                return true;
            }
        } catch (e) { console.warn('[bwdd] deriveAuthFromResources:', safeLogText(e && e.message)); }
        return false;
    }

    async function ensureStateFresh() {
        // The CLI intentionally defers the wrappers until the document-start
        // viewer bootstrap has passed. Activate them here, before inspecting
        // resources and issuing explicit auth/manifest refreshes, so later
        // viewer requests are still captured without wrapping bootstrap itself.
        if (shouldDeferNetworkCapture()) {
            try { installNetworkCapture(); } catch (_) {}
        }
        // A BookWalker volume's own store page (/de<uuid>/) has no viewer running
        // and nothing to capture, so a free volume's licence is asked for directly
        // instead (32-headless.js). This is the only route that fills auth before
        // the capture checks below, so they then have nothing to do.
        if (bwHeadlessWanted()) {
            await bwHeadlessOpenFree(bwHeadlessCid());
        }
        snapshotViewerResources();
        const publicBootstrap = (() => {
            try { return !!(window.__BWDD_CLI__ && window.__BWDD_CLI__.publicBootstrap); } catch (e) { return false; }
        })();
        const skipNFBR = (() => {
            try { return isHeadlessPage() && (publicBootstrap || !!(window.__BWDD_CLI__ && window.__BWDD_CLI__.skipNFBR)); } catch (_) { return false; }
        })();
        const found = skipNFBR ? { auth: null, baseUrl: null, config: null, cti: null } : findInNFBR(window);
        if (found.auth && found.baseUrl) {
            if (!state.auth) state.auth = found.auth;
            if (!state.baseUrl) state.baseUrl = found.baseUrl;
            if (found.cti && !state.cti) state.cti = found.cti;
            if (found.config && !state.configBody) state.decodedConfig = found.config;
        }
        if ((!state.auth || !state.baseUrl) && deriveAuthFromResources()) {}
        if (!state.auth || !state.baseUrl) {
            for (let attempt = 0; attempt < (publicBootstrap ? 0 : 8) && (!state.auth || !state.baseUrl); attempt++) {
                await new Promise(r => setTimeout(r, 750));
                const f2 = skipNFBR ? { auth: null, baseUrl: null, config: null, cti: null } : findInNFBR(window);
                if (f2.auth && f2.baseUrl) {
                    state.auth = f2.auth;
                    state.baseUrl = f2.baseUrl;
                    if (f2.cti && !state.cti) state.cti = f2.cti;
                    if (f2.config && !state.decodedConfig) state.decodedConfig = f2.config;
                }
                if ((!state.auth || !state.baseUrl) && deriveAuthFromResources()) {}
            }
        }
        if (!state.auth || !state.baseUrl) {
            let d = null;
            const attemptStatuses = [];
            try {
                if (location.hostname.indexOf('trial') !== -1 || (state.baseUrl && state.baseUrl.indexOf('epubs-trial') !== -1)) {
                    d = await refreshAuthTrial();
                    if (d && d.status != null) attemptStatuses.push(String(d.status));
                }
            } catch (e) {}
            if (!state.auth || !state.baseUrl) {
                // A fresh viewer boot obtains its signed CloudFront policy from
                // /c. Do not send a synthetic bookmark (and advance a public
                // reader's position) before that first native auth exchange.
                // /pb remains the rolling renewal path after capture starts.
                const cFirst = publicBootstrap && (publicBootstrap.route === 'free' || location.hostname.indexOf('trial') === -1);
                if (cFirst) {
                    try { d = await refreshAuthViaC(); } catch (e) { d = null; }
                    if (d && d.status != null) attemptStatuses.push(String(d.status));
                }
                if (!cFirst && (!state.auth || !state.baseUrl)) {
                    try {
                        d = await refreshAuthViaPb();
                        if (d && d.status != null) attemptStatuses.push(String(d.status));
                    } catch (e) {
                        if (e && e.status != null) attemptStatuses.push(String(e.status));
                    }
                }
                // v1.5.1 called /c at most once per sequence, and only after /pb
                // had left us still missing (see the nested guards in its run
                // loop). When cFirst already made that call above, this would be
                // a second identical request; && binds tighter than ||, so the
                // still-missing guard needs its own parentheses to mean that.
                if ((!state.auth || !state.baseUrl) && !cFirst) {
                    try { d = await refreshAuthViaC(); } catch (e) { d = null; }
                    if (d && d.status != null) attemptStatuses.push(String(d.status));
                }
            }
            if (!state.auth || !state.baseUrl) {
                const st = attemptStatuses.find(status => status === '401' || status === '995') ||
                    (d && d.status);
                let hint = 'Failed to capture session auth. Flip one page in the reader and try again.';
                if (st === '503') hint = 'BookWalker returned 503 (session busy/rate-limited). Wait a moment, then try again.';
                else if (st === '401') hint = 'Session cookie expired. Reopen this book from your BookWalker library.';
                else if (st === '995') hint = 'This public sample is not available to an unauthenticated reader.';
                const authError = new Error(hint);
                if (st === '401' || st === '995') authError.code = 'LOGIN_REQUIRED';
                throw authError;
            }
        }
        const bodyDirMatches = !state.configBody || !state.configFromUrl ||
            !state.baseUrl || state.configFromUrl.indexOf(state.baseUrl) === 0;
        if (state.decodedConfig && bodyDirMatches && !state.configBody) {
            try {
                const url = state.baseUrl + 'configuration_pack.json?' + authQuery(state.auth);
                const res = await fetchWithTimeout(url, { credentials: 'omit' }, 60000);
                if (res.ok) { state.configBody = await res.text(); state.configFromUrl = state.baseUrl; }
            } catch (e) { console.warn('[bwdd] Config fetch failed, falling back to memory copy', safeLogText(e && e.message)); }
        } else if (!state.decodedConfig && (!state.configBody || !bodyDirMatches)) {
            const url = state.baseUrl + 'configuration_pack.json?' + authQuery(state.auth);
            const res = await fetchWithTimeout(url, { credentials: 'omit' }, 60000);
            if (!res.ok) throw new Error('Failed to download configuration manifest (HTTP ' + res.status + ')');
            state.configBody = await res.text();
            state.configFromUrl = state.baseUrl;
        }
    }
