    // DMMブックス serves a free/campaign volume at
    //   /product/<series>/<content>/free_streaming/?cid=<opaque>&lin=0
    // and a 試し読み sampler at
    //   /product/<series>/<content>/tachiyomi/?cid=<opaque>&lin=1
    // The viewer asks /viewerapi/auth/ with that opaque cid, gets a CDN base
    // and either CloudFront cookies (free_streaming) or an auth_info query
    // object (tachiyomi), then reads a plain configuration_pack.json and one
    // JPEG per page.
    //
    // The JPEG is a 64×64 tile shuffle, not a finished page: the viewer's
    // `Wu`/`Dl` routines rearrange it in a canvas. The geometry is ported from
    // publus-viewer.js and the page pipeline unscrambles it before the harness
    // ever sees a Blob. There is no cipher and no per-page key; the pattern is
    // derived only from the page's own path.
    const DMM_ORIGIN = 'https://book.dmm.com';
    const DMM_TILE = 64;
    // A page is downloaded whole and only then decoded. Keep the network side
    // sized from the real lane table (the page origin plus every bridge port),
    // while a smaller decode width bounds how many full-page canvases exist at
    // once. A fetch worker that has its bytes waits for a decode slot, so the
    // extra requests are compressed pages, not extra canvases.
    const DMM_MAX_INFLIGHT = 256;
    const DMM_DECODE_CONCURRENCY = 6;
    const DMM_MAX_ATTEMPTS = 4;
    const DMM_FETCH_TIMEOUT_MS = 45000;
    // The panel's background probe is retried a few times: the first attempt can
    // land before the viewer's own auth has set its CloudFront cookies, and
    // latching that one failure left the book card without a page count for the
    // life of the page (the other stores re-attempt their metadata on every
    // panel poll tick).
    const DMM_PROBE_MAX_ATTEMPTS = 4;
    const DMM_PROBE_RETRY_MS = 5000;

    // Sizing is pure so the userscript test can pin it without a browser:
    //   fetchWidth  network requests in flight, one per socket slot
    //   decodeWidth tile unshuffles/canvases in flight
    // An explicit dmmConcurrency is a cap for automation callers; the default
    // follows the transport budget so a bridge's extra ports are not left idle.
    // DMM's CDN is CloudFront over HTTP/2, so the browser's six-connections-per-
    // origin ceiling does not describe this transport: multiplexed streams keep
    // the link busy only if the fan-out is wide enough to cover the round trip.
    // Four streams per budget slot reaches 48 on the no-bridge profile and is
    // still capped by DMM_MAX_INFLIGHT, while a bridge's ports already exceed
    // the cap and stay pinned by it.
    function dmmFanoutPlan(total, requested, budget, inflightCap, decoders) {
        const pages = Math.max(1, Math.floor(Number(total) || 1));
        const cap = Math.max(1, Math.min(DMM_MAX_INFLIGHT,
            Math.floor(Number(inflightCap) || DMM_MAX_INFLIGHT)));
        const sockets = Math.max(1, Math.floor(Number(budget) || 6));
        const wanted = Math.min(cap, Math.max(sockets, sockets * 4));
        const asked = Math.max(0, Math.floor(Number(requested) || 0));
        const fetchWidth = Math.max(1, Math.min(pages, cap, asked > 0 ? asked : wanted));
        const decodeWidth = Math.max(1, Math.min(pages,
            Math.floor(Number(decoders) || DMM_DECODE_CONCURRENCY)));
        return { fetchWidth: fetchWidth, decodeWidth: decodeWidth };
    }

    const dmmState = {
        running: false,
        ready: false,
        // { url, seriesId, contentId, viewer, cid, lin }
        viewer: null,
        seriesId: null,
        contentId: null,
        sample: false,
        rawTitle: '',
        title: '',
        volume: null,
        total: 0,
        resolution: '',
        // The viewer's auth + manifest, cached for the panel preview and reused
        // by a run that starts within a few seconds.
        probe: null,
        probing: false,
        probed: false,
        probeAttempts: 0,
        probeRetryAt: 0,
        error: null,
    };

    function dmmLog() {
        if (!BWDD_DEBUG) return;
        try { console.log.apply(console, ['[bwdd/dmm]'].concat([].slice.call(arguments))); } catch (e) {}
    }

    function dmmOwnsHost() {
        try { return /(^|\.)book\.dmm\.com$/i.test(location.hostname); } catch (e) { return false; }
    }

    function dmmParseViewerUrl(raw) {
        let url;
        try { url = new URL(String(raw || ''), DMM_ORIGIN); } catch (e) { return null; }
        if (!/(^|\.)book\.dmm\.com$/i.test(url.hostname)) return null;
        const m = /^\/product\/(\d+)\/([a-z0-9]+)\/(free_streaming|tachiyomi)\/?$/i.exec(url.pathname);
        if (!m) return null;
        const viewer = m[3].toLowerCase();
        return {
            url: url.toString(),
            seriesId: m[1],
            contentId: m[2],
            viewer: viewer,
            cid: url.searchParams.get('cid') || '',
            lin: url.searchParams.get('lin') || (viewer === 'tachiyomi' ? '1' : '0'),
        };
    }

    function dmmTitleFromDocument() {
        try {
            const og = document.querySelector('meta[property="og:title"]');
            if (og && og.content && og.content.trim()) return og.content.trim();
        } catch (e) {}
        let text = '';
        try { text = document.title || ''; } catch (e) {}
        text = text.replace(/\s*[|｜]\s*DMMブックス.*$/i, '')
            .replace(/\s*[-–—]\s*DMMブックス.*$/i, '')
            .trim();
        return text;
    }

    // The page title is enough for the panel immediately; the page count and
    // resolution need auth + the manifest, so the first refresh starts the probe
    // in the background and lets the panel fill them in when they arrive. A
    // failed probe is retried on a later refresh: the first attempt can land
    // before the viewer has set its CloudFront cookies, and treating that as
    // final left the card without a page count even though the viewer was ready.
    function dmmMaybeProbe() {
        // An in-flight run owns the auth and manifest round trips and publishes
        // its own result on dmmState; a second background probe there would only
        // add load to a CDN that may already be answering 429.
        if (dmmState.running || dmmState.probing || dmmState.probe) return;
        if (dmmState.probeAttempts >= DMM_PROBE_MAX_ATTEMPTS) return;
        if (Date.now() < dmmState.probeRetryAt) return;
        dmmState.probing = true;
        dmmState.probeAttempts++;
        dmmProbe().catch(function (e) {
            dmmState.probeRetryAt = Date.now() + DMM_PROBE_RETRY_MS;
            dmmLog('probe skipped', safeLogText((e && e.message) || e));
        }).finally(function () {
            dmmState.probing = false;
            dmmState.probed = true;
        });
    }

    function dmmRefreshState() {
        const viewer = dmmParseViewerUrl(location.href);
        if (!viewer) {
            dmmState.viewer = null;
            dmmState.ready = false;
            return false;
        }
        const changed = !dmmState.viewer || dmmState.viewer.url !== viewer.url;
        dmmState.viewer = viewer;
        dmmState.seriesId = viewer.seriesId;
        dmmState.contentId = viewer.contentId;
        dmmState.sample = viewer.viewer === 'tachiyomi';
        if (!changed) {
            // The metadata is already read; this tick may still owe the card a
            // probe that failed earlier.
            dmmMaybeProbe();
            return true;
        }
        dmmState.total = 0;
        dmmState.resolution = '';
        dmmState.probe = null;
        dmmState.probed = false;
        dmmState.probeAttempts = 0;
        dmmState.probeRetryAt = 0;
        dmmState.error = null;
        const raw = dmmTitleFromDocument() || ('DMM ' + viewer.contentId);
        // The archive name and the harness title must distinguish a sampler
        // from the full volume of the same content id. The store's own sampler
        // page often says only the volume name, so make it explicit.
        const shown = dmmState.sample && !/試し読み/.test(raw) ? raw + '（試し読み）' : raw;
        dmmState.rawTitle = shown;
        dmmState.title = archiveDefaultName(shown) || cleanTitle(shown) || shown;
        const sv = splitSeriesVolume(dmmState.title);
        dmmState.volume = sv.volNum;
        dmmState.ready = true;
        dmmMaybeProbe();
        return true;
    }

    // Used by the adapter's getBook(): the series/volume split is the same one
    // every other store's panel card uses.
    function dmmBook() {
        if (!dmmState.ready) dmmRefreshState();
        const title = dmmState.title || cleanTitle(dmmState.rawTitle);
        if (!title) return null;
        const sv = splitSeriesVolume(title);
        return {
            rawTitle: dmmState.rawTitle || title,
            title: title,
            series: sv.series,
            volNum: sv.volNum,
        };
    }
