    // Cross-store availability: the BookWalker adapter for the "also available
    // on" card. It lives in the store's own directory but is tagged module
    // `feature/availability`, because only the combined build includes that
    // module; the single-store artifacts carry none of it. The core owns the
    // scoring, the merge and the card, and this file owns only what is true of
    // BookWalker: where it searches and how it reads a volume row.

    registerAvailabilityStore({
        id: 'bookwalker', siteId: 'bookwalker', label: 'BookWalker', short: 'B',
        color: '#0f7dc4', origin: 'https://bookwalker.jp', hosts: ['bookwalker.jp'],
        search: (q) => 'https://bookwalker.jp/search/?word=' + encodeURIComponent(q),
        // /series/<id>/ lists every volume, so prefer it over a /de<uuid> page.
        product: (p) => /^\/series\/\d+\//.test(p) || /^\/de[0-9a-f-]{6,}\/?$/i.test(p),
        rank: (p) => (/^\/series\//.test(p) ? 0.5 : 0),
        // One card per edition, each with its own price; a 0-yen card is
        // the free 無料お試し版 and also says 無料で読む. Volumes 8 and 6 each
        // exist as 通常版 and 特装版, so a volume can have several rows.
        volumes: (doc) => {
            const out = [];
            for (const a of doc.querySelectorAll('a.m-book-item__title')) {
                const title = (a.getAttribute('title') || a.textContent || '').trim();
                let url = '';
                try { url = new URL(a.getAttribute('href') || '', 'https://bookwalker.jp/').href; } catch (e) { continue; }
                let num = null, free = false, row = a;
                for (let i = 0; i < 6 && row; i++, row = row.parentElement) {
                    const el = row.querySelector('.m-book-item__price-num');
                    if (!el) continue;
                    const n = parseInt(String(el.textContent).replace(/[^0-9]/g, ''), 10);
                    num = isFinite(n) ? n : null;
                    free = /無料で読む/.test(row.textContent || '') || num === 0;
                    break;
                }
                out.push({ title: title, url: url, vol: extractVolumeNumber(title), price: num, free: free, until: '' });
            }
            return out;
        },
    });
