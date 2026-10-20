    // Cross-store availability: the k-manga adapter for the "also available on"
    // card, module `feature/availability`, so only the combined build pulls it
    // in. k-manga states every amount in points rather than yen and paginates its
    // title page, so the adapter reads the point amount and follows the pager.

    registerAvailabilityStore({
        id: 'kmanga', siteId: 'kmanga', label: 'k-manga', short: 'k',
        color: '#b8860b', origin: 'https://comic.k-manga.jp', hosts: ['comic.k-manga.jp'],
        // The header search POSTs to /search/word/<word>, but the same path
        // answers a plain GET, which is the only verb the availability fetch
        // can use. The word is normalised the way the site's own script does
        // it: full-width spaces and runs of whitespace become one ASCII space
        // before encoding.
        search: (q) => 'https://comic.k-manga.jp/search/word/'
            + encodeURIComponent(String(q || '').replace(/(\u3000|\s)+/g, ' ').trim()),
        // A result is one series card pointing at /title/<id>/pv; a volume's
        // own page is /title/<id>/vol/<n>. Prefer the series page.
        product: (p) => /^\/title\/\d+\/(?:pv|vol\/\d+)\/?$/.test(p),
        rank: (p) => (/\/pv\/?$/.test(p) ? 0.5 : 0),
        // The title page states each volume's amount in points, never yen:
        // `.book-chapter--pt` reads "718pt". A free volume keeps that regular
        // point price on its row (the "1冊無料" campaign sits beside it), so
        // free is read from the 無料で読む button and never inferred from the
        // amount. Every row is marked `unit: 'pt'` so the pill prints "718pt"
        // rather than a yen figure the page never stated.
        volumes: (doc) => {
            const out = [];
            for (const row of doc.querySelectorAll('.book-chapter--target')) {
                const a = row.querySelector('.book-chapter--title a') || row.querySelector('a[href*="/vol/"]');
                const img = row.querySelector('img[alt]');
                const num = row.querySelector('.book-chapter--num');
                const title = ((a && a.textContent) || (img && img.getAttribute('alt')) || '').trim();
                let url = '';
                if (a) { try { url = new URL(a.getAttribute('href') || '', 'https://comic.k-manga.jp/').href; } catch (e) {} }
                let vol = NaN;
                const vm = /\/vol\/(\d+)/.exec(url);
                if (vm) vol = parseInt(vm[1], 10);
                if (!isFinite(vol) || !vol) vol = extractVolumeNumber((num && num.textContent) || title);
                // Scoped to the price line: `.book-chapter--pt` is also the
                // class on the bottom row's "1冊無料" campaign label, which is
                // not an amount.
                let price = null;
                const pt = row.querySelector('.book-chapter--page-price .book-chapter--pt');
                if (pt) {
                    const m = /([0-9][0-9,]*)\s*pt/.exec(pt.textContent || '');
                    if (m) price = parseInt(m[1].replace(/,/g, ''), 10);
                }
                const free = !!row.querySelector('.book-chapter--btn__jikuri, .gaevent-detail-chapter-read-jikkuri');
                let until = '';
                const bottom = row.querySelector('.book-chapter--bottom');
                if (bottom) {
                    const m = /([0-9]{1,2}\/[0-9]{1,2}(?:\s+[0-9]{1,2}:[0-9]{2})?)\s*まで/.exec(bottom.textContent || '');
                    if (m) until = m[1];
                }
                out.push({ title: title, url: url, vol: vol, price: price, free: free, until: until, unit: 'pt' });
            }
            return out;
        },
        // The volume list shows ten rows and paginates the rest as
        // /title/<id>/pv/<n>, so page one alone under-reports both the series
        // size and the free count.
        listPages: (doc, html, url) => {
            const out = [];
            let base = null;
            try { base = new URL(url); } catch (e) { return out; }
            const m = /^\/title\/(\d+)\/pv(?:\/\d+)?\/?$/.exec(base.pathname);
            if (!m) return out;
            const page = new RegExp('^/title/' + m[1] + '/pv/\\d+/?$');
            const seen = Object.create(null);
            seen[base.origin + base.pathname] = true;
            for (const a of doc.querySelectorAll('a[href*="/pv/"]')) {
                let u = null;
                try { u = new URL(a.getAttribute('href') || '', base); } catch (e) { continue; }
                if (u.hostname !== base.hostname || !page.test(u.pathname)) continue;
                const s = u.origin + u.pathname;
                if (seen[s]) continue;
                seen[s] = true;
                out.push(s);
            }
            return out;
        },
    });
