    // Cross-store availability: the CMOA adapter for the "also available on"
    // card, module `feature/availability`, so only the combined build pulls it
    // in. CMOA's title page paginates its volume list ten rows at a time and a
    // free volume keeps its regular price on the row, so the adapter reads the
    // pager and the 無料で読む block rather than the amount.

    registerAvailabilityStore({
        id: 'cmoa', siteId: 'cmoa', label: 'CMOA', short: 'C',
        color: '#e2574c', origin: 'https://www.cmoa.jp', hosts: ['cmoa.jp'],
        // The results page reads `header_word`; `search_word` is still accepted
        // but no longer filters, and silently returns the whole catalogue, so
        // every query looked like "no match".
        search: (q) => 'https://www.cmoa.jp/search/result/?header_word=' + encodeURIComponent(q),
        product: (p) => /^\/title\/\d+\/?/.test(p),
        rank: () => 0,
        // CMOA's speed-reader URL carries the store page it was opened from as
        // rurl, which is an exact answer for free: no search and no guessing.
        // rurl can name the volume page (/title/<id>/vol/<n>/) the reader was
        // opened from, so the series path is what gets returned: the whole run
        // and its pager live on /title/<id>/, and reading the volume page alone
        // gave one page of rows with no pager to follow, which under-reported
        // both the series size and the free count.
        exactPage() {
            try {
                const rurl = new URLSearchParams(location.search).get('rurl');
                if (!rurl) return null;
                const u = new URL(rurl);
                if (!hostMatches(u.hostname, this.hosts)) return null;
                if (!this.product(u.pathname)) return null;
                const title = /^\/title\/(\d+)/.exec(u.pathname);
                if (!title) return null;
                return u.origin + '/title/' + title[1] + '/';
            } catch (e) { return null; }
        },
        // The same series list has two layouts. The detailed one renders
        // .title_vol_vox_vols_i rows and states the amount in yen beside the
        // points. The store's "簡単" (easy) layout, which the same URL serves to
        // a session that has it switched on, renders 20 .title_vol_easy_box_in_th
        // rows a page and states points only; every easy row also carries the
        // 無料立読み button, so free there is the "今だけ無料で読める！" caption
        // and never that button. Reading only the detailed rows is what left the
        // pill empty for a session whose page came back in the easy layout.
        volumes: (doc) => {
            const out = [];
            for (const row of doc.querySelectorAll('.title_vol_vox_vols_i')) {
                const a = row.querySelector('h3.title_details_title_name_h2 a') || row.querySelector('a[href*="/title/"]');
                const img = row.querySelector('img[alt]');
                const title = ((a && a.textContent) || (img && img.getAttribute('alt')) || '').trim();
                let url = '';
                if (a) { try { url = new URL(a.getAttribute('href') || '', 'https://www.cmoa.jp/').href; } catch (e) {} }
                // GA_free alone is NOT a free marker: every volume row also
                // carries an empty <div class="title_vol_each_free_btn GA_free">
                // placeholder, so matching the class marks the whole series free.
                // A free volume is one whose free button says something, or
                // whose row shows a 0 price.
                let freeEl = null;
                for (const el of row.querySelectorAll('.GA_free')) {
                    if ((el.textContent || '').trim()) { freeEl = el; break; }
                }
                const markEl = row.querySelector('.mark .em');
                const zeroMarked = !!markEl && (markEl.textContent || '').replace(/[^0-9]/g, '') === '0';
                let until = '';
                if (freeEl) {
                    for (const sp of freeEl.querySelectorAll('span')) {
                        const t = (sp.textContent || '').trim();
                        if (/まで/.test(t)) until = t;
                    }
                }
                let price = null;
                // The amount normally sits in .price .point, but the wrapper is
                // not part of the contract the page states: a page with no free
                // markers was seen without it, so any .point on the row is read.
                const point = row.querySelector('.price .point') || row.querySelector('.point');
                if (point) {
                    const m = /([0-9][0-9,]*)円/.exec(point.textContent || '');
                    if (m) price = parseInt(m[1].replace(/,/g, ''), 10);
                }
                let vol = NaN;
                const vm = /\/vol\/([0-9]+)\//.exec(url);
                if (vm) vol = parseInt(vm[1], 10);
                if (!isFinite(vol) || !vol) vol = extractVolumeNumber(title);
                out.push({ title: title, url: url, vol: vol, price: price, free: !!(freeEl || zeroMarked), until: until });
            }
            if (out.length) return out;
            for (const row of doc.querySelectorAll('.title_vol_easy_box_in_th')) {
                const a = row.querySelector('.title_check_box h3 a') || row.querySelector('.thum_box3 a[href*="/title/"]');
                const img = row.querySelector('img[alt]');
                const title = ((a && a.textContent) || (img && img.getAttribute('alt')) || '').trim();
                let url = '';
                if (a) { try { url = new URL(a.getAttribute('href') || '', 'https://www.cmoa.jp/').href; } catch (e) {} }
                // The 無料立読み button is on every easy row, free or not, so the
                // caption is the only per-volume free marker this layout states.
                const cam = row.querySelector('.book_last_cam');
                const free = !!cam && /無料/.test(cam.textContent || '');
                let until = '';
                if (free) {
                    const m = /([0-9]{1,2}\/[0-9]{1,2})\s*まで/.exec(cam.textContent || '');
                    if (m) until = m[1];
                }
                // Easy rows state points, never yen, so the amount travels with
                // its own unit rather than being printed as a yen figure.
                let price = null, unit = '';
                const val = row.querySelector('.book_cam_value');
                if (val) {
                    const m = /([0-9][0-9,]*)\s*pt/.exec(val.textContent || '');
                    if (m) { price = parseInt(m[1].replace(/,/g, ''), 10); unit = 'pt'; }
                }
                let vol = NaN;
                const vm = /\/vol\/([0-9]+)\//.exec(url);
                if (vm) vol = parseInt(vm[1], 10);
                if (!isFinite(vol) || !vol) vol = extractVolumeNumber(title);
                out.push({ title: title, url: url, vol: vol, price: price, free: free, until: until, unit: unit });
            }
            return out;
        },
        // When the volume list itself could not be read (a layout without
        // .title_vol_vox_vols_i rows, or a page caught before the list rendered)
        // the featured volume's price still sits in the page's own .point block.
        // A price with no series size beats an empty pill, and it is never
        // guessed from anything but a yen amount the page states.
        pagePrice: (doc) => {
            for (const el of doc.querySelectorAll('.price .point, .point')) {
                const m = /([0-9][0-9,]*)円/.exec(el.textContent || '');
                if (m) return parseInt(m[1].replace(/,/g, ''), 10);
            }
            return null;
        },
        // The title page renders ten volumes and paginates the rest, so the
        // first page alone under-reports the series size (it showed 10 of 16 for
        // サンプル転生作品). Page one is linked several ways
        // ("?order=down", "?disp_mode=easy") and one of those renders no volume
        // rows at all, while none of them adds a volume the plain first page does
        // not already list. Only a page beyond the first is therefore followed,
        // so a series costs one extra request per page instead of three and a
        // rate-limited store is not tripped by the redundant ones.
        listPages: (doc, html, url) => {
            const out = [];
            let base = null;
            try { base = new URL(url); } catch (e) { return out; }
            // The rows can have been read from the series page or from a volume
            // page (/title/<id>/vol/<n>/); both share the series pager, so the
            // pager is matched against the series path and rebuilt on it.
            const series = /^\/title\/(\d+)(?:\/|$)/.exec(base.pathname);
            if (!series) return out;
            const seriesPath = '/title/' + series[1] + '/';
            const seen = Object.create(null);
            for (const a of doc.querySelectorAll('a[href*="page="]')) {
                let u = null;
                try { u = new URL(a.getAttribute('href') || '', base); } catch (e) { continue; }
                if (u.hostname !== base.hostname) continue;
                const paged = /^\/title\/(\d+)\/?$/.exec(u.pathname);
                if (!paged || paged[1] !== series[1]) continue;
                const pager = parseInt(u.searchParams.get('page') || '', 10);
                if (!(pager > 1)) continue;
                u.hash = '';
                const s = u.origin + seriesPath + u.search;
                if (s === url || seen[s]) continue;
                seen[s] = true;
                out.push(s);
            }
            return out;
        },
    });
