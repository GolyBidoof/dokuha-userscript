    // Cross-store availability: the DMMブックス adapter for the "also available
    // on" card, module `feature/availability`, so only the combined build pulls
    // it in. DMM's search page is server-rendered and one card stands for the
    // whole series, while the product page carries the per-volume rows in its
    // Next.js flight payload: each volume's price, free-streaming URL and
    // limited-free end. The product page states how many volumes the series has
    // and paginates them, so the store's own BFF endpoint is asked for the rest
    // of the run instead of clicking through a rendered list.

    // The flight payload is a sequence of `self.__next_f.push([1,"..."])`
    // strings; each one is a JSON string literal, and the state may be split
    // across them. Concatenating the decoded strings rebuilds the tree.
    function dmmAvailabilityFlight(html) {
        const text = String(html || '');
        const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
        let out = '';
        let m;
        while ((m = re.exec(text))) {
            try { out += JSON.parse(m[1]); } catch (e) {}
        }
        return out;
    }

    // Read the JSON value that follows `"key":` in the flight text. The payload
    // is plain JSON once the push strings are decoded, so a balanced scan that
    // knows about strings is enough; `"$undefined"` is itself a string and
    // parses fine.
    function dmmAvailabilityJsonValue(text, key) {
        const at = String(text || '').indexOf('"' + key + '":');
        if (at < 0) return null;
        let i = at + key.length + 3;
        while (i < text.length && /\s/.test(text[i])) i++;
        const first = text[i];
        if (first !== '[' && first !== '{') return null;
        const close = first === '[' ? ']' : '}';
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let k = i; k < text.length; k++) {
            const ch = text[k];
            if (inString) {
                if (escape) escape = false;
                else if (ch === '\\') escape = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') { inString = true; continue; }
            if (ch === first) depth++;
            else if (ch === close) {
                depth--;
                if (depth === 0) {
                    try { return JSON.parse(text.slice(i, k + 1)); } catch (e) { return null; }
                }
            }
        }
        return null;
    }

    // A product page answers with the flight payload; a page of the BFF volume
    // list answers with snake_case JSON. Both carry the same per-volume facts and
    // both name the series total in their pager.
    function dmmAvailabilityPayload(html) {
        const text = String(html || '').trim();
        if (!text) return null;
        if (text[0] === '{') {
            try {
                const body = JSON.parse(text);
                if (body && Array.isArray(body.volume_books)) {
                    return {
                        rows: body.volume_books,
                        total: Number(body.pager && body.pager.total_count) || body.volume_books.length,
                        snake: true,
                    };
                }
            } catch (e) {}
            return null;
        }
        const flight = dmmAvailabilityFlight(html);
        if (!flight) return null;
        const rows = dmmAvailabilityJsonValue(flight, 'volumeBooks');
        if (!Array.isArray(rows)) return null;
        const pager = dmmAvailabilityJsonValue(flight, 'pager');
        return {
            rows: rows,
            total: Number(pager && (pager.totalCount || pager.total_count)) || rows.length,
            snake: false,
        };
    }

    // `$undefined` is the flight encoder's placeholder for a missing value, and
    // a URL field can be a list of offers rather than one string.
    function dmmAvailabilityText(value) {
        return value && value !== '$undefined' ? String(value) : '';
    }

    function dmmAvailabilityUrls(value) {
        if (Array.isArray(value)) return value.map(dmmAvailabilityText).filter(Boolean);
        const one = dmmAvailabilityText(value);
        return one ? [one] : [];
    }

    function dmmAvailabilityPrice(sell) {
        if (!sell || typeof sell !== 'object') return null;
        for (const key of ['campaignPrice', 'campaign_price', 'fixedPrice', 'fixed_price']) {
            const n = Number(sell[key]);
            if (isFinite(n) && n > 0) return n;
        }
        return null;
    }

    // The limited-free end is an ISO timestamp in JST; the card's other stores
    // spell the same fact as "10/22 23:59", so it is kept in that shape.
    function dmmAvailabilityUntil(value) {
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(dmmAvailabilityText(value));
        if (!m) return '';
        const month = m[2].replace(/^0/, '');
        const day = m[3].replace(/^0/, '');
        return month + '/' + day + ' ' + m[4] + ':' + m[5];
    }

    function dmmAvailabilityRows(payload) {
        const out = [];
        if (!payload) return out;
        for (const entry of payload.rows) {
            if (!entry || typeof entry !== 'object') continue;
            const title = dmmAvailabilityText(entry.title).trim();
            if (!title) continue;
            const volume = payload.snake ? entry.volume_number : entry.volumeNumber;
            const limited = payload.snake ? entry.limited_free : entry.limitedFree;
            const freeUrls = dmmAvailabilityUrls(
                payload.snake ? entry.free_streaming_url : entry.freeStreamingUrl);
            let url = '';
            const productUrl = dmmAvailabilityText(payload.snake ? null : entry.productUrl);
            if (productUrl) {
                try { url = new URL(productUrl, 'https://book.dmm.com/').href; } catch (e) { url = ''; }
            }
            out.push({
                title: title,
                url: url,
                vol: Number.isInteger(volume) ? volume : extractVolumeNumber(title),
                price: dmmAvailabilityPrice(entry.sell),
                // A free_streaming_url is the store's own "read this volume
                // free" button; a tachiyomi_url is only a 試し読み sampler and
                // is deliberately not free.
                free: freeUrls.length > 0,
                until: freeUrls.length ? dmmAvailabilityUntil(limited && limited.end) : '',
            });
        }
        return out;
    }

    registerAvailabilityStore({
        id: 'dmm', siteId: 'dmm', label: 'DMMブックス', pill: 'DMM', short: 'D',
        color: '#1b62b3', origin: 'https://book.dmm.com', hosts: ['book.dmm.com'],
        // The search results are server-rendered, so the same GET the site's
        // own form uses answers here. A Japan-region visitor needs no login.
        search: (q) => 'https://book.dmm.com/search/?searchstr=' + encodeURIComponent(q),
        // A result card points at /product/<series>/<content>/, and the same
        // volume list is embedded on the series page without the content part.
        product: (p) => /^\/product\/\d+\/(?:[a-z0-9]+\/)?$/i.test(p),
        rank: (p) => (/^\/product\/\d+\/[a-z0-9]+\/$/i.test(p) ? 0.5 : 0),
        volumes: (doc, html) => dmmAvailabilityRows(dmmAvailabilityPayload(html)),
        // The product page embeds the first page of volumes only. Its pager
        // states the whole run, and the site fills the rest from
        // /ajax/bff/contents_book/. Asking that endpoint for page 1 with
        // per_page=100 returns the complete list in one request for a normal
        // series; duplicate rows are harmless because the card counts distinct
        // volume numbers.
        listPages: (doc, html, url) => {
            const payload = dmmAvailabilityPayload(html);
            if (!payload || !(payload.total > payload.rows.length)) return [];
            let series = '';
            try {
                const m = /^\/product\/(\d+)(?:\/|$)/.exec(new URL(url).pathname);
                if (m) series = m[1];
            } catch (e) { return []; }
            if (!series) return [];
            const out = [];
            const pages = Math.ceil(payload.total / 100);
            for (let page = 1; page <= pages; page++) {
                out.push('https://book.dmm.com/ajax/bff/contents_book/?shop_name=general&series_id='
                    + encodeURIComponent(series) + '&page=' + page
                    + '&per_page=100&read_position=latest&order=asc&purchased_status=all');
            }
            return out;
        },
    });
