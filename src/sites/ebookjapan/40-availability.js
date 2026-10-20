
    // ebookjapan is a Nuxt app: its server-rendered state is a devalue payload in
    // a <script type="application/json"> block, where every primitive is hoisted
    // into one flat array and referenced by index. Reconstituting that is the
    // only way to the per-volume prices, which the rendered page never carries.
    function decodePayload(html) {
        const m = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i.exec(String(html || ''));
        if (!m) return null;
        let flat = null;
        try { flat = JSON.parse(m[1]); } catch (e) { return null; }
        if (!Array.isArray(flat) || !flat.length) return null;
        const cache = new Map();
        const hydrate = (ref) => {
            // devalue hoists every number into the array and references it by
            // index; strings, booleans and null stay inline and are returned
            // as-is. Only a number can be a (possibly out-of-range) reference.
            if (typeof ref !== 'number') return ref;
            if (!isFinite(ref) || Math.floor(ref) !== ref || ref < 0 || ref >= flat.length) return undefined;
            if (cache.has(ref)) return cache.get(ref);
            const value = flat[ref];
            if (!value || typeof value !== 'object') { cache.set(ref, value); return value; }
            if (Array.isArray(value)) {
                const head = value[0];
                // Nuxt wraps reactive state; the wrapper is not part of the data.
                if (head === 'ShallowReactive' || head === 'Reactive' ||
                    head === 'ShallowRef' || head === 'Ref') return hydrate(value[1]);
                if (head === 'Date' || head === 'BigInt' || head === 'RegExp') {
                    cache.set(ref, value[1]);
                    return value[1];
                }
                const out = [];
                cache.set(ref, out);
                for (const item of value) out.push(hydrate(item));
                return out;
            }
            const out = {};
            cache.set(ref, out);
            for (const key of Object.keys(value)) out[key] = hydrate(value[key]);
            return out;
        };
        return hydrate(0);
    }

    // Nuxt keys the store by its route ("books-title_pc:<hash>") and keeps the
    // same key in an `_errors` slot, holding null or a serialized error. That
    // slot is not a store, and traversal order decides which one is met first,
    // so a candidate has to look like a store to be returned.
    function isEbookjapanStore(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value) &&
            !!(value.titleInfo || value.publication || value.purchasablePublications ||
                value.sameTitlePublications || value.freePublications || value.branchPublications);
    }

    function payloadStore(payload) {
        const seen = new Set();
        const stack = [payload];
        while (stack.length) {
            const node = stack.pop();
            if (!node || typeof node !== 'object' || seen.has(node)) continue;
            seen.add(node);
            if (Array.isArray(node)) {
                for (const item of node) stack.push(item);
                continue;
            }
            for (const key of Object.keys(node)) {
                if (key.indexOf('books-title') === 0 && isEbookjapanStore(node[key])) return node[key];
                stack.push(node[key]);
            }
        }
        return null;
    }

    // The same volume is listed several times under different offers: a normal
    // purchase in `purchasablePublications`, and the limited-time free campaign
    // in `sameTitlePublications` / `freePublications`. Reading only the first
    // list hides the free offer behind the paid one for the same volume.
    function ebjPublicationRows(payload, titleId) {
        const lists = payload ? [payload.purchasablePublications, payload.sameTitlePublications,
            payload.freePublications, payload.branchPublications] : [];
        const byCd = new Map();
        const out = [];
        for (const list of lists) {
            if (!Array.isArray(list)) continue;
            for (const pub of list) {
                if (!pub || !pub.publicationCd) continue;
                const goods = pub.goods || {};
                const title = String(pub.name || '').trim();
                const price = Number(goods.price);
                const row = {
                    title: title,
                    url: titleId ? ('https://ebookjapan.yahoo.co.jp/books/' + titleId + '/' + pub.publicationCd + '/') : '',
                    vol: extractVolumeNumber(title),
                    price: isFinite(price) && price > 0 ? price : null,
                    free: !!(goods.isFree || goods.isBrowserSpecialFree) || price === 0,
                    until: goods.saleEndDatetime || '',
                };
                const prev = byCd.get(pub.publicationCd);
                if (!prev) { byCd.set(pub.publicationCd, row); out.push(row); continue; }
                // The offer a reader can actually use wins: free first, then the
                // cheaper price. The row keeps its position in the list.
                const better = (row.free && !prev.free) ||
                    (row.free === prev.free && row.price != null && (prev.price == null || row.price < prev.price));
                if (better) { byCd.set(pub.publicationCd, row); out[out.indexOf(prev)] = row; }
            }
        }
        return out;
    }

    registerAvailabilityStore({
        id: 'ebookjapan', siteId: 'ebookjapan', label: 'ebookjapan', short: 'e',
        color: '#e8820c', origin: 'https://ebookjapan.yahoo.co.jp', hosts: ['ebookjapan.yahoo.co.jp'],
        search: (q) => 'https://ebookjapan.yahoo.co.jp/search/?keyword=' + encodeURIComponent(q),
        product: (p) => /^\/books\/\d+\//.test(p),
        // A volume page already carries the whole run, so prefer it over the
        // title page and save the extra fetch listPages would make.
        rank: (p) => (/^\/books\/\d+\/[A-Z]/.test(p) ? 0.5 : 0),
        // The rendered page states no price, and the payload's own
        // per-volume flags do not carry a series-level campaign count, so the
        // badge on the matched card ("2冊無料") is read from the card itself
        // rather than inferred.
        freeBadge: (html) => {
            const all = [];
            const re = /([0-9]+)\s*冊無料/g;
            let m;
            while ((m = re.exec(String(html || '')))) all.push(parseInt(m[1], 10));
            return all.length ? Math.max.apply(null, all) : 0;
        },
        volumes: (doc, html) => {
            const payload = payloadStore(decodePayload(html));
            if (!payload) return [];
            const titleId = payload.titleInfo && payload.titleInfo.titleId;
            return ebjPublicationRows(payload, titleId);
        },
        // The title page (/books/<id>/) names only one publication, so its
        // first volume is opened for the list that has all of them.
        listPages: (doc, html) => {
            const payload = payloadStore(decodePayload(html));
            if (!payload) return [];
            if (payload.purchasablePublications || payload.sameTitlePublications) return [];
            const titleId = payload.titleInfo && payload.titleInfo.titleId;
            const first = payload.firstPublication || payload.titlePublicationMain || payload.lastPublication;
            if (!titleId || !first || !first.publicationCd) return [];
            return ['https://ebookjapan.yahoo.co.jp/books/' + titleId + '/' + first.publicationCd + '/'];
        },
    });
