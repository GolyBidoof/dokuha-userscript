    // A volume's own store page (/de<uuid>/) downloads without a viewer, so
    // there is nothing to capture. A free volume does not need one: the store
    // hands a licence to an anonymous reader that repeats the viewer's own
    // opening exchange, because the exchange is plain HTTP. Three calls, all on
    // the reader host, all in one session:
    //
    //   GET viewer.bookwalker.jp/browserWebApi/03/view?cid=<cid>
    //        -> 302 + Set-Cookie: SESSION (the session the licence is bound to)
    //   GET viewer.bookwalker.jp/browserWebApi/03/getLoader      defines c9P()
    //   GET viewer.bookwalker.jp/browserWebApi/c?cid=&BID=&cr=<c9P()>
    //        -> { status:"200", url, cti, auth_info:{ hti,cfg,bid,uuid,pfCd,
    //                                                  Policy,Signature,Key-Pair-Id } }
    //
    // `cr` is not a random nonce and is not derived from the cid or the clock:
    // the loader's c9P() is pure arithmetic over embedded constants, and it is
    // bound to the session that fetched it. The live store answers status 503 to
    // a minted cr (and to a cr from another session's loader) and status 401 to
    // a licence request with no session cookie, while the same chain as the
    // reader walks it answers 200 with a full auth_info. Both were measured
    // against the live store, which is why the value is read out of the loader
    // and the chain is retried once, without its cached value, when refused.
    //
    // The reader host is a different origin from the shop and sends no CORS
    // header, so none of the three replies can be read by a page fetch; they go
    // through GM_xhr (see bwHeadlessGet).
    const BW_HEADLESS_API = 'https://viewer.bookwalker.jp';
    const BW_HEADLESS_LOADER = '/browserWebApi/03/getLoader';
    const BW_HEADLESS_CR_KEY = 'bwdd.bw.headless.cr';

    // A BookWalker volume's product id, read out of a /de<uuid>/ store URL.
    const BW_PRODUCT_PATH = /^\/de([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
    function bwProductId(where) {
        try {
            const path = where ? new URL(where, location.href).pathname : location.pathname;
            const m = BW_PRODUCT_PATH.exec(path);
            return m ? m[1] : null;
        } catch (e) { return null; }
    }

    // The volume this frame is for. A /de<uuid>/ store page names it in its own
    function bwHeadlessCid() {
        return bwProductId(location.href) || '';
    }

    // This route belongs to a BookWalker volume store page, where no viewer ever
    // loads. A page the user is reading in the viewer has its own session and
    // must keep using it, so a captured auth always wins; a series or search page
    // names no single volume.
    function bwHeadlessWanted() {
        try {
            if (state.auth && state.baseUrl) return false;
            return !!bwProductId(location.href);
        } catch (e) { return false; }
    }

    // Read c9P() out of the loader. Only its arithmetic is ever evaluated, and
    // only after that arithmetic has been checked character by character to hold
    // nothing but numbers, operators and a whitelist of Math functions - so a
    // loader that grew a fetch() or a property walk is refused, not run.
    const BW_HEADLESS_ARITH = /^(?:[0-9.eE+\-*/(),\s]|Math\.(?:asin|acos|atan2?|sin|cos|tan|sqrt|cbrt|pow|abs|round|floor|ceil|trunc|sign|exp|log|log2|log10|hypot|min|max|fround|sinh|cosh|tanh))*$/;

    function bwHeadlessCrFromLoader(text) {
        const src = String(text || '');
        const m = /(?:^|[^A-Za-z0-9_$.])c9P\s*=\s*function\s*\(\s*\)\s*\{/.exec(src);
        if (!m) return '';
        // The body is a short function, but the bundle continues after it: walk
        // its braces, skipping string literals, to find its own closing one.
        const open = src.indexOf('{', m.index);
        if (open < 0) return '';
        let depth = 0;
        let quote = '';
        let end = -1;
        for (let i = open; i < src.length; i++) {
            const ch = src[i];
            if (quote) {
                if (ch === '\\') { i++; continue; }
                if (ch === quote) quote = '';
                continue;
            }
            if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (!depth) { end = i; break; } }
        }
        if (end < 0) return '';
        const body = src.slice(open + 1, end);
        // c9P() is `let r = <arithmetic>; let s = ''+r.toFixed(n); return
        // s.substring(s.indexOf('.')+1, s.length-1)+'<suffix>';`. Each part is
        // read on its own, and only the first one is evaluated.
        const exprM = /(?:let|var|const)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*([^;]+);/.exec(body);
        if (!exprM) return '';
        const expr = exprM[1].trim();
        if (!BW_HEADLESS_ARITH.test(expr)) return '';
        const precisionM = /toFixed\(\s*(\d{1,2})\s*\)/.exec(body);
        const suffixM = /["']([0-9]{1,12})["']\s*;?\s*\}?\s*$/.exec(body.trim());
        if (!precisionM || !suffixM) return '';
        let r = NaN;
        try {
            // eslint-disable-next-line no-new-func
            r = Number(new Function('return (' + expr + ');')());
        } catch (e) { return ''; }
        if (!isFinite(r)) return '';
        const s = '' + r.toFixed(parseInt(precisionM[1], 10));
        const dot = s.indexOf('.');
        if (dot < 0) return '';
        const cr = s.substring(dot + 1, s.length - 1) + suffixM[1];
        return /^[0-9]{6,32}$/.test(cr) ? cr : '';
    }

    async function bwHeadlessCr() {
        // The value is a property of the loader build, not of the volume: one
        // read serves every volume until the tab is closed.
        let cached = '';
        try { cached = sessionStorage.getItem(BW_HEADLESS_CR_KEY) || ''; } catch (e) { cached = ''; }
        if (/^[0-9]{6,32}$/.test(cached)) return cached;
        const res = await bwHeadlessGet(BW_HEADLESS_API + BW_HEADLESS_LOADER);
        if (!res || res.status !== 200 || !res.text) {
            throw new Error('BookWalker licence bootstrap failed: the reader loader answered HTTP ' +
                ((res && res.status) || '?') + '.');
        }
        const cr = bwHeadlessCrFromLoader(res.text);
        if (!cr) throw new Error('BookWalker licence bootstrap failed: the reader loader did not expose its licence nonce.');
        try { sessionStorage.setItem(BW_HEADLESS_CR_KEY, cr); } catch (e) {}
        return cr;
    }

    // The reader host is a different origin from the shop and answers without any
    // CORS header, so a page fetch cannot read its replies: these go through
    // GM_xhr, which is also what every CDN page byte already goes through.
    //
    // The licence is bound to the session `/view` creates, and a `cr` is bound to
    // the session whose loader produced it, so the cookie has to survive between
    // the three calls. A manager that keeps a cookie jar does that by itself, but
    // that is the one part of this chain a page cannot observe, so the cookie is
    // also read out of the reply headers and sent back explicitly: the handshake
    // then works whether or not the manager's jar carries it.
    let bwHeadlessCookies = '';

    function bwHeadlessHeaderValue(headers, name) {
        const text = String(headers || '');
        const re = new RegExp('^' + name + ':\\s*(.*)$', 'gim');
        const m = re.exec(text);
        return m ? m[1].trim() : '';
    }

    // `set-cookie` may appear once per line, and GM_xhr hands the headers over as
    // one text blob; keep only what the reader host may need back.
    function bwHeadlessAbsorbCookies(headers) {
        const text = String(headers || '');
        const found = [];
        const re = /^set-cookie:\s*([^=\s;]+)=([^;\s]*)/gim;
        let m;
        while ((m = re.exec(text))) found.push(m[1] + '=' + m[2]);
        if (!found.length) return;
        const jar = new Map();
        for (const pair of (bwHeadlessCookies ? bwHeadlessCookies.split('; ') : [])) {
            const eq = pair.indexOf('=');
            if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
        }
        for (const pair of found) {
            const eq = pair.indexOf('=');
            if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
        }
        bwHeadlessCookies = Array.from(jar, ([k, v]) => k + '=' + v).join('; ');
    }

    function bwHeadlessRequest(url) {
        const headers = { Accept: '*/*' };
        if (bwHeadlessCookies) headers.Cookie = bwHeadlessCookies;
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET', url: url, headers: headers, timeout: 20000,
                    onload: r => {
                        bwHeadlessAbsorbCookies(r && r.responseHeaders);
                        resolve({ status: r && r.status, text: (r && r.responseText) || '' });
                    },
                    onerror: e => reject(new Error('GM_xhr: ' + ((e && e.error) || 'request failed'))),
                    ontimeout: () => reject(new Error('GM_xhr: Timeout')),
                });
            });
        }
        return fetchWithTimeout(url, { credentials: 'include', headers: headers }, 20000)
            .then(async r => {
                try { bwHeadlessAbsorbCookies(Array.from(r.headers || []).map(p => 'set-cookie: ' + p[1]).join('\n')); } catch (e) {}
                return { status: r.status, text: await r.text() };
            });
    }

    function bwHeadlessGet(url) {
        return bwHeadlessRequest(url);
    }

    // The licence is bound to the session the reader creates on its own first
    // hop, and a `cr` is bound to the session that fetched its loader: the
    // identical /c call with no session cookie is answered 401, and one with a
    // cr from a different session's loader is answered 503 (both verified
    // against the live store). So the chain is walked in one session, in order,
    // and only viewer.bookwalker.jp is involved - the product page, the
    // `?sample=2` hop and a Referer are all optional.
    const BW_HEADLESS_VIEW = '/browserWebApi/03/view?cid=';

    async function bwHeadlessOpenFree(cid) {
        state.cid = cid;
        // On a store page location.origin is the shop, and the licence lives on
        // the reader host; apiBase() would otherwise point the call at the shop.
        state.apiBase = BW_HEADLESS_API;
        let last = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            // A stale cr is the likeliest reason a licence is refused: drop it and
            // walk the whole chain again, session and all.
            if (attempt) {
                try { sessionStorage.removeItem(BW_HEADLESS_CR_KEY); } catch (e) {}
                bwHeadlessCookies = '';
            }
            try {
                await bwHeadlessGet(BW_HEADLESS_API + BW_HEADLESS_VIEW + encodeURIComponent(cid));
                const cr = await bwHeadlessCr();
                const url = BW_HEADLESS_API + '/browserWebApi/c?cid=' + encodeURIComponent(cid) +
                    '&BID=' + encodeURIComponent(getBID()) + '&cr=' + encodeURIComponent(cr);
                const res = await bwHeadlessGet(url);
                let d = null;
                try { d = res && res.text ? JSON.parse(res.text) : null; } catch (e) { d = null; }
                if (d && d.auth_info && d.url) {
                    state.auth = d.auth_info;
                    state.baseUrl = d.url;
                    if (d.cti) state.cti = d.cti;
                    return d;
                }
                last = d && d.status != null ? String(d.status) : ('HTTP ' + ((res && res.status) || '?'));
                // Only the two "the session/cr is wrong" answers are worth a
                // second walk; anything else is the store's verdict on the volume.
                if (last !== '503' && last !== '401' && last !== '403') break;
            } catch (e) {
                last = (e && e.message) || 'request failed';
                if (attempt || !/HTTP 5|Failed|fetch|Timeout/i.test(String(last))) break;
            }
        }
        const st = String(last || '?');
        let why = '';
        if (st === '401') why = ' This volume needs a signed-in session; open it once in the reader, then try the download again.';
        else if (st === '995') why = ' The store did not offer this volume to an anonymous reader.';
        else if (st === '503') why = ' The reader refused the licence nonce; if this repeats, open the volume in the reader once.';
        const err = new Error('BookWalker refused the licence for ' + cid + ' (status ' + st + ').' + why);
        if (st === '401' || st === '995') err.code = 'LOGIN_REQUIRED';
        throw err;
    }
