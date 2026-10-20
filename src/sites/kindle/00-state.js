    // The Kindle web manga reader (read.amazon.co.jp/manga/<ASIN>) is a
    // fixed-layout viewer that publishes everything the adapter needs inside
    // the page itself, in a <script type="application/json" id="bookInfo">
    // element:
    //
    //   asin              the volume id, and the page-cache key
    //   title             "… 1巻 (デジタル版サンプルコミックス)"
    //   seriesAsin        series identity for the cross-store availability check
    //   contentGuid       the content *revision* the render service must be asked
    //                     for; a mismatch is a 404, not a fallback
    //   karamelToken      { token, expiresAt } — the render bearer token, and the
    //                     material the page cipher key is cut from
    //   cdnPrefetchInfo   a JSON *string*: the first pages' already-signed CDN
    //                     descriptors, fetched by the viewer before it ever
    //                     calls the render service
    //
    // Because the state is markup rather than an API response there is nothing
    // to passively capture here — unlike BookWalker's signed XHRs or CMOA's
    // viewer globals — so install() only leaves a breadcrumb. The one thing the
    // page does not carry is the page list; that costs a single cheap
    // /renderer/render call, made lazily by 03-run.js.
    //
    // Three scales meet in this store and confusing them is the easiest way to
    // build a downloader that silently stops halfway:
    //
    //   sectionId        one per *view* (a view is 1 or 2 source pages, 2-up in
    //                    landscape); offset from zero, and only meaningful as an
    //                    ordering key — never as a page number
    //   pageIndex        *window-relative*, so it cycles 0,1 inside every bundle
    //   startPositionId  a position cursor: advances ~3.5 per source page
    //   location map     locations.length - 1 = the number of *source page
    //                    images*, which is what this downloader archives
    const KINDLE_READER_HOST_RE = /^read\.amazon\./i;
    const KINDLE_MANGA_PATH_RE = /\/manga\//i;

    const kindleState = {
        asin: '',
        revision: '',
        title: '',
        seriesAsin: '',
        token: '',
        expiresAt: 0,
        bookAccessMethod: '',
        bookContentType: '',
        isSample: false,
        isFreeTrial: false,
        isVerticalScroll: false,
        expectedPages: 0,       // location_map.locations.length - 1 (source images)
        lastPositionId: 0,      // the reader's own "this is the last page" bound
        progression: 'rtl',
        author: '',
        imageResolution: null,
        // The walk. pages is keyed by sectionId so a re-walk cannot duplicate;
        // resources is keyed by the manifest's own "resource/rsrc…" path.
        pages: new Map(),
        resources: new Map(),
        toc: [],
        nextSkip: 0,
        walkDone: false,
        // The window size to ask for next. The viewer only ever asks for 2, and
        // the service answers a window it dislikes with 400 rather than clamping
        // it, so this is learned: it starts optimistic, drops on a refusal, and
        // drops again when a window comes back shorter than it was asked for.
        // 0 means "not decided yet".
        windowBatch: 0,
        // The start-of-book anchor sent as startingPosition, and whether to send
        // it at all. 'explicit' sends startPosition; 'default' omits the
        // parameter after a window came back empty, which is how the service
        // reports an anchor it cannot place. See kindleRenderUrl.
        startPosition: 1,
        startMode: 'explicit',
        // The render endpoint's contentType, and therefore half of what the
        // rendering token is minted against: the reader bundle computes it as
        // `isSample ? "Sample" : "FullBook"` (getKaramelContentType maps EBSP ->
        // Sample, EBOK -> FullBook). Sending the wrong one earns
        // 400 {"message":"Rendering token is not matching the request."} and
        // nothing else works, so it is derived from the page and corrected by a
        // retry if the page did not say.
        contentType: 'FullBook',
        contentTypeFixed: false,
        throttleUntil: 0,
        throttleStrikes: 0,
        // Probe = one render call made at page load so the panel can show the
        // page count before the user clicks anything. Non-blocking by design:
        // the boot poll calls refresh() 40 times and must not wait on network.
        probe: { status: 'idle', error: null },
        running: false,
    };
    // The boot poll and a run can both ask for the probe at the same moment.
    // Without a shared promise each caller opens its own session and they race
    // over the same state object, which is what broke ebookjapan first.
    let kindleProbeInflight = null;

    function kindleLog() {
        if (!BWDD_DEBUG) return;
        try { console.log.apply(console, ['[bwdd/kindle]'].concat([].slice.call(arguments))); } catch (e) {}
    }

    // A breadcrumb the instant this script is evaluated, before any adapter
    // logic. If the attribute below never appears, Tampermonkey did not run the
    // script at all (wrong URL, stale install, script disabled) — which looks
    // exactly like a crash from the panel, and is the first thing to rule out.
    try {
        document.documentElement.setAttribute('data-bwdd-kindle', 'evaluated');
        console.log('[kindle] evaluated on ' + location.href);
    } catch (e) {}

    function kindleIsMangaPage(href) {
        try {
            const u = new URL(href || location.href, location.href);
            return KINDLE_READER_HOST_RE.test(u.hostname) && KINDLE_MANGA_PATH_RE.test(u.pathname);
        } catch (e) {
            return KINDLE_READER_HOST_RE.test(String(href)) && KINDLE_MANGA_PATH_RE.test(String(href));
        }
    }

    // The ASIN is the only stable identity here, so it doubles as the page-cache
    // key and the fallback archive name.
    function kindleAsinFromUrl(href) {
        const m = String(href || location.href).match(/\/manga\/([A-Z0-9]{10})(?:[/?#]|$)/i);
        return m ? m[1].toUpperCase() : '';
    }

    function kindleReadBookInfo() {
        let el = null;
        try { el = document.getElementById('bookInfo'); } catch (e) { el = null; }
        if (!el) return null;
        const text = String(el.textContent || el.value || '');
        if (!text.trim()) return null;
        try { return JSON.parse(text); } catch (e) { return null; }
    }

    // Parse-only: no network, so the panel's 500 ms poll can call this safely.
    // Returns true when the identity actually changed, which is what the run
    // uses to decide whether a cached probe still belongs to this volume.
    function kindleApplyBookInfo() {
        const info = kindleReadBookInfo();
        if (!info) return false;
        const asin = String(info.asin || '') || kindleAsinFromUrl(location.href);
        const revision = String(info.contentGuid || '');
        const changed = asin !== kindleState.asin || revision !== kindleState.revision;

        kindleState.asin = asin;
        kindleState.revision = revision;
        kindleState.title = String(info.title || '');
        kindleState.seriesAsin = String(info.seriesAsin || '');
        kindleState.bookAccessMethod = String(info.bookAccessMethod || '');
        kindleState.bookContentType = String(info.bookContentType || '');
        kindleState.isSample = info.isSample === true;
        // bookAccessMethod is the same fact spelled differently ("SAMPLE"), and
        // is worth consulting because a missing isSample would otherwise silently
        // select FullBook and earn a token mismatch on every sample volume.
        if (!kindleState.contentTypeFixed) {
            kindleState.contentType = (kindleState.isSample ||
                /^SAMPLE$/i.test(kindleState.bookAccessMethod)) ? 'Sample' : 'FullBook';
        }
        kindleState.isVerticalScroll = info.isVerticalScroll === true;
        kindleState.isFreeTrial = /LIMITED_TIME_FREE|FREE_TRIAL/i.test(kindleState.bookAccessMethod);
        const tok = info.karamelToken;
        if (tok && typeof tok === 'object') {
            kindleState.token = String(tok.token || '');
            kindleState.expiresAt = Number(tok.expiresAt) || 0;
        }
        // The page ships already-signed descriptors for its first pages, on the
        // *plain* distribution host with isEncrypted false — the route the viewer
        // itself uses. Seeding them means those pages are tried there first: no
        // AES-GCM, and no exposure to the encrypted host's 502 wall. The render
        // manifests add themselves as alternative variants for the same names.
        if (info.cdnPrefetchInfo) {
            try {
                const pf = JSON.parse(info.cdnPrefetchInfo);
                const base = String((pf.cdn && pf.cdn.baseUrl) || '');
                const enc = !!(pf.cdn && pf.cdn.isEncrypted);
                for (const r of (pf.resources || [])) {
                    if (!r || !r.url) continue;
                    const auth = kindlePickAuth(r.authParameter, pf.cdn && pf.cdn.authParameter);
                    if (!auth) continue;
                    const variant = {
                        url: String(r.url), authParameter: auth, authSource: 'prefetch',
                        baseUrl: base, isEncrypted: enc,
                    };
                    const existing = kindleState.resources.get(variant.url);
                    if (existing) {
                        if (!existing.variants.some(v => v.baseUrl === variant.baseUrl)) {
                            existing.variants.push(variant);
                        }
                        continue;
                    }
                    kindleState.resources.set(variant.url, Object.assign({
                        url: variant.url, type: String(r.type || ''), variants: [variant],
                    }, variant));
                }
            } catch (e) {
                // A prefetch block we cannot read must never stop the download;
                // the render manifests are the authoritative source anyway.
                kindleLog('could not read cdnPrefetchInfo: ' + safeLogText(e && e.message));
            }
        }
        if (changed) {
            // A different volume (or a re-published revision) invalidates every
            // derived answer, including the one the probe derived.
            kindleState.pages.clear();
            kindleState.resources.clear();
            kindleState.toc = [];
            kindleState.expectedPages = 0;
            kindleState.lastPositionId = 0;
            kindleState.imageResolution = null;
            kindleState.nextSkip = 0;
            kindleState.walkDone = false;
            kindleState.windowBatch = 0;
            kindleState.startPosition = 1;
            kindleState.startMode = 'explicit';
            kindleState.contentTypeFixed = false;
            kindleState.probe = { status: 'idle', error: null };
        }
        return changed;
    }

    // The reader's own "is this the last page" bound lives in metadata.json.
    // location_map.locations.length - 1 is NOT the view count: it is the number
    // of source page images (the position map's resolution), and a 2-up view
    // consumes about 7 position units, not 2. Deriving the view count from it
    // would stop this walk at roughly half the book.
    function kindleAtEnd() {
        const last = kindleState.lastPositionId;
        if (!last) return false;
        for (const page of kindleState.pages.values()) {
            if (Number(page.endPositionId) >= last) return true;
        }
        return false;
    }
