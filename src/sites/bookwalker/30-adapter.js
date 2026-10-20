    // BookWalker is the original site, so its pipeline is unchanged; only its
    // identity and metadata answers are exposed here.
    function bwOwnsHost() {
        try { return /(^|\.)bookwalker\.jp$/i.test(location.hostname); } catch (e) { return false; }
    }
    registerSite({
        id: 'bookwalker',
        label: 'BookWalker',
        panelTitle: 'BookWalker Native Downloader',
        ownsHost() {
            return bwOwnsHost();
        },
        matches() {
            // The four readers only. The shop host is a storefront: series,
            // search and /de<uuid> product pages have no viewer and no page list,
            // so nothing may paint a panel there.
            try {
                return bwOwnsHost() && /^viewer(-trial|-ptrial|-subscription)?\.bookwalker\.jp$/i.test(location.hostname);
            } catch (e) { return false; }
        },
        headlessMatches() {
            // A headless CLI injects this script itself on a /de<uuid> product
            // page to run the viewer-free licence exchange. The header does not
            // match that page, so this claim is only reachable through such an
            // explicit inject, never through an ordinary page load.
            return bwOwnsHost();
        },
        install() {
            // A headless CLI run may deliberately defer the capture and call
            // activateCapture() itself once the page is where it wants it.
            if (!shouldDeferNetworkCapture()) installNetworkCapture();
        },
        getBook() {
            const rawTitle = state.cti || document.title || '';
            const title = cleanTitle(rawTitle) || state.cid || '';
            const sv = splitSeriesVolume(state.cti || title);
            return { rawTitle, title, series: sv.series, volNum: sv.volNum };
        },
        getPreview() { return buildBookPreview(); },
        getCid() { return state.cid || ''; },
        archiveDefault(rawTitle) { return archiveDefaultName(rawTitle) || fsSafePath(state.cid || ''); },
        run(ui, mode, options) { return run(ui, mode, options); },
        state: state,
        // Console surface for this store only; the entry point merges whatever
        // the active adapter puts here into window.__bwdd.
        debug: {
            decodeConfig, pageSeedsNo, A9p, b8gNo, state, buildWorkerSource,
            fetchAndDescramble, cdnFetch, cdnFetchWithFallback,
            // The viewer-free licence (32-headless.js): the loader nonce reader
            // and the exchange itself, so a test can drive them without a viewer.
            bwHeadlessCrFromLoader, bwHeadlessCr, bwHeadlessOpenFree, bwHeadlessWanted,
        },
    });
