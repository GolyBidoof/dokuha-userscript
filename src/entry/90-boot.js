    // One entry point for every store. The adapter is chosen from the URL: a
    // reader page selects its store's adapter, and a storefront page selects
    // none. When an adapter owns the page it gets the chance to install its
    // hooks and the shared panel is brought up against it. A host no store owns
    // still gets the BookWalker adapter, which is what a bare injected copy
    // (tests, devtools, a CLI) expects.
    const BWDD_SITE = detectSite();
    ACTIVE_SITE = BWDD_SITE;
    if (BWDD_SITE) {
        if (typeof BWDD_SITE.install === 'function') {
            try { BWDD_SITE.install(); } catch (e) {}
        }

        // Install the page API before DOMContentLoaded so a CLI can call start()
        // as soon as the userscript has been injected.
        installHeadlessAutomation();

        // Ask for the bridge's ports as soon as the page is up rather than when a run
        // starts. /health is a real round trip - ~0.7s server-side on the machine this
        // was measured on, more once GM has carried it - and doing it inside a run put
        // that latency in front of the first page. Done here, a run almost always
        // finds the port list already in hand and does not wait at all. Refreshed on a
        // background-friendly interval so a bridge started after the page is still
        // picked up.
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

    // A storefront page has no adapter, so there is no store to expose and
    // nothing else runs: no capture, no panel, no bridge probe, no debug surface.
    if (BWDD_SITE && BWDD_DEBUG && !isHeadlessPage()) {
        try {
            const dbg = {
                cleanTitle, splitSeriesVolume, fsSafePath, zipBaseName, crc32Bytes, buildStoreZip,
                get imageCodec() { return IMAGE_CODEC; }, resolveImageCodec,
                // transport lanes: exposed for the lane/burst test harness
                allLanes, fetchSocketBudget, rawSocketBudget, laneStats, laneSummary, recordLane, dedupeInflight,
                addProxyPorts, clearProxySource,
                CHROMIUM_SOCKETS_PER_PROCESS, CONTROL_PLANE_SOCKET_RESERVE, MAX_DATA_PLANE_SOCKETS,
                probeFetchProxy, probeDotLane, probeEdgeMirror, discoverProxyPorts,
                setProxyUpstreams, proxyCanServe,
                dottedUrl, edgeUrlFor, proxyPorts, laneFetch, capabilitySummary, workerPoolSize, workerBatchSize, makePool,
                proxyLaneFetch, proxyLaneAvailable,
                canSpawnBlobWorker, clearPageCache,
                // hidden-tab scheduling: exposed for tests/test_ticker.js
                setBackgroundInterval, clearBackgroundInterval, backgroundDelay, yieldToTasks,
                // bridge client: exposed for tests/test_mokuro_client.js, which
                // drives it against a stand-in bridge to pin the wire protocol
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
            // Whatever the active store wants on the console, so this file never
            // names one of them.
            Object.assign(dbg, (BWDD_SITE && BWDD_SITE.debug) || {});
            debugRealm().__bwdd = dbg;
        } catch (e) {}
        try {
            debugRealm().__bwddUI = Object.assign(debugRealm().__bwddUI || {},
                { renderStatsCards, renderBookCard, renderNativelyCard, renderMangaKotobaCard, setBar, showBars });
        } catch (e) {}
        // The active adapter, for the site-adapter tests.
        try { debugRealm().__bwddSite = BWDD_SITE; } catch (e) {}
        for (const k in ((BWDD_SITE && BWDD_SITE.debugGlobals) || {})) {
            try { debugRealm()[k] = BWDD_SITE.debugGlobals[k]; } catch (e) {}
            // Still publish on the sandbox window, so a caller inside the sandbox
            // sees the same object rather than a shadow of it.
            try { window[k] = debugRealm()[k]; } catch (e) {}
        }
    }
