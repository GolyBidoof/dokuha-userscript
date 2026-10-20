    // The shared harness owns the bars, the page cache, the Mokuro session, the
    // ZIP assembly and the reporting. What is left here is Kindle's own shape:
    // ask the render service for windows of pages until the book ends, then
    // fetch the page images from the signed CDN.
    //
    // Two things make this store cheap. The images need no descrambling, so a
    // "processed page" is just the bytes; and the CDN signature is handed over
    // by the render manifest, so no request has to be signed here.

    //
    // The service does NOT clamp a window it dislikes: it answers
    // 400 {"message":"Unexpected number of pages"} — measured live, where the
    // viewer's own numPage=2 succeeded on the same volume and token while
    // numPage=24 was refused. So the window size is probed downward.
    //
    // Every rung here is a value the reader bundle itself uses, which is the
    // only evidence available for what the service accepts:
    //   * 6 — the default `renderBatchSize` (and `BATCH_RENDER_SIZE` is 5)
    //   * 3 — its `BATCH_SIZE_FOR_METADATA_CALL`
    //   * 2 — what the captured viewer actually sent, and the hard floor
    // Halving 6 gives exactly 3 then 2, so the ladder is those three values.
    // The walk is one render per window, and every render costs ~1.1s, so the
    // window size is the single biggest lever on how long a run appears frozen:
    // 209 pages at 6 per window is 35 serial renders (~38s) before the first page
    // is even fetched. The service refuses an oversized window with
    // 400 "Unexpected number of pages", so start high and let the existing halving
    // ladder find this volume's real ceiling once — the accepted size is
    // remembered in windowBatch and every later window uses it. Paying two
    // refusals to halve the render count is a good trade; do not lower this
    // without measuring, and do not assume 6 is a ceiling (it never was — it was
    // a workaround for a 400 that turned out to be the content type).
    const KINDLE_RENDER_BATCH_MAX = 24;
    const KINDLE_RENDER_BATCH_MIN = 2;
    // The cap exists so a service that answers every window with the same page
    // (or a page whose endPositionId never reaches lastPositionId) cannot spin
    // forever.
    const KINDLE_MAX_WINDOWS = 400;
    // CloudFront fronts this content over HTTP/2, so the browser's
    // six-connections-per-origin ceiling — the thing that forces CMOA and
    // BookWalker through a proxy-port pool — does not apply. Multiplexed streams
    // only fill the link when enough requests are outstanding: at a 300 ms
    // round trip a page is mostly waiting, and 24 streams reach ~82% of the link
    // where 12 reaches ~70%. A page is ~600 KB on the wire and ~570 KB decoded,
    // and every worker holds one plus its base64 body, so 24 is still bounded.
    const KINDLE_FETCH_CONCURRENCY = 24;
    const KINDLE_FETCH_TIMEOUT = 45000;
    // Retryable transport statuses. These were once mistaken for CDN throttling:
    // the run was slowed right down to cure a 502 wall that was really the
    // missing reading-session token (see kindleResourceUrl). Retrying is still
    // right for a genuine bad gateway, but only 429/503 mean "everyone slow
    // down" — a 500/502/504 is retried on its own without stalling the pool.
    const KINDLE_RETRY_STATUS = [429, 500, 502, 503, 504];
    const KINDLE_THROTTLE_STATUS = [429, 503];
    const KINDLE_MAX_FETCH_ATTEMPTS = 5;
    const KINDLE_BACKOFF_CAP_MS = 8000;
    const KINDLE_RESTRICTED_STATUS = [401, 403];

    // The render settings are pinned rather than inherited from whatever the
    // viewer last used. They decide how source pages are grouped into views,
    // not which page images exist, so any valid block yields the whole book —
    // but pinning keeps the page numbering stable between runs, which the page
    // cache and a resumed run both depend on.
    //
    // The key order matches the viewer's own request byte for byte, including
    // putting asin/contentType/revision immediately after version. The service
    // is not documented, so the one request shape that is known to be accepted
    // is the one worth copying rather than reformatting.
    const KINDLE_RENDER_SETTINGS = {
        version: '3.0',
        fontFamily: 'Bookerly',
        fontSize: '4.95',
        lineHeight: '1.4',
        dpi: '160',
        height: '1270',
        width: '1333',
        marginBottom: '0',
        marginLeft: '9',
        marginRight: '9',
        marginTop: '0',
        maxNumberColumns: '2',
        // One of custom|default|night|dark|grey|green|sepia|midnight900.
        theme: 'default',
        locationMap: 'true',
        packageType: 'TAR',
        encryptionVersion: 'NONE',
        rasterScale: '2',
        bundleImages: 'false',
    };

    /**
     * `startingPosition` is the reader's own start-of-book anchor. The bundle
     * gets it from `stuccoBookInformation.startReadingPosition`, which is not in
     * the served page (it is not in either captured HTML), so it cannot simply
     * be read. The two captures used 1 and 18 — per volume, not a constant.
     *
     * 1 is the value that is known to work (the first capture's viewer sent
     * exactly that), and a position the service cannot place does not produce a
     * 400: the bundle's own failure mode for that is a 200 with no pages, and
     * it throws "No pages returned ... startingPosition: N" itself. So the probe
     * treats "no pages" as an unusable anchor and retries once without the
     * parameter, letting the service fall back to the book's own start.
     */
    function kindleRenderUrl(skipPageCount, numPage) {
        if (!kindleState.asin) throw new Error('the Kindle volume id is not known yet');
        if (!kindleState.revision) throw new Error('the Kindle content revision is not known yet');
        const params = new URLSearchParams();
        params.set('version', KINDLE_RENDER_SETTINGS.version);
        params.set('asin', kindleState.asin);
        // NOT a constant: a sample volume's rendering token is minted for
        // "Sample" and refuses "FullBook" outright. See kindleState.contentType.
        params.set('contentType', kindleState.contentType || 'FullBook');
        params.set('revision', kindleState.revision);
        for (const key of Object.keys(KINDLE_RENDER_SETTINGS)) {
            if (key === 'version') continue;
            params.set(key, KINDLE_RENDER_SETTINGS[key]);
        }
        params.set('numPage', String(Math.max(1, Number(numPage) || 1)));
        params.set('skipPageCount', String(Math.max(0, Number(skipPageCount) || 0)));
        if (kindleState.startMode !== 'default') {
            params.set('startingPosition', String(kindleState.startPosition || 1));
        }
        return location.origin + '/renderer/render?' + params.toString();
    }

    // The render call is same-origin, so the reader's own session cookies ride
    // along and no @connect grant is involved.
    async function kindleFetchWindow(skipPageCount, numPage) {
        const url = kindleRenderUrl(skipPageCount, numPage);
        const attempt = async () => {
            const res = await fetchWithTimeout(url, {
                credentials: 'same-origin',
                headers: {
                    'Accept': '*/*',
                    'x-amz-rendering-token': kindleState.token || '',
                },
            }, KINDLE_FETCH_TIMEOUT);
            if (res.ok) return new Uint8Array(await res.arrayBuffer());
            // The body carries the only useful diagnosis ("Unexpected number of
            // pages" vs "Rendering token is not matching the request"), and the
            // two need opposite responses, so keep it.
            const body = await res.text().catch(() => '');
            const e = new Error('HTTP ' + res.status + (body ? ' — ' + body.slice(0, 200) : ''));
            e.status = res.status;
            e.body = body;
            throw e;
        };
        let bytes;
        try {
            bytes = await attempt();
        } catch (e) {
            // The karamel token is short-lived (its own expiresAt is minutes
            // away) and the page can sit open for a while before Save is
            // clicked. Re-read the page state once before giving up: the viewer
            // refreshes #bookInfo in place, so the new token is usually already
            // in the DOM.
            if (!e || KINDLE_RESTRICTED_STATUS.indexOf(e.status) === -1) throw e;
            kindleLog('render refused (' + e.status + '), re-reading the page token');
            kindleState.probe = { status: 'idle', error: null };
            kindleApplyBookInfo();
            if (!kindleState.token) throw e;
            bytes = await attempt();
        }
        return kindleReadTar(bytes);
    }

    /**
     * Fold one render window into the state. Returns how many pages the window
     * carried and how many were new; the walk advances by the former, because a
     * window that overlaps the previous one would otherwise stall the cursor.
     *
     * `opts.skipPageCount` tags each page with the window it arrived in, so a
     * 403 later can be answered by re-rendering exactly that window and picking
     * up a fresh signature. `opts.refreshAuth` lets a refresh overwrite the auth
     * parameter already stored for a resource — normally the first window to name
     * a resource wins, which is what keeps a later stale window from replacing a
     * good signature.
     */
    function kindleIngestWindow(files, opts) {
        const o = opts || {};
        const skip = Number(o.skipPageCount) || 0;
        const manifest = kindleTarJson(files, 'manifest.json');
        const metadata = kindleTarJson(files, 'metadata.json');
        const locationMap = kindleTarJson(files, 'location_map.json');
        const toc = kindleTarJson(files, 'toc.json');

        let returned = 0;
        let added = 0;
        for (const name of kindleTarMemberNames(files, 'page_data_')) {
            const list = kindleTarJson(files, name);
            if (!Array.isArray(list)) continue;
            for (const page of list) {
                if (!page || page.sectionId == null) continue;
                returned++;
                const key = Number(page.sectionId);
                page.__kindleSkip = skip;
                if (!kindleState.pages.has(key)) {
                    kindleState.pages.set(key, page);
                    added++;
                    if (!kindleState.imageResolution) {
                        const res = kindlePageResolution(page);
                        if (res) kindleState.imageResolution = res;
                    }
                }
            }
        }

        if (metadata) {
            if (Number(metadata.lastPositionId) > 0) {
                kindleState.lastPositionId = Number(metadata.lastPositionId);
            }
            if (metadata.progressionDirection) kindleState.progression = String(metadata.progressionDirection);
            if (Array.isArray(metadata.authors) && metadata.authors.length) {
                kindleState.author = String(metadata.authors[0] || '');
            }
            if (!kindleState.title && metadata.bookTitle) kindleState.title = String(metadata.bookTitle);
        }
        if (locationMap && Array.isArray(locationMap.locations) && locationMap.locations.length) {
            // locations.length - 1 is the number of *source page images* (the
            // position map's resolution), which is exactly what gets archived.
            kindleState.expectedPages = locationMap.locations.length - 1;
        }
        if (Array.isArray(toc) && toc.length) kindleState.toc = toc;

        if (manifest && manifest.cdn) {
            const baseUrl = String(manifest.cdn.baseUrl || '');
            const isEncrypted = manifest.cdn.isEncrypted === true;
            const cdnAuth = manifest.cdn.authParameter;
            const list = Array.isArray(manifest.cdnResources) ? manifest.cdnResources : [];
            for (const resource of list) {
                if (!resource || !resource.url) continue;
                // A page name belongs to exactly one window, but the same name
                // can be served raw by one distribution host and ciphertext by
                // another. First writer wins; the flag travels with the
                // descriptor so fetch time does not have to re-decide.
                // Which field carries the signature varies by volume; take the
                // one that is actually a signature. See kindlePickAuth.
                const auth = kindlePickAuth(resource.authParameter, cdnAuth);
                const fromResource = kindleLooksSigned(resource.authParameter);
                const variant = {
                    // The variant carries its own path too: kindleResourceUrl
                    // builds baseUrl + url + auth, and a variant without the path
                    // fails as an incomplete descriptor.
                    url: String(resource.url),
                    authParameter: auth || '',
                    authSource: auth === null ? 'none' : (fromResource ? 'resource' : 'cdn'),
                    baseUrl: baseUrl,
                    isEncrypted: isEncrypted,
                };
                const existing = kindleState.resources.get(resource.url);
                if (existing) {
                    // The same page name is served by several distribution hosts —
                    // the encrypted one under a prefix policy, the plain ones under
                    // per-resource policies — and they do not fail together. Keep
                    // every variant seen so a refused host can be stepped over
                    // instead of costing the page.
                    const known = existing.variants.some(v => v.baseUrl === variant.baseUrl);
                    if (known) {
                        if (!o.refreshAuth) continue;
                        const at = existing.variants.findIndex(v => v.baseUrl === variant.baseUrl);
                        existing.variants[at] = variant;
                        if (at === 0) Object.assign(existing, variant);
                        continue;
                    }
                    // A manifest descriptor outranks one seeded from the page's
                    // prefetch block. That signature is minted at page load, and
                    // by the time a run starts it is stale: in the capture where
                    // the run began three minutes after load, all 20 prefetch
                    // requests answered 403 while the same pages' manifest
                    // descriptors answered 200. Trying it first buys nothing but a
                    // failed round trip per page.
                    if (existing.variants.every(v => v.authSource === 'prefetch')) {
                        existing.variants.unshift(variant);
                    } else {
                        existing.variants.push(variant);
                    }
                    continue;
                }
                kindleState.resources.set(resource.url, Object.assign({
                    url: String(resource.url),
                    type: String(resource.type || ''),
                    variants: [variant],
                }, variant));
            }
        }
        return { returned, added };
    }

    // page_data children carry the source rect, which is the only place the
    // native page size is stated before a page is fetched.
    function kindlePageResolution(page) {
        for (const child of ((page && page.children) || [])) {
            const rect = child && child.rect;
            if (!rect) continue;
            const w = Math.round(Number(rect.right) - Number(rect.left));
            const h = Math.round(Number(rect.bottom) - Number(rect.top));
            if (w > 0 && h > 0) return w + ' × ' + h;
        }
        return null;
    }

    // The window size to ask for next. Starts at the top rung and only ever
    // moves down, because the evidence available is a refusal or a short answer
    // — there is no signal that a larger window would be accepted.
    function kindleNextBatch() {
        const size = kindleState.windowBatch || KINDLE_RENDER_BATCH_MAX;
        return Math.max(KINDLE_RENDER_BATCH_MIN, Math.min(KINDLE_RENDER_BATCH_MAX, size));
    }

    /**
     * A window that comes back shorter than it was asked for either reached the
     * end of the book or hit the service's real ceiling. Both make the number a
     * safe next batch, so remember it — this is also what stops a resumed run
     * re-learning the size.
     */
    function kindleNoteWindowSize(requested, returned) {
        if (returned > 0 && returned < requested) {
            kindleState.windowBatch = Math.max(KINDLE_RENDER_BATCH_MIN, returned);
        }
    }

    // A 400 means the window was too big, not that the volume is unreadable.
    // Halve and retry, and remember the size that worked so the rest of the book
    // — and the next window — does not pay for the discovery again.
    async function kindleFetchWindowOrShrink(skipPageCount, startBatch) {
        let size = Math.max(KINDLE_RENDER_BATCH_MIN, Number(startBatch) || KINDLE_RENDER_BATCH_MIN);
        // The rendering token is minted for one content type, so a mismatch is
        // fatal to every request and is worth exactly one correction. Deriving it
        // from bookInfo is right for every capture seen, but this keeps a volume
        // whose page does not say (or says it wrongly) from being undownloadable.
        let flipped = false;
        for (;;) {
            try {
                const files = await kindleFetchWindow(skipPageCount, size);
                kindleState.windowBatch = size;
                return { files: files, batch: size };
            } catch (e) {
                if (e && e.status === 400 && !flipped &&
                    /rendering token is not matching/i.test(e.body || '')) {
                    flipped = true;
                    kindleState.contentTypeFixed = true;
                    kindleState.contentType = kindleState.contentType === 'Sample' ? 'FullBook' : 'Sample';
                    kindleLog('the render token did not match; retrying as contentType=' +
                        kindleState.contentType);
                    continue;
                }
                if (e && e.status === 400 && size > KINDLE_RENDER_BATCH_MIN) {
                    const next = Math.max(KINDLE_RENDER_BATCH_MIN, size >> 1);
                    kindleLog('window of ' + size + ' pages refused (400) at skip=' +
                        skipPageCount + '; retrying with ' + next);
                    size = next;
                    continue;
                }
                throw e;
            }
        }
    }

    /**
     * Walk the render windows until the reader's own end-of-book condition.
     * Termination is metadata.lastPositionId, compared against a page's
     * endPositionId — that is literally the test the viewer uses. Counting
     * windows against location_map.locations.length - 1 would be wrong by a
     * factor of about two: that number counts source page images, while a 2-up
     * view consumes ~7 position units.
     */
    async function kindleWalkWindows(onStatus) {
        let batch = kindleNextBatch();
        let windows = 0;
        while (!kindleState.walkDone) {
            if (windows >= KINDLE_MAX_WINDOWS) {
                kindleLog('window walk hit the cap at skip=' + kindleState.nextSkip);
                kindleState.walkDone = true;
                break;
            }
            const skip = kindleState.nextSkip;
            const got = await kindleFetchWindowOrShrink(skip, batch);
            const { returned } = kindleIngestWindow(got.files, { skipPageCount: skip });
            windows++;
            if (!returned) { kindleState.walkDone = true; break; }
            kindleState.nextSkip += returned;
            batch = got.batch;
            kindleNoteWindowSize(batch, returned);
            batch = kindleNextBatch();
            if (kindleAtEnd()) { kindleState.walkDone = true; break; }
            if (onStatus) onStatus(kindleState.nextSkip);
        }
        return kindleState;
    }

    // Reading order, and the only place it is decided: pages sorted by
    // sectionId, then each page's children in array order. The rsrc name is an
    // obfuscated ordinal and must not be sorted (it happens to agree today,
    // but the encoding is not ours to depend on).
    function kindleBuildPageList() {
        const ordered = [];
        for (const page of kindleState.pages.values()) ordered.push(page);
        ordered.sort((a, b) => Number(a.sectionId) - Number(b.sectionId));

        const out = [];
        for (const page of ordered) {
            for (const child of (page.children || [])) {
                const ref = String((child && child.imageReference) || '');
                if (!ref) continue;
                // A page can carry non-image children (text, panels); only
                // something with an image reference is a page image.
                if (child.type && child.type !== 'image') continue;
                const resource = kindleState.resources.get(ref) || null;
                // `url` is for display only, so a descriptor that cannot produce
                // one yet does not break the whole list; kindleFetchPage builds
                // the URL it actually uses and reports the real reason.
                let url = null;
                if (resource) { try { url = kindleResourceUrl(resource); } catch (e) { url = null; } }
                out.push({
                    index: out.length + 1,
                    ref: ref,
                    resource: resource,
                    sectionId: Number(page.sectionId),
                    // Which render window this page's signature came from, so a
                    // 403 can be answered by re-rendering exactly that window.
                    skip: page.__kindleSkip,
                    url: url,
                });
            }
        }
        return out;
    }

    // The CDN is cross-origin but permissive (access-control-allow-origin names
    // the reader's own origin, with no allow-credentials), so the shared lanes
    // work and a plain fetch is the fallback. Credentials must stay off: a
    // credentialed request cannot use a specific-origin ACAO.
    async function kindleDecodeBlob(blob) {
        if (typeof createImageBitmap === 'function') {
            try {
                const bmp = await createImageBitmap(blob);
                return {
                    source: bmp, width: bmp.width, height: bmp.height,
                    cleanup: () => { try { if (bmp.close) bmp.close(); } catch (e) {} },
                };
            } catch (e) { /* fall through to an <img> decode */ }
        }
        return new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.decoding = 'async';
            img.onload = () => resolve({
                source: img,
                width: img.naturalWidth || img.width,
                height: img.naturalHeight || img.height,
                cleanup: () => { try { URL.revokeObjectURL(objectUrl); img.src = ''; } catch (e) {} },
            });
            img.onerror = e => { try { URL.revokeObjectURL(objectUrl); } catch (_) {} reject(e || new Error('image decode failed')); };
            img.src = objectUrl;
        });
    }

    // Kindle hands over the finished JPEG, so the default codec costs nothing:
    // the bytes are kept bit-exact and the archive is not a second generation.
    // Only an explicit webp/png choice re-encodes, through a canvas — this build
    // carries no shared image codec, because CMOA's lives in its own fragment.
    async function kindleProcessPage(blob) {
        if (IMAGE_CODEC.ext === 'jpg') return { blob: blob, ext: 'jpg' };
        let decoded = null;
        try {
            decoded = await kindleDecodeBlob(blob);
            const canvas = document.createElement('canvas');
            canvas.width = decoded.width;
            canvas.height = decoded.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('no 2D context');
            ctx.drawImage(decoded.source, 0, 0);
            const out = await new Promise(resolve => canvas.toBlob(resolve, IMAGE_CODEC.type, IMAGE_CODEC.quality));
            if (!out) throw new Error('canvas encode produced nothing');
            return { blob: out, ext: IMAGE_CODEC.ext };
        } catch (e) {
            kindleLog('re-encode failed, keeping the original JPEG', safeLogText(e && e.message));
            return { blob: blob, ext: 'jpg' };
        } finally {
            if (decoded && decoded.cleanup) decoded.cleanup();
        }
    }

    // A shared gate rather than a per-request sleep: when the CDN starts
    // refusing, every worker must slow down together, otherwise the ones still
    // in flight keep the wall up. The backoff is exponential and capped, and any
    // success clears it.
    function kindleThrottleWait() {
        const wait = (kindleState.throttleUntil || 0) - Date.now();
        if (wait <= 0) return Promise.resolve();
        return new Promise(resolve => setTimeout(resolve, wait));
    }
    function kindleNoteRefusal(status) {
        if (KINDLE_THROTTLE_STATUS.indexOf(status) === -1) return;
        // Only a status that names a pace problem stops every worker. Treating a
        // 502 this way turned one bad page into a stall for the whole run.
        kindleState.throttleStrikes = (kindleState.throttleStrikes || 0) + 1;
        const backoff = Math.min(KINDLE_BACKOFF_CAP_MS, 500 * Math.pow(2, kindleState.throttleStrikes));
        kindleState.throttleUntil = Date.now() + backoff;
        kindleLog('the CDN answered ' + status + '; pausing every worker for ' +
            Math.round(backoff / 100) / 10 + 's (strike ' + kindleState.throttleStrikes + ')');
    }
    function kindleNoteSuccess() {
        if (kindleState.throttleStrikes) kindleState.throttleStrikes = 0;
        kindleState.throttleUntil = 0;
    }

    /**
     * Fetch one CDN page resource.
     *
     * The manifest's own absolute URL is fetched directly first. Two reasons:
     *
     *  - it is the only thing that names host, path and signature together, and
     *    the same page name is served by several distribution hosts, one handing
     *    back raw JPEG and another the AES-GCM form. The page's own descriptor is
     *    therefore the only authority on which bytes to expect;
     *  - the CDN sends `access-control-allow-origin: https://read.amazon.co.jp`,
     *    so the reader page can fetch it without a proxy.
     *
     * The shared lane pool is still used, but only as a fallback after a
     * transport failure — it is an optimisation, and this store does not depend
     * on it. (An earlier version of this comment claimed the lanes answered with
     * empty bodies. That was wrong: the HAR recorded `size: 0` for lane requests
     * because it did not capture their bodies at all, which is not evidence about
     * what they returned. The reason to prefer the direct fetch is the one above,
     * not a measurement of the lane.)
     */
    async function kindleFetchBinary(url) {
        let last = null;
        for (let attempt = 0; attempt < KINDLE_MAX_FETCH_ATTEMPTS; attempt++) {
            await waitOutCooldown();
            await kindleThrottleWait();
            try {
                const bytes = await kindleFetchBinaryDirect(url);
                kindleNoteSuccess();
                return bytes;
            } catch (e) {
                last = e;
                if (e && KINDLE_RETRY_STATUS.indexOf(e.status) !== -1) {
                    // Refused for pace, not for content: pause everything and try
                    // the same URL again rather than recording a lost page.
                    kindleNoteRefusal(e.status);
                    continue;
                }
                if (e && e.status) throw e;   // a real answer; retrying will not change it
                // A transport failure is worth exactly one run through the lane pool.
                kindleLog('direct fetch failed, trying the lane pool', safeLogText(e && e.message));
                try {
                    const res = await laneFetch(url, KINDLE_FETCH_TIMEOUT,
                        { allowProxy: proxyCanServe(hostOf(url)) });
                    if (res && res.ok) {
                        const bytes = new Uint8Array(await res.arrayBuffer());
                        recordLane(res._lane, 0, bytes.byteLength);
                        kindleNoteSuccess();
                        return bytes;
                    }
                    if (res && res.status) {
                        const le = new Error('HTTP ' + res.status);
                        le.status = res.status;
                        last = le;
                        if (KINDLE_RETRY_STATUS.indexOf(le.status) !== -1) { kindleNoteRefusal(le.status); continue; }
                        throw le;
                    }
                } catch (le) {
                    if (le && le.status) throw le;
                }
            }
        }
        throw last || new Error('the Kindle CDN could not be reached for ' + hostOf(url));
    }

    async function kindleFetchBinaryDirect(url) {
        const res = await fetchWithTimeout(url, { credentials: 'omit' }, KINDLE_FETCH_TIMEOUT);
        if (!res.ok) {
            const e = new Error('HTTP ' + res.status);
            e.status = res.status;
            throw e;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!bytes.length) {
            // A 200 with no body would otherwise be reported as a page that
            // "could not be fetched" without saying what actually happened.
            throw new Error('the Kindle CDN returned an empty body for ' + hostOf(url));
        }
        return bytes;
    }

    // Re-rendering a window is the only way to get a fresh signature: the auth
    // parameter is minted per render and expires on its own clock, so a window
    // whose signature has aged out cannot be repaired by retrying the same URL.
    // One refresh per window at a time, and the refreshed manifest overwrites
    // the stale auth (kindleIngestWindow's `refreshAuth`).
    const kindleRefreshInflight = new Map();
    const kindleRefreshCounts = new Map();
    // A refresh re-renders the window to mint a fresh signature. When the refusal
    // is NOT expiry that changes nothing, and every failed page asks again — the
    // sample capture shows ~10 duplicate renders of each window for five pages,
    // which is the "frozen while fetching renderers" symptom. Two attempts per
    // window is enough to cover a genuine rollover.
    const KINDLE_MAX_REFRESHES_PER_WINDOW = 2;
    function kindleRefreshWindow(skipPageCount) {
        const key = String(skipPageCount);
        if (kindleRefreshInflight.has(key)) return kindleRefreshInflight.get(key);
        const used = kindleRefreshCounts.get(key) || 0;
        if (used >= KINDLE_MAX_REFRESHES_PER_WINDOW) {
            return Promise.reject(new Error('window ' + key + ' has been re-rendered ' + used +
                ' times and its pages are still refused — this is not an expired signature'));
        }
        kindleRefreshCounts.set(key, used + 1);
        const run = (async () => {
            kindleLog('refreshing the CDN signature via a fresh render of window skip=' + skipPageCount);
            const got = await kindleFetchWindowOrShrink(skipPageCount, kindleNextBatch());
            kindleIngestWindow(got.files, { skipPageCount: skipPageCount, refreshAuth: true });
        })().finally(() => kindleRefreshInflight.delete(key));
        kindleRefreshInflight.set(key, run);
        return run;
    }

    /**
     * Every host variant known for one page, best first. A variant that just
     * worked is promoted, so a volume settles on whichever host is answering and
     * the encrypted host's 502 wall does not cost every remaining page.
     */
    function kindleResourceVariants(resource) {
        if (!resource) return [];
        const list = Array.isArray(resource.variants) && resource.variants.length
            ? resource.variants.slice()
            : [resource];
        return list.filter(v => v && v.authParameter);
    }

    function kindleResourceVariants(resource) {
        if (!resource) return [];
        const list = Array.isArray(resource.variants) && resource.variants.length
            ? resource.variants.slice()
            : [resource];
        return list.filter(v => v && v.authParameter);
    }

    async function kindleFetchPage(descriptor) {
        if (!descriptor.resource) {
            throw new Error('page ' + descriptor.index + ': the render manifest named no resource for ' + descriptor.ref);
        }
        const first = kindleResourceVariants(descriptor.resource);
        if (!first.length) {
            throw new Error('page ' + descriptor.index + ': no usable CDN signature for ' + descriptor.ref);
        }

        let resource = null;
        let bytes = null;
        let firstError = null;
        const tried = new Set();
        // The two distributions fail in opposite ways — a prefix policy 502s
        // without the session token, an exact-resource policy 403s with it — so a
        // wrong judgement about the policy is fatal to every page. The policy
        // decides which form goes first and the other is tried once, which turns
        // a 403/502 into a retry instead of a lost book.
        const attempt = async variant => {
            const prefix = kindleAuthPolicyIsPrefix(variant.authParameter);
            const forms = prefix === false ? [true, false] : [false, true];
            for (const omitSession of forms) {
                const url = kindleResourceUrl(variant, { omitSession: omitSession });
                if (tried.has(url)) continue;
                tried.add(url);
                try {
                    bytes = await kindleFetchBinary(url);
                    resource = variant;
                    return true;
                } catch (e) {
                    if (!firstError) firstError = e;
                    // Only an auth refusal can be a token-form problem; anything
                    // else (404, transport) will be identical on the second try.
                    if (!e || (e.status !== 403 && e.status !== 502)) throw e;
                    kindleLog('page ' + descriptor.index + ': ' +
                        (omitSession ? 'without' : 'with') + ' the session token, ' +
                        hostOf(variant.baseUrl || '') + ' answered ' + e.status +
                        '; trying the other form');
                }
            }
            return false;
        };

        const sweep = async variants => {
            for (const variant of variants) {
                try {
                    if (await attempt(variant)) return true;
                } catch (e) {
                    if (!firstError) firstError = e;
                    kindleLog('page ' + descriptor.index + ': ' + hostOf(variant.baseUrl || '') +
                        ' answered ' + ((e && e.status) || safeLogText(e && e.message)) + '; trying another host');
                }
            }
            return false;
        };

        await sweep(first);

        // A 401/403 on every host is an aged-out signature far more often than a
        // missing page: the walk can outlive the window that minted the URLs.
        // Re-render this page's own window once, which mints fresh ones, then
        // sweep the variants again.
        if (!bytes && descriptor.skip != null && firstError &&
            KINDLE_RESTRICTED_STATUS.indexOf(firstError.status) !== -1) {
            await kindleRefreshWindow(descriptor.skip);
            await sweep(kindleResourceVariants(kindleState.resources.get(descriptor.ref)));
        }

        if (!bytes) throw firstError || new Error('page ' + descriptor.index + ': every host refused');

        // Promote whichever variant answered, so the volume settles on the host
        // that is actually serving instead of paying for the dead one every page.
        const entry = kindleState.resources.get(descriptor.ref);
        if (entry && resource && entry.variants && entry.variants.indexOf(resource) > 0) {
            entry.variants = entry.variants.filter(v => v !== resource);
            entry.variants.unshift(resource);
            Object.assign(entry, resource);
        }

        const jpeg = await kindleDecodeResource(bytes, resource);
        return new Blob([jpeg], { type: 'image/jpeg' });
    }


    function kindleEnsureProbe(force) {
        if (force && kindleState.probe.status === 'failed') {
            kindleState.probe = { status: 'idle', error: null };
        }
        if (kindleState.probe.status === 'ready') return Promise.resolve(kindleState);
        if (kindleProbeInflight) return kindleProbeInflight;
        kindleState.probe.status = 'running';
        kindleProbeInflight = kindleProbeOnce()
            .catch(e => {
                kindleState.probe.status = 'failed';
                kindleState.probe.error = safeLogText((e && e.message) || e);
                throw e;
            })
            .finally(() => { kindleProbeInflight = null; });
        return kindleProbeInflight;
    }

    async function kindleProbeOnce() {
        kindleApplyBookInfo();
        if (!kindleState.asin) {
            throw new Error('this is not a Kindle manga reader page (expected read.amazon.*/manga/<ASIN>)');
        }
        if (!kindleState.token) {
            throw new Error('the Kindle reader has not published its karamel token yet — ' +
                'open the volume in the reader and let a page render, then try again');
        }
        let got = await kindleFetchWindowOrShrink(0, KINDLE_RENDER_BATCH_MAX);
        let ingested = kindleIngestWindow(got.files, { skipPageCount: 0 });
        if (!ingested.returned) {
            // A window that parses but carries no pages means the service could
            // not place the anchor — see kindleRenderUrl. Retry once without it
            // rather than reporting an empty book as a success.
            kindleLog('no pages at startingPosition=' + (kindleState.startPosition || 1) +
                '; retrying and letting the service pick the book start');
            kindleState.startMode = 'default';
            got = await kindleFetchWindowOrShrink(0, KINDLE_RENDER_BATCH_MAX);
            ingested = kindleIngestWindow(got.files, { skipPageCount: 0 });
        }
        const returned = ingested.returned;
        if (!returned) {
            throw new Error('the Kindle render service returned no pages for this volume' +
                ' (try opening a page in the reader first)');
        }
        kindleNoteWindowSize(got.batch, returned);
        kindleState.nextSkip = returned;
        kindleState.walkDone = !returned || kindleAtEnd();
        kindleState.probe.status = 'ready';
        kindleLog('probe: ' + kindleState.pages.size + ' page windows, ' +
            kindleState.expectedPages + ' page images, ' + kindleState.resources.size + ' resources' +
            ', window size ' + kindleNextBatch());
        return kindleState;
    }

    /**
     * Whether a finished run may be reported as a download.
     *
     * The rule used to be `missing === total`, which missed the case that matters:
     * for a SAMPLE, `total` is the full book's location_map count while `walked`
     * is only the sample's handful of pages, so an entirely failed run fell
     * through to finishZip and reported success — with a progress bar and an empty
     * archive. Nothing succeeding is unambiguous; say so.
     */
    function kindleRunOutcome(saved, walked) {
        if (saved > 0) return 'ok';
        return walked > 0 ? 'all-failed' : 'nothing';
    }

    async function kindleRun(ui, mode, options) {
        const runOptions = normalizeRunOptions(options, mode);
        const runResult = runOptions.automation
            ? (runOptions.result || newAutomationResult(mode, kindleState.asin || '', runOptions.deferFinalize))
            : null;
        if (runResult) {
            runOptions.result = runResult;
            runOptions.errors = runResult.errors;
        }

        let harness = null;
        try {
            reportRunProgress(runOptions, 'started', { mode: mode, cid: kindleState.asin || '' });
            kindleState.running = true;
            kindleRefreshCounts.clear();

            kindleApplyBookInfo();
            if (!kindleState.asin) {
                throw new Error('this is not a Kindle manga reader page — open the volume at ' +
                    'read.amazon.co.jp/manga/<ASIN> and try again');
            }
            reportRunProgress(runOptions, 'state-refresh-ready');

            await kindleEnsureProbe(true);

            // The walk and the page fetches now run together. Waiting for every
            // window before fetching anything was the whole of the "frozen for
            // twenty seconds" complaint: the probe already knows the volume's page
            // count from location_map, so the bars and the card can be built
            // immediately, and a page can be fetched as soon as its own window has
            // been rendered. The walk stays in order, so page indices only ever
            // grow and a worker can simply wait for the next one to appear.
            const walkState = { status: 'running', error: null };
            const walkPromise = kindleWalkWindows(skip => {
                reportRunProgress(runOptions, 'render-window', {
                    pageCount: kindleState.pages.size, total: kindleState.expectedPages, skip: skip
                });
            }).then(() => { walkState.status = 'done'; },
                e => { walkState.status = 'failed'; walkState.error = e; });

            const descriptors = kindleBuildPageList();
            const total = kindleState.expectedPages || descriptors.length || kindleState.pages.size;
            if (!total) {
                throw new Error('the Kindle render service returned no pages for this volume' +
                    (kindleState.bookContentType ? ' (content type "' + kindleState.bookContentType + '")' : '') +
                    ' — this reader shape is not supported yet');
            }
            // One line that settles the questions a failure report cannot: how
            // the pages were found, where their signatures came from, and whether
            // any arrived without one. If pages go missing later, this says
            // whether the fault is upstream of the fetch.
            const authCounts = { resource: 0, cdn: 0, none: 0 };
            const hosts = {};
            for (const r of kindleState.resources.values()) {
                authCounts[r.authSource || 'none'] = (authCounts[r.authSource || 'none'] || 0) + 1;
                const h = hostOf(r.baseUrl || '');
                hosts[h] = (hosts[h] || 0) + 1;
            }
            kindleLog('volume ' + kindleState.asin + ': ' + total + ' page images over ' +
                kindleState.pages.size + ' views (location_map says ' + kindleState.expectedPages + ')' +
                '; signatures: ' + JSON.stringify(authCounts) +
                '; hosts: ' + JSON.stringify(hosts));

            const rawTitle = kindleState.title || document.title || '';
            const title = cleanTitle(rawTitle) || kindleState.asin || 'Kindle volume';
            const sv = splitSeriesVolume(rawTitle || title);
            const archiveName = ui.syncArchiveDefault(rawTitle) || zipBaseName(sv, title);
            if (runResult) {
                runResult.cid = kindleState.asin || '';
                runResult.mode = mode;
                runResult.title = title;
                reportRunProgress(runOptions, 'book', { title: title, cid: kindleState.asin || '' });
            }

            harness = createRunHarness(ui, mode, runOptions, {
                title, archiveName, sv, total, cid: kindleState.asin,
            });
            harness.setTotal(total);
            if (runResult) {
                runResult.total = total;
                reportRunProgress(runOptions, 'manifest', { total: total, plaintext: true });
            }

            if (!runOptions.headless) {
                renderBookCard(ui.statsEl, {
                    title: title,
                    pages: total,
                    resolution: kindleState.imageResolution || '?',
                    type: 'Kindle Manga (fixed layout)',
                });
                if (sv.series) fetchAndRenderStats(ui.statsEl, sv.series, sv.volNum);
            }
            harness.showBars();
            if (harness.mokuro) await harness.mokuro.open();

            let concurrency = Math.max(1, Math.min(KINDLE_FETCH_CONCURRENCY, total));
            try {
                if (typeof window !== 'undefined' && window.__bwddMaxInflight > 0) {
                    concurrency = Math.max(1, Math.min(concurrency, window.__bwddMaxInflight | 0));
                }
            } catch (e) {}

            let nextIndex = 0;
            const worker = async () => {
                while (true) {
                    // Pages arrive while the walk runs, so the list is rebuilt
                    // each time and the index only advances past pages that
                    // already exist. Waiting for the walk to finish before
                    // starting was worth tens of seconds of apparent freeze.
                    const list = kindleBuildPageList();
                    if (nextIndex >= list.length) {
                        if (walkState.status !== 'running') return;
                        await sleepMs(40);
                        continue;
                    }
                    const descriptor = list[nextIndex++];
                    try {
                        // A page from a previous run needs neither a fetch nor a
                        // decode; replaying it keeps a resumed volume cheap.
                        let cached = null;
                        if (runOptions.usePageCache && kindleState.asin) {
                            cached = await getCachedPage(kindleState.asin, descriptor.index);
                        }
                        if (cached) {
                            harness.bumpCached(1);
                            harness.noteCached(descriptor.index, cached, cachedPageCrc.get(cached));
                            continue;
                        }
                        const blob = await kindleFetchPage(descriptor);
                        const processed = await kindleProcessPage(blob);
                        harness.bumpFetched(1);
                        harness.notePage(descriptor.index, processed.blob, undefined, processed.ext);
                    } catch (e) {
                        harness.bumpFetched(1);
                        harness.noteFailure(descriptor.index, safeLogText((e && e.message) || e));
                    }
                }
            };
            if (BWDD_DEBUG) {
                kindleLog('pages=' + total + ' concurrency=' + concurrency +
                    ' windows=' + kindleState.pages.size + ' resources=' + kindleState.resources.size);
            }
            const workers = [];
            for (let w = 0; w < concurrency; w++) workers.push(worker());
            await Promise.all(workers);
            // The workers exit when the walk settles, so this only joins it.
            await walkPromise;
            if (walkState.error) throw walkState.error;
            const walkedPages = kindleBuildPageList().length;
            if (!walkedPages) {
                throw new Error('the Kindle render service returned no pages for this volume' +
                    (kindleState.bookContentType ? ' (content type "' + kindleState.bookContentType + '")' : '') +
                    ' — this reader shape is not supported yet');
            }

            // Retry failed pages once after re-reading the page state: a token
            // rollover mid-run is the common cause, exactly as on CMOA.
            if (harness.failedIdx.size && !runOptions.headless) {
                kindleApplyBookInfo();
                // Rebuild the list: the walk ran concurrently with the fetching,
                // so the descriptors captured before it are only the probe's
                // window and would leave most failed pages unattempted.
                const retry = kindleBuildPageList().filter(d => harness.failedIdx.has(d.index));
                for (const descriptor of retry) {
                    try {
                        const blob = await kindleFetchPage(descriptor);
                        const processed = await kindleProcessPage(blob);
                        harness.notePage(descriptor.index, processed.blob, undefined, processed.ext);
                    } catch (e) { /* stays failed; reported below */ }
                }
            }

            const walked = kindleBuildPageList().length;
            const missing = walked - harness.okIdx.size;

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
            if (kindleRunOutcome(harness.okIdx.size, walked) !== 'ok') {
                kindleLog('every page failed (' + walked + ' attempted, 0 saved) — reporting a failed run');
                setRunDetails(harness.details, msgAllFailedZip(), harness.errors);
                return harness.outcome(false);
            }
            return await harness.finishZip();
        } catch (e) {
            const reported = harness ? harness.reportFailure(e) : null;
            if (reported) throw reported;
            throw e;
        } finally {
            kindleState.running = false;
            if (harness) await harness.cleanup();
        }
    }

    registerSite({
        id: 'kindle',
        label: 'Kindle',
        panelTitle: 'Kindle Native Downloader',
        ownsHost() {
            try { return KINDLE_READER_HOST_RE.test(location.hostname); } catch (e) { return false; }
        },
        matches() {
            // read.amazon.* is shared with the rest of the shop, so the path is
            // part of the storefront guard: only /manga/<ASIN> is the reader.
            try {
                return kindleIsMangaPage(location.href);
            } catch (e) { return false; }
        },
        install() {
            // Nothing to hook. The viewer's state is markup (#bookInfo) rather
            // than a signed XHR to capture or a viewer global to read, and the
            // page list comes from a request this adapter makes itself.
            //
            // The URL is still worth reading now: #bookInfo is written late, and
            // the ASIN is the page-cache key, so having it from the first tick
            // means an interrupted run resumes against the right volume even if
            // the panel is used before the viewer has finished booting.
            if (!kindleState.asin) kindleState.asin = kindleAsinFromUrl(location.href);
        },
        // Called by the panel's boot poll every 500 ms, so it must stay cheap:
        // parsing #bookInfo is free, and the one render call it kicks off is
        // fire-and-forget and single-flight.
        refresh() {
            const changed = kindleApplyBookInfo();
            if (changed) kindleState.probe = { status: 'idle', error: null };
            if (kindleState.probe.status === 'idle' && kindleState.asin && kindleState.token) {
                kindleEnsureProbe(false).catch(e => {
                    kindleLog('probe failed', safeLogText((e && e.message) || e));
                });
            }
            return Promise.resolve();
        },
        getBook() {
            if (!kindleState.title && !kindleState.asin) return null;
            const rawTitle = kindleState.title || document.title || '';
            const title = cleanTitle(rawTitle) || kindleState.asin || '';
            const sv = splitSeriesVolume(rawTitle || title);
            return { rawTitle: rawTitle, title: title, series: sv.series, volNum: sv.volNum };
        },
        getPreview() {
            if (!kindleState.pages.size) return null;
            // expectedPages comes from location_map and is the volume's real page
            // count, known as soon as the probe returns. The page-list length is
            // only what the walk has collected so far — a single window right
            // after the probe — and reporting that made the card claim 10 pages
            // and then grow to 210 as the walk advanced.
            const pages = kindleState.expectedPages || kindleBuildPageList().length;
            if (!pages) return null;
            return {
                title: cleanTitle(kindleState.title) || kindleState.asin || 'Kindle volume',
                pages: pages,
                resolution: kindleState.imageResolution || '?',
                type: 'Kindle Manga (fixed layout)',
            };
        },
        getCid() { return kindleState.asin || ''; },
        archiveDefault(rawTitle) {
            return archiveDefaultName(rawTitle) || fsSafePath(kindleState.asin || '');
        },
        run(ui, mode, options) { return kindleRun(ui, mode, options); },
        state: kindleState,
        debug: {
            kindleState,
            kindleReadTar, kindleIngestWindow, kindleBuildPageList, kindleRenderUrl,
            kindleFetchWindow, kindleWalkWindows, kindleProbeOnce, kindleEnsureProbe,
            kindleFetchPage, kindleFetchBinary, kindleProcessPage,
            kindleKeyMaterial, kindleDecryptImage, kindleDecodeResource, kindleResourceUrl,
            kindlePickAuth, kindleLooksSigned, kindleRefreshWindow, kindleAtEnd,
            kindleAuthPolicyResource, kindleAuthPolicyIsPrefix, kindleRunOutcome,
        },
        debugGlobals: { __bwddKindle: kindleState },
    });
