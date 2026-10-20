    //
    // ebjResolvePages also records the session payloads and the open_param
    // arguments in ebjState, because a Web Worker has to install its own copy of
    // the pack (the wasm module is single-shot) and can only do that if it is
    // handed the same payloads this run used.
    const ebjState = {
        // The other stores publish their id as `cid` on the active debug
        // surface; mirror the volume code there too.
        get cid() { return ebjState.code || ''; },
        code: '',
        fileId: '',
        payload: null,
        params: null,       // the open_param arguments those payloads were opened with
        book: null,
        running: false,
    };

    // ebjPage is the page realm when the userscript manager exposes one; every
    // canvas the wasm draws into has to come from there (see 02-realms.js).
    const ebjPage = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

    const EBJ_BASE = 'https://ebookjapan.yahoo.co.jp';
    const EBJ_CDN = 'https://prod-contents-br-page.akamaized.net';
    const EBJ_NAME_CONCURRENCY = 8;
    const EBJ_PARAM_PROBE = { dpr: 2, limit: 10000, size: 10000, flag: 0 };

    // Request headers for the viewer's own API. This came across with the
    // resolve helpers; dropping it with the standalone's GM layer left every
    // resolve throwing a ReferenceError that only ever reached console.warn,
    // so the panel's Save button looked like it did nothing at all.
    const apiHeaders = referer => ({
        'Content-Type': 'application/json',
        Origin: EBJ_BASE,
        Referer: referer || (location.origin + '/'),
        'X-Requested-With': 'FetchAPI',
    });

    function ebjParseTarget(href) {
        const url = String(href || location.href);
        let m;
        if ((m = url.match(/\/viewer\/([^/?#]+)\/([A-Za-z0-9]+)/))) {
            return { type: m[1], code: m[2], referer: `${EBJ_BASE}/viewer/${m[1]}/${m[2]}/` };
        }
        if ((m = url.match(/\/books\/(\d+)\/([A-Za-z0-9]+)/))) {
            return { titleId: m[1], publication: m[2], type: null, code: null, referer: url };
        }
        if ((m = url.match(/\/br_api\/books\/(\d+)\/([A-Za-z0-9]+)/))) {
            return { titleId: m[1], publication: m[2], type: null, code: null, referer: `${EBJ_BASE}/books/${m[1]}/${m[2]}/` };
        }
        throw new Error('open an ebookjapan book or reader page first ' +
            '(a /books/<id>/<code>/ or /viewer/<type>/<code>/ URL)');
    }

    async function ebjResolveCodes(spec) {
        if (spec.type && spec.code) return spec;
        if (!spec.titleId || !spec.publication) return spec;

        const r = await fetch(`${EBJ_BASE}/br_api/books/${spec.titleId}/${spec.publication}?device=pc`,
            { headers: apiHeaders(spec.referer) });
        if (!r.ok) throw new Error(`book detail ${r.status}: ${(await r.text()).slice(0, 160)}`);
        const detail = (await r.json())?.detail;
        if (!detail) throw new Error('book detail response had no `detail` object');
        const isFree = !!(detail.isFree || detail.isTrialReadableWithBrowser);
        const code = detail.code || detail.trial;
        if (!code) throw new Error('could not determine the reading code for this volume');
        return {
            ...spec,
            type: isFree ? 'free' : 'purchased',
            code,
            trialCode: detail.trial || null,
            title: detail.title || detail.itemName || null,
            allowPurchasedFallback: true,
        };
    }

    // The boot poll and the run can both ask for the same volume while the first
    // resolve is still in flight: it makes three network calls and instantiates
    // the wasm module, so it reliably outlives the timers that trigger it.
    // Without a shared promise each caller opens its own open_book session and
    // builds a second module to race over the same ebjState.
    let ebjResolveInflight = null;

    async function ebjResolvePages(target, opts) {
        const key = String(target || location.href);
        if (ebjResolveInflight && ebjResolveInflight.key === key) return ebjResolveInflight.promise;
        const promise = ebjResolvePagesOnce(target, opts);
        ebjResolveInflight = { key, promise };
        try { return await promise; }
        finally { if (ebjResolveInflight && ebjResolveInflight.promise === promise) ebjResolveInflight = null; }
    }

    async function ebjResolvePagesOnce(target, { onStatus } = {}) {
        const say = m => { if (onStatus) onStatus(m); };
        const spec = await ebjResolveCodes(ebjParseTarget(target));
        say(`code ${spec.code} (${spec.type})`);

        const openBook = (type, code) => fetch(`${EBJ_BASE}/br_api/open_book`, {
            method: 'POST',
            headers: apiHeaders(spec.referer),
            body: JSON.stringify({ type, code, light: false }),
        });

        let obRes = await openBook(spec.type, spec.code);
        if (!obRes.ok && spec.type === 'free' && spec.allowPurchasedFallback) {
            ebjLog('resolve', 'open_book(free) refused, retrying as purchased');
            const altCode = (spec.trialCode && spec.trialCode !== spec.code) ? spec.trialCode : spec.code;
            const alt = await openBook('purchased', altCode);
            if (alt.ok) { obRes = alt; spec.type = 'purchased'; spec.code = altCode; }
        }
        if (!obRes.ok) {
            const body = (await obRes.text()).slice(0, 200);
            if (spec.type === 'purchased') {
                throw new Error(`Could not open this volume (${obRes.status}).\n` +
                    `It is not a free or sample volume, so the API needs your logged-in ebookjapan session.\n` +
                    `Make sure you are signed in and have opened this book in the reader once.\n${body}`);
            }
            throw new Error(`open_book ${obRes.status}: ${body}`);
        }
        const open = await obRes.json();
        if (!open || !open.session_id) throw new Error('open_book returned no session_id');

        const drmRes = await fetch(`${EBJ_BASE}/br_api/get_drm?session_id=${encodeURIComponent(open.session_id)}`,
            { headers: apiHeaders(spec.referer) });
        if (!drmRes.ok) throw new Error(`get_drm ${drmRes.status}: ${(await drmRes.text()).slice(0, 200)}`);
        const drm = await drmRes.json();
        if (!drm || !drm.file_id) throw new Error('get_drm returned no file_id');

        say('decrypting configuration pack');
        const glue = await ebjLoadGlue();
        await glue.decrypt_session(open.session_id, drm.code, open.payload, drm.payload);
        // Keep what it takes to install the pack again. The decrypted pack lives
        // in the wasm module's own memory, and shuffle() traps with a bare
        // "unreachable" when it is not there — a panic that names no cause and
        // stops every page at once.
        ebjAutographImg = null;
        ebjState.payload = { sessionId: open.session_id, code: drm.code, fileId: drm.file_id,
                         openPayload: open.payload, drmPayload: drm.payload };

        // Ask for the biggest box the book has, then scale to what comes back:
        // open_param normalises to fit `limit`/`size`, so a probe with a huge
        // limit reports the intrinsic size, and a second call at that size ends
        // up as close to 1:1 as the manifest allows.
        const probe = await glue.open_param(EBJ_PARAM_PROBE);
        const probePages = (probe && probe.pages) || [];
        if (!probePages.length) throw new Error('the page manifest came back empty');

        let maxW = 0, maxH = 0;
        for (const p of probePages) {
            if (Number(p.width) > maxW) maxW = Number(p.width);
            if (Number(p.height) > maxH) maxH = Number(p.height);
        }
        let manifest = probe;
        if (maxW > 0 && maxH > 0 &&
            (maxW !== EBJ_PARAM_PROBE.size || maxH !== EBJ_PARAM_PROBE.limit)) {
            const params = { dpr: 2, limit: maxH, size: maxW, flag: 0 };
            manifest = await glue.open_param(params);
            ebjState.params = params;
        }
        const pages = (manifest && manifest.pages) || [];

        say(`resolving ${pages.length} page names`);
        const names = new Array(pages.length);
        for (let i = 0; i < pages.length; i += EBJ_NAME_CONCURRENCY) {
            const slice = pages.slice(i, i + EBJ_NAME_CONCURRENCY);
            await Promise.all(slice.map(async (_, k) => {
                const n = i + k;
                try { names[n] = await glue.get_page_name(drm.file_id, n); }
                catch (e) { names[n] = null; }
            }));
        }

        // Canvas the whole book is composed into: big enough for its largest
        // page. shuffle() places every tile at a destination offset derived from
        // the intrinsic geometry, so one canvas size serves every page and the
        // smaller pages simply carry transparent padding past their own box.
        let canvasW = 0, canvasH = 0;
        for (const p of pages) {
            if (Number(p.width) > canvasW) canvasW = Number(p.width);
            if (Number(p.height) > canvasH) canvasH = Number(p.height);
        }

        const rows = pages.map((p, n) => {
            const name = names[n];
            return {
                page: n,
                name,
                view: p.view ?? null,
                width: p.width ?? null,
                height: p.height ?? null,
                position: p.position ?? null,
                width: Number(p.width) || 0,
                height: Number(p.height) || 0,
                jumps: (p.jumps || []).length,
                url: name ? `${EBJ_CDN}/pages/${String(name).replace(/\.jpe?g$/i, '.webp')}` : null,
            };
        });

        return {
            source: target,
            publication: drm.publication,
            autograph: autographSpec(drm),
            fileId: drm.file_id,
            path: drm.path,
            code: drm.code,
            name: drm.name || drm.title || spec.title || null,
            title: drm.title || null,
            formatId: Number(drm.format_id),
            direction: manifest && manifest.direction != null ? manifest.direction : null,
            version: manifest ? manifest.version : null,
            imageTypes: manifest ? manifest.image_types : null,
            chapters: (manifest && manifest.chapters) || [],
            totalPages: pages.length,
            canvas: { width: canvasW, height: canvasH },
            pages: rows,
        };
    }

    // A breadcrumb the instant this script is evaluated, before any adapter
    // logic. If the attribute below never appears, Tampermonkey did not run the
    // script at all (wrong URL, stale install, script disabled) — which looks
    // exactly like a crash from the panel, and is the first thing to rule out.
    try {
        document.documentElement.setAttribute('data-bwdd-ebookjapan', 'evaluated');
        console.log('[ebookjapan] evaluated on ' + location.href);
    } catch (e) {}

    function ebjIsViewerPage(href) {
        try {
            return /(^|\.)ebookjapan\.yahoo\.co\.jp$/i.test(new URL(href, location.href).hostname);
        } catch (e) {
            return /ebookjapan\.yahoo\.co\.jp/.test(String(href));
        }
    }
