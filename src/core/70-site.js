    // A site adapter supplies only the four things that genuinely differ between
    // the stores: detection (which store is this page?), metadata (title,
    // series/volume, page count, archive name), page enumeration (what to fetch,
    // in reading order), and fetch + descramble (one page → finished image Blob).
    // Everything else - panel, controls, bars, Mokuro conversation, stat cards,
    // ZIP naming/assembly, page cache, headless automation - lives in core and is
    // shared verbatim, which is what keeps the paths from drifting apart.
    //
    // Contract:
    //   id, label, panelTitle      identity shown in the panel
    //   ownsHost()                 does this store own this host? (storefront guard)
    //   matches()                  true only on this store's reader page
    //   headlessMatches()          optional: whole-host claim for an explicit headless inject
    //   install()                  page hooks; called once, at load
    //   refresh()                  optional: top up metadata before it is read
    //   getBook()                  { rawTitle, title, series, volNum } or null
    //   getPreview()               { title, pages, resolution, type } or null
    //   getCid()                   stable id, used for the page cache
    //   run(ui, mode, options)     the download pipeline for this store
    const SITE_REGISTRY = [];
    let ACTIVE_SITE = null;

    function registerSite(adapter) {
        if (adapter && adapter.id) SITE_REGISTRY.push(adapter);
        return adapter;
    }

    // A storefront page is a page on a store's own host that its adapter
    // refused: a series, title, product or search page. Those pages lead up to a
    // reader and carry none of the data a run needs, so no adapter may claim
    // them, not even another store's.
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
        // A headless caller injects this script itself, deliberately, and its
        // entry point is sometimes a store page rather than a reader: the
        // viewer-free licence exchange for a BookWalker free volume starts on a
        // /de<uuid>/ product page, and ebookjapan detail URLs resolve through
        // br_api. Only those adapters name such a whole-host claim, and only a
        // headless page can reach this branch; the metadata does not match those
        // URLs, so a normal page load never gets here.
        if (isHeadlessPage()) {
            for (const adapter of SITE_REGISTRY) {
                let owned = false;
                try { owned = typeof adapter.headlessMatches === 'function' && !!adapter.headlessMatches(); } catch (e) { owned = false; }
                if (owned) return adapter;
            }
        }
        // A storefront page on a store's own host: its adapter refused it and no
        // other store may take it. No adapter means no panel, no network capture
        // and no bridge probe, which is the point: before the reader there is
        // nothing to download.
        if (storeOwnsHost()) return null;
        // A host no store owns at all is a bare injected copy (devtools, a
        // browser test, a CLI). BookWalker stays the default there, as it always
        // was for this script.
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
        // A headless/CLI page gets no panel, no bridge-health tick and no stats
        // loop: the caller owns all of that.
        if (isHeadlessPage()) return null;
        // A produced document (about:blank, blob:, data:) is never a store page.
        // A userscript manager does not inject into one, and a browser test that
        // injects everywhere must not mount a panel there either.
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
                    // A rejected run must land on the panel, not only in the
                    // console, or the bars sit at 0/0 and the click looks like it did
                    // nothing. Un-hide the details box too.
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
            // The viewer fills its metadata in asynchronously, so poll briefly
            // rather than reading the title once and settling for document.title.
            for (let i = 0; i < 40; i++) {
                await new Promise(r => setTimeout(r, 500));
                // Let the adapter top up its own metadata first: CMOA's viewer
                // fills its page list in after the document is ready, so the
                // answers below are only as good as the last refresh.
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
                // Which other shops carry it, linked to their store pages. This
                // re-runs when the title or volume changes rather than latching on the
                // first pass: the viewer publishes metadata asynchronously, and a
                // lookup fired against a placeholder title comes back "not found" at
                // every shop. typeof, not try/catch: the availability module is in the
                // combined build only, so the identifier may not exist at all.
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
