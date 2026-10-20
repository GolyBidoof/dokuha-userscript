    let pageDB = null;
    let pageDBPromise = null;
    function openPageDB() {
        // A run starts every one of its page attempts at once, so a per-call open
        // made a 200-page volume ask IndexedDB for 200 connections before the
        // first page left the gate. Share the single in-flight open instead:
        // every caller waits on the promise the first caller already created.
        if (pageDB) return Promise.resolve(pageDB);
        if (pageDBPromise) return pageDBPromise;
        pageDBPromise = new Promise((resolve, reject) => {
            let req;
            try { req = indexedDB.open('bwdd-pages-v2', 1); } catch (e) { reject(e); return; }
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages');
            };
            req.onsuccess = () => { pageDB = req.result; resolve(pageDB); };
            req.onerror = () => reject(req.error);
            // An open blocked by another tab's upgrade fires only this event; a
            // caller parked on a promise that never settles is a stalled page.
            req.onblocked = () => reject(new Error('page cache open blocked'));
        });
        pageDBPromise.catch(() => { pageDBPromise = null; });
        return pageDBPromise;
    }
    // Resolves to null when `p` has not answered within `ms`, and never rejects,
    // so a caller can treat "no answer in time" exactly like "no cached page".
    function withDeadline(p, ms) {
        return new Promise((resolve) => {
            let done = false;
            const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
            p.then(
                (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
                () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } },
            );
        });
    }
    // The cache read sits in front of every fetch, so it must never be able to
    // hold one. The healthy path answers in single-digit milliseconds; this only
    // fires when the store is wedged behind a write burst or a prune, and losing
    // a cache hit there costs one re-fetch - far less than the alternative,
    // which is a page that never starts and a run that never reaches its ZIP.
    const PAGE_CACHE_READ_TIMEOUT_MS = 1000;
    // Entries are {blob, ts, crc}: ts enforces the TTL and the size cap keeps the
    // cache from eating the browser's disk. Keys include the codec and quality so
    // a format change cannot reuse the wrong output blob or CRC.
    const PAGE_CACHE_TTL_MS = 20 * 60 * 1000;
    const PAGE_CACHE_MAX_ENTRIES = 4000;        // safety cap (~3 GB at 700 KB/page)
    const PAGE_CACHE_PRUNE_INTERVAL_MS = 30 * 1000;
    const cachedPageCrc = new WeakMap();
    let pageCachePruneTimer = null;
    let pageCachePruneInFlight = null;
    let pageCachePruneRequested = false;
    // Starts the interval clock at load. Left at 0, the very first `put` of a run
    // scheduled a full-store cursor scan immediately, in the middle of the fetch
    // burst it then blocked behind its readwrite transaction. The first prune is
    // wanted for a stale cache, but it can wait one interval to get it.
    let lastPageCachePruneAt = Date.now();
    function schedulePageCachePrune(delayMs) {
        // Headless automation intentionally does not keep a page-cache
        // housekeeping timer alive between Puppeteer runs.
        if (isHeadlessPage()) return;
        // A full cursor scan after every put turns a 300-page run into hundreds
        // of overlapping O(cache-size) scans. Keep at most one periodic prune.
        if (pageCachePruneInFlight) {
            // A write that arrived while the cursor was walking would otherwise
            // leave no future trigger once that walk finishes.
            pageCachePruneRequested = true;
            return;
        }
        if (pageCachePruneTimer !== null) return;
        const earliest = lastPageCachePruneAt + PAGE_CACHE_PRUNE_INTERVAL_MS;
        const delay = Math.max(delayMs || 0, earliest - Date.now());
        pageCachePruneTimer = setTimeout(() => {
            pageCachePruneTimer = null;
            lastPageCachePruneAt = Date.now();
            pageCachePruneInFlight = prunePageCache();
            const done = () => {
                pageCachePruneInFlight = null;
                if (pageCachePruneRequested) {
                    pageCachePruneRequested = false;
                    schedulePageCachePrune();
                }
            };
            pageCachePruneInFlight.then(done, done);
        }, delay);
    }
    function pageCacheKey(cid, index) {
        const type = (typeof IMAGE_CODEC !== 'undefined' && IMAGE_CODEC.type) || 'image/jpeg';
        const quality = (typeof IMAGE_CODEC !== 'undefined' && IMAGE_CODEC.quality) || '';
        return cid + ':' + index + ':' + type + ':' + quality;
    }
    async function cachePage(cid, index, blob, crc) {
        try {
            const db = await openPageDB();
            const key = pageCacheKey(cid, index);
            const record = { blob, ts: Date.now() };
            if (Number.isInteger(crc)) record.crc = crc;
            await new Promise((res, rej) => {
                const tx = db.transaction('pages', 'readwrite');
                tx.objectStore('pages').put(record, key);
                tx.oncomplete = () => res(true);
                tx.onerror = () => rej(tx.error);
                tx.onabort = () => rej(tx.error || new Error('page cache put aborted'));
            });
            schedulePageCachePrune();
            return true;
        } catch (e) { return false; }
    }
    function readCachedRecord(db, key) {
        return new Promise((res) => {
            let settled = false;
            const finish = (v) => { if (!settled) { settled = true; res(v); } };
            let tx;
            try { tx = db.transaction('pages', 'readonly'); }
            catch (e) { finish(null); return; }
            // A request's own error is not the only way a read can end: an
            // aborted transaction fires neither `onsuccess` nor `onerror`, and
            // without these the promise - and the page awaiting it - would hang
            // for the life of the tab.
            tx.onabort = () => finish(null);
            tx.onerror = () => finish(null);
            try {
                const rq = tx.objectStore('pages').get(key);
                rq.onsuccess = () => finish(rq.result || null);
                rq.onerror = () => finish(null);
            } catch (e) { finish(null); }
        });
    }
    async function getCachedPage(cid, index) {
        try {
            const db = await withDeadline(openPageDB(), PAGE_CACHE_READ_TIMEOUT_MS);
            if (!db) return null;
            const v = await withDeadline(readCachedRecord(db, pageCacheKey(cid, index)), PAGE_CACHE_READ_TIMEOUT_MS);
            if (v && v.blob) {
                if (Number.isInteger(v.crc)) cachedPageCrc.set(v.blob, v.crc);
                return v.blob;
            }
            return null;
        } catch (e) { return null; }
    }
    async function prunePageCache() {
        try {
            const db = await openPageDB();
            const now = Date.now();
            await new Promise((res) => {
                const tx = db.transaction('pages', 'readwrite');
                const st = tx.objectStore('pages');
                const req = st.openCursor();
                req.onsuccess = () => {
                    const cur = req.result;
                    if (!cur) { res(true); return; }
                    const val = cur.value;
                    if (val && val.ts && (now - val.ts) > PAGE_CACHE_TTL_MS) {
                        cur.delete();
                    }
                    cur.continue();
                };
                tx.oncomplete = () => res(true);
                req.onerror = () => res(true);
            });
            await new Promise((res) => {
                const tx = db.transaction('pages', 'readwrite');
                const st = tx.objectStore('pages');
                const countReq = st.count();
                countReq.onsuccess = () => {
                    const n = countReq.result;
                    if (n <= PAGE_CACHE_MAX_ENTRIES) { res(true); return; }
                    const delReq = st.openCursor();
                    let toDelete = n - PAGE_CACHE_MAX_ENTRIES;
                    delReq.onsuccess = () => {
                        const cur = delReq.result;
                        if (!cur || toDelete <= 0) { res(true); return; }
                        cur.delete(); toDelete--;
                        cur.continue();
                    };
                    delReq.onerror = () => res(true);
                };
                countReq.onerror = () => res(true);
            });
        } catch (e) {}
    }
    async function clearPageCache() {
        try {
            if (pageCachePruneTimer !== null) {
                clearTimeout(pageCachePruneTimer);
                pageCachePruneTimer = null;
            }
            if (pageCachePruneInFlight) {
                try { await pageCachePruneInFlight; } catch (e) {}
                pageCachePruneInFlight = null;
            }
            if (pageCachePruneTimer !== null) {
                clearTimeout(pageCachePruneTimer);
                pageCachePruneTimer = null;
            }
            pageCachePruneRequested = false;
            const db = await openPageDB();
            await new Promise((res, rej) => {
                const tx = db.transaction('pages', 'readwrite');
                tx.objectStore('pages').clear();
                tx.oncomplete = () => res(true);
                tx.onerror = () => rej(tx.error);
            });
            if (BWDD_DEBUG) console.log('[bwdd] Page cache cleared');
            return true;
        } catch (e) { return false; }
    }
