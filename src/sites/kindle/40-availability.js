    // Cross-store availability: the Amazon Kindle adapter for the "also
    // available on" card, module `feature/availability`, so only the combined
    // build pulls it in. Amazon's results are already per volume and a Kindle
    // Unlimited card leads with the subscription zero, so the yen amount Amazon
    // actually charges is read from the volume's own page. The yen and series
    // readers for that travel with the adapter.

    // The yen amount amazon.co.jp actually charges. Both the result card and the
    // volume page state it ("JPY 620が請求されます", "ご請求額:JPY 620"), and unlike
    // the headline price it does not follow the visitor's display currency. It is
    // also not the Kindle Unlimited zero, which is why a missing charge is
    // resolved from the volume's own page instead of being read as free.
    // null means "not stated here"; 0 is a real zero.
    // Amazon states the series size and this volume's place in it on every
    // result card ("全22巻中第1巻"). That number is the only thing separating two
    // series whose titles share a prefix, so it is carried on the row.
    function amazonSeriesSize(title, pageText) {
        const t = String(pageText || '') + ' ' + String(title || '');
        const m = /全(\d+)巻中第?\d+巻/.exec(t);
        return m ? Number(m[1]) : null;
    }

    function amazonKindleUnlimited(text) {
        // The service keeps its Latin name on the Japanese storefront, so this
        // stays narrow: "読み放題" alone also labels other subscription shelves.
        return /Kindle\s*Unlimited/i.test(String(text || ''));
    }

    function amazonYen(text) {
        const t = String(text || '');
        const patterns = [
            // The volume's own page states the amount charged outright.
            /ご請求額\s*[:：]?\s*(?:JPY|￥|¥)\s*([0-9][0-9,]*)/,
            /JPY\s*([0-9][0-9,]*)\s*が請求されます/,
            // A Kindle Unlimited card leads with a zero and states the real
            // buying price second ("または ￥620 (62pt)で購入").
            /(?:または|or)\s*[、,]?\s*(?:JPY|￥|¥)\s*([0-9][0-9,]*)/,
        ];
        // A bare yen price is only trustworthy when nothing offers the book
        // through Kindle Unlimited, whose zero is not a price for it.
        if (!/Kindle Unlimited/i.test(t)) patterns.push(/(?:￥|¥)\s*([0-9][0-9,]*)/);
        for (const re of patterns) {
            const m = re.exec(t);
            if (!m) continue;
            const n = parseInt(m[1].replace(/,/g, ''), 10);
            if (isFinite(n)) return n;
        }
        return null;
    }

    // A Kindle result's volume number: Amazon's own "全16巻中第3巻" line is
    // authoritative, because a series title can itself contain a number
    // ("かげきしょうじょ!!［1話売り］ 第58幕").
    function amazonVolumeNumber(title, pageText) {
        const m = /全\s*[0-9,]+\s*巻中\s*第?\s*([0-9]+)\s*巻/.exec(String(pageText || ''));
        if (m) return parseInt(m[1], 10);
        return extractVolumeNumber(title);
    }

    registerAvailabilityStore({
        id: 'kindle', siteId: 'kindle', label: 'Amazon Kindle', pill: 'Kindle', short: 'A',
        color: '#c45500', origin: 'https://www.amazon.co.jp',
        hosts: ['www.amazon.co.jp', 'amazon.co.jp'],
        search: (q) => 'https://www.amazon.co.jp/s?k=' + encodeURIComponent(q) + '&i=digital-text',
        // Result hrefs are a title slug followed by /dp/<ASIN>/ref=..., so the
        // product is the /dp/ segment rather than the whole path.
        product: (p) => /\/dp\/[A-Z0-9]{10}(?:\/|$)/i.test(p) || /^\/gp\/product\/[A-Z0-9]{10}/i.test(p),
        rank: () => 0,
        // Amazon's results are per volume, not per series, so the rows are read
        // from the search page itself rather than from the page the search matched.
        fromSearch: true,
        // The search page mixes series that share a title prefix, so the
        // series the matched card belongs to is read from that card.
        seriesOf: (cardHtml) => amazonSeriesSize('', cardHtml),
        volumes: (doc) => {
            const cards = doc.querySelectorAll('[data-component-type="s-search-result"][data-asin]');
            const out = [];
            for (const card of cards) {
                const asin = (card.getAttribute('data-asin') || '').trim().toUpperCase();
                if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
                const h2 = card.querySelector('h2');
                const title = ((h2 && h2.textContent) || '').replace(/\s+/g, ' ').trim();
                if (!title) continue;
                const text = card.textContent || '';
                const price = amazonYen(text);
                const ku = amazonKindleUnlimited(text);
                out.push({
                    title: title, url: 'https://www.amazon.co.jp/dp/' + asin + '/',
                    vol: amazonVolumeNumber(title, text),
                    // The KU offer is a separate fact from the price: a KU
                    // book can still cost money to buy, and its "￥0" is the
                    // subscription price, never this book's.
                    price: price, free: price === 0 && !ku, ku: ku, until: '',
                    series: amazonSeriesSize(title, text),
                    // A row with no yen charge of its own is resolved from its
                    // own page instead.
                    page: price == null,
                });
            }
            if (out.length) return out;
            // A volume's own page. The charge line is the amount Amazon actually
            // takes and is stated in yen even when the display currency is not.
            const main = doc.querySelector('#productTitle, #title');
            const title = ((main && main.textContent) || '').replace(/\s+/g, ' ').trim();
            if (!title) return [];
            const text = (doc.body && doc.body.textContent) || '';
            const price = amazonYen(text);
            const ku = amazonKindleUnlimited(text);
            return [{
                title: title, url: '', vol: amazonVolumeNumber(title, text),
                price: price, free: price === 0 && !ku, ku: ku, until: '',
                series: amazonSeriesSize(title, text),
            }];
        },
    });
