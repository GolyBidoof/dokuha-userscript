    // Asks each store's own search page whether it carries the book and links
    // to that store's product page, never to a viewer. The stores are external
    // facts rather than adapter concerns, so each declares its own adapter in its
    // own directory and registers it here. This module is in the combined target
    // ("dokuha-userscript") only, so the single-store scripts carry neither these
    // hosts nor the card.
    //
    // The core owns everything the shops share: the fuzzy title match scored in
    // tiers (exact > prefix > contains), the per-series merge that turns a set of
    // volume rows into "which shops carry this series, at what price", the
    // honesty about a confirmed match versus a search fallback, the card markup
    // and its sizing. A store adapter supplies only what is true of that store:
    // its search URL, its product-page shape, and how it reads a volume row.
    //
    // An adapter may declare:
    //   id/siteId                the registry key and the adapter it belongs to
    //   label/pill/short/color   how the pill is named and coloured
    //   origin/hosts             where its links are allowed to point
    //   search(q)                the search URL to fetch
    //   product(path)            whether a path is a product page
    //   rank(path)               a small bonus for the better page shape
    //   exactPage()              a page URL the viewer already gave us (CMOA)
    //   freeBadge(cardHtml)      a campaign count read from the matched card
    //   fromSearch               the results page is already per volume (Amazon)
    //   seriesOf(cardHtml)       the series a result card belongs to
    //   volumes(doc, html)       the per-volume rows: price, free state, unit
    //   pagePrice(doc, html)     a page-level price when no volume row is readable
    //   listPages(doc, html, url) further pages to follow for the whole list
    //
    // A `volumes` row may set `unit` when its amount is not yen, and the pill then
    // prints that unit instead of a yen sign.
    // The store catalog is assembled by the stores themselves. Each store's own
    // adapter (a file in its directory, tagged module `feature/availability`)
    // calls registerAvailabilityStore() as the combined build loads, so adding a
    // sixth source is one adapter object beside that store rather than an edit
    // deep inside this shared file. The core owns the cross-store work below and
    // never names a shop.
    const AVAILABILITY_STORES = [];
    function registerAvailabilityStore(store) {
        if (!store || !store.id) throw new Error('availability store needs an id');
        AVAILABILITY_STORES.push(store);
    }

    // One lookup per title per page: the panel re-renders, the answers do not.
    const availabilityMemory = new Map();
    // One shared in-flight promise per key: the boot poll often asks again while
    // the first round-trip is still running, and the same three stores must not
    // be queried twice.
    const availabilityInflight = new Map();
    const AVAILABILITY_CACHE_MAX = 50;

    // A viewer's document title often carries the shop's own branding
    // ("... | BOOK☆WALKER"); searching for that finds nothing.
    function cleanStoreSeed(t) {
        let s = String(t || '');
        s = s.replace(/[\s|｜\-\u2013\u2014]*(?:BOOK\s*[☆★]?\s*WALKER|ブックウォーカー|ebookjapan|イーブックジャパン|コミックシーモア|CMOA|シーモア)\s*$/i, '');
        s = s.replace(/[\s|｜\-\u2013\u2014]+$/, '');
        return s.trim();
    }

    function availabilityNorm(s) {
        return String(s || '')
            // Full-width ASCII has to fold to its half-width form first: the same
            // title is spelled １２３サンプル… on BookWalker and Amazon but 123サンプル…
            // on k-manga, and without the fold the two never compare equal, so
            // every card from those stores scored as a miss.
            .replace(/[\uff01-\uff5e]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
            .replace(/[\s\u3000]+/g, '')
            .replace(/[（）()【】\[\]「」『』]/g, '')
            .toLowerCase();
    }

    // Whether a row's title continues the matched title at a volume boundary
    // ("サンプル賭博作品 1巻" follows "サンプル賭博作品"; "サンプル賭博作品双 2巻" is another series).
    function titleFollows(rowTitle, base) {
        const t = availabilityNorm(rowTitle);
        if (!base || !t.startsWith(base)) return false;
        const rest = t.slice(base.length);
        return rest === '' || /^[0-9巻]/.test(rest);
    }

    function availabilityScore(anchorText, candidates, bonus) {
        const t = availabilityNorm(anchorText);
        if (!t) return null;
        let tier = 0;
        for (const cand of candidates) {
            const n = availabilityNorm(cand);
            if (n.length < 3) continue;
            if (t === n) tier = Math.max(tier, 3);
            else if (t.startsWith(n)) tier = Math.max(tier, 2);
            // A bare "contains" is the only signal ebookjapan offers, so it
            // counts - but only for a title long enough that a stray mention of
            // it in another book's card is unlikely.
            else if (n.length >= 4 && t.includes(n)) tier = Math.max(tier, 1);
        }
        if (!tier) return null;
        return { score: tier + (bonus || 0), len: t.length };
    }

    function hostMatches(hostname, hosts) {
        const h = String(hostname || '').toLowerCase();
        return hosts.some(want => h === want || h.endsWith('.' + want));
    }

    function bestStoreMatch(html, store, candidates) {
        let doc = null;
        try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return null; }
        if (!doc) return null;
        let best = null;
        for (const a of doc.querySelectorAll('a[href]')) {
            let url = null;
            try {
                const u = new URL(a.getAttribute('href') || '', store.origin + '/');
                if (!hostMatches(u.hostname, store.hosts)) continue;
                if (!store.product(u.pathname)) continue;
                url = u.origin + u.pathname;
            } catch (e) { continue; }
            const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
            // A result card carries the title, the author, campaign badges and
            // review counts in one anchor. Scoring that whole string lets a
            // spin-off ("サンプル賭博作品愛") beat the series itself ("サンプル賭博作品"), because
            // the series card is longer once its badges are counted. When the
            // card marks its title, score that instead.
            const titleEl = a.querySelector('.title-content__title, .m-book-item__title, h2, h3, h4');
            const titleText = titleEl
                ? ((titleEl.getAttribute('title') || titleEl.textContent || '').replace(/\s+/g, ' ').trim())
                : '';
            const s = availabilityScore(titleText || text, candidates, store.rank(new URL(url).pathname));
            if (!s) continue;
            if (!best || s.score > best.score || (s.score === best.score && s.len < best.len)) {
                // The card, not just the anchor: a campaign badge or Amazon's
                // "全22巻中第1巻" line sits beside the anchor, not inside it.
                const cardEl = a.closest('[data-component-type="s-search-result"][data-asin]') || a;
                best = { score: s.score, len: s.len, url: url, text: text, card: cardEl.outerHTML || '' };
            }
        }
        return best;
    }

    // Price and free-volume detail for the book the user is actually reading,
    // read from the page the shop publishes it on. Which page that is differs
    // per shop: the one the search matched, the search results themselves
    // (Amazon), or a further page the first one points at (CMOA's pager,
    // ebookjapan's per-volume page).
    function blankDetail() {
        return { freeCount: 0, volTotal: 0, freeMine: false, price: null, priceUnit: '', until: '',
            ku: false, kuCount: 0, kuSeen: 0, volFound: false, rows: 0, matchUrl: '' };
    }

    async function storeDetail(store, url, cardHtml, searchHtml, volNum, bookTitle, matchText) {
        const d = blankDetail();
        // Scoped to the matched result card, never the whole results page: a
        // "N冊無料" badge belongs to one title's card, and the other cards on the
        // page carry their own badges, often larger ones.
        if (typeof store.freeBadge === 'function' && cardHtml) {
            try { d.freeCount = store.freeBadge(cardHtml) || 0; } catch (e) {}
        }
        if (typeof store.volumes !== 'function') return d;

        const parse = (html) => {
            try { return new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return null; }
        };
        // One retry: a single failed page fetch used to be invisible, and the
        // series size was then reported from the rows of page one alone (a live
        // CMOA run showed "10 volumes" for a 16-volume series that way).
        const readPage = async (pageUrl) => {
            for (let attempt = 0; attempt < 2; attempt++) {
                let page = null;
                try { page = await gmFetch(pageUrl, 15000); } catch (e) { page = null; }
                if (page && page.status === 200 && page.text) {
                    const doc = parse(page.text);
                    if (doc) return { url: pageUrl, html: page.text, doc: doc };
                }
            }
            return null;
        };
        const rowsOf = (page) => {
            try { return store.volumes(page.doc, page.html) || []; } catch (e) { return []; }
        };

        let first = null;
        if (store.fromSearch && searchHtml) first = { url: url, html: searchHtml, doc: parse(searchHtml) };
        else if (url) first = await readPage(url);
        if (!first) return d;

        let items = rowsOf(first);
        // Some shops paginate the volume list (CMOA: ten rows a page) or publish
        // the whole run only on a per-volume page (ebookjapan). Following those
        // pages is what stops the series size and the free count from being
        // undercounted: "8 vols free" used to mean "8 rows on page one".
        if (typeof store.listPages === 'function') {
            let more = [];
            try { more = store.listPages(first.doc, first.html, first.url) || []; } catch (e) { more = []; }
            const followed = Object.create(null);
            followed[first.url] = true;
            for (const pageUrl of more.slice(0, 8)) {
                if (!pageUrl || followed[pageUrl]) continue;
                followed[pageUrl] = true;
                const page = await readPage(pageUrl);
                if (page) items = items.concat(rowsOf(page));
            }
        }
        d.rows = items.length;
        if (!items.length) {
            // The volume rows are the store's per-volume answer, but a page that
            // states its price outside them (or whose list never rendered) is
            // still a priced page. An empty pill claims nothing; the page's own
            // amount is the honest fallback when a shop can read one.
            if (typeof store.pagePrice === 'function') {
                try {
                    const p = store.pagePrice(first.doc, first.html);
                    if (isFinite(p) && p > 0) d.price = p;
                } catch (e) {}
            }
            return d;
        }

        // Match the row this book actually is. A numbered volume matches on its
        // number; a book with no number (a one-shot, or an unnumbered first
        // volume) can only be matched on its exact title.
        const want = Number(volNum);
        const wantTitle = availabilityNorm(bookTitle || '');
        // A result set can hold several series at once, so a row also has to
        // belong to the series the matched card is from when the shop says
        // which that is.
        let wantSeries = null;
        if (typeof store.seriesOf === 'function' && cardHtml) {
            try { wantSeries = store.seriesOf(cardHtml); } catch (e) { wantSeries = null; }
        }
        // The matched card is sometimes the series link itself, which states no
        // volume, so the series is read back off the volume rows instead.
        if (!(wantSeries > 0) && matchText) {
            const base = availabilityNorm(matchText);
            const from = items.filter(it => isFinite(it.vol) && it.vol === want &&
                isFinite(it.series) && titleFollows(it.title, base));
            if (from.length) wantSeries = from[0].series;
        }
        const sameSeries = (it) => !(wantSeries > 0) || !isFinite(it.series) || it.series === wantSeries;
        let mine = [];
        if (isFinite(want) && want > 0) mine = items.filter(it => isFinite(it.vol) && it.vol === want && sameSeries(it));
        if (!mine.length && wantTitle) mine = items.filter(it => availabilityNorm(it.title) === wantTitle && sameSeries(it));

        // The series counts are read before the "not this volume" return: a shop
        // that matched the series but not the volume still contributes its
        // campaign badge.
        if (store.noSeriesCounts !== true) {
            // A result set can hold several series at once, so only the rows of
            // the matched series describe this series; the others are noise.
            const rowsFor = wantSeries > 0 ? items.filter(sameSeries) : (store.fromSearch ? [] : items);
            // How many distinct volumes can be read free. A volume with no
            // readable number still counts as one, so a free row is never
            // silently dropped.
            const freeKeys = new Set();
            for (const it of rowsFor) {
                if (it.free) freeKeys.add(isFinite(it.vol) && it.vol ? 'v' + it.vol : 't' + it.title);
            }
            d.freeCount = Math.max(d.freeCount, freeKeys.size);
            const vols = new Set();
            const kuVols = new Set();
            for (const it of rowsFor) {
                if (!isFinite(it.vol) || !it.vol) continue;
                vols.add(it.vol);
                if (it.ku) kuVols.add(it.vol);
            }
            // A shop that states the series size on every card states it for the
            // whole run, which is more than the rows of one results page cover.
            d.volTotal = wantSeries > 0 ? wantSeries : vols.size;
            d.kuCount = kuVols.size;
            d.kuSeen = vols.size;
        }

        if (!mine.length) return d;
        d.volFound = true;
        // A store whose result set is already per volume named this volume's own
        // page, which is a better link than whichever card the query matched.
        if (store.fromSearch && mine[0].url) d.matchUrl = mine[0].url;

        // A shop that does not state the charge in its results keeps it on the
        // volume's own page, so that one page is read for this volume only.
        if (mine[0].page && mine[0].url) {
            const own = await readPage(mine[0].url);
            if (own) {
                const rows = rowsOf(own);
                if (rows.length) mine = [rows[0]];
            }
        }

        // Kept apart from `free`: Kindle Unlimited is a subscription, so a KU
        // volume is readable at no extra cost but is not free to keep.
        d.ku = mine.some(it => it.ku === true);


        const freeOne = mine.find(it => it.free);
        if (freeOne) {
            d.freeMine = true;
            d.until = freeOne.until || '';
            return d;
        }
        // The cheapest readable amount wins, and it carries its own unit: a
        // store may state points where another states yen.
        const priced = mine.filter(it => isFinite(it.price) && it.price > 0);
        if (priced.length) {
            let best = priced[0];
            for (const it of priced) if (it.price < best.price) best = it;
            d.price = best.price;
            d.priceUnit = best.unit || '';
        }
        return d;
    }

    // Walk the title candidates until one search page yields a match, so a
    // decorated title ("... 1巻 (サンプルコミックス)") still lands.
    async function checkStoreAvailability(store, candidates, volNum, bookTitle) {
        for (const cand of candidates) {
            if (!cand) continue;
            let res = null;
            try { res = await gmFetch(store.search(cand), 15000); }
            catch (e) {
                // Every transport failed; do not hammer. Say so, because an
                // unreachable shop and an absent book look identical otherwise.
                if (BWDD_DEBUG) { try { console.info('[bwdd] availability: ' + store.id + ' fetch failed: ' + ((e && e.message) || e)); } catch (_) {} }
                return null;
            }
            if (!res || res.status !== 200 || !res.text) {
                if (BWDD_DEBUG) { try { console.info('[bwdd] availability: ' + store.id + ' HTTP ' + (res && res.status)); } catch (_) {} }
                continue;
            }
            const hit = bestStoreMatch(res.text, store, candidates);
            if (hit) {
                const detail = await storeDetail(store, hit.url, hit.card, res.text, volNum, bookTitle, hit.text);
                if (detail.matchUrl) hit.url = detail.matchUrl;
                return Object.assign({}, hit, detail);
            }
        }
        return null;
    }


    // "free" when this volume is free; otherwise the price for this volume,
    // alongside how many volumes in the series are free.
    // The series size is stated next to the free count whenever both are known,
    // because "8 vols free" on its own reads as "the series has eight volumes".
    // The pill is about 111px wide, so the ratio is kept to "8/16 free"; the
    // tooltip spells the same fact out in full.
    function freeVolumeText(n, total) {
        if (isFinite(total) && total > 1) return n + '/' + total + ' free';
        return n + (n === 1 ? ' vol free' : ' vols free');
    }

    // Whether the series free-count adds anything to this volume's own state.
    // It does as soon as the series is bigger than this single volume, which is
    // what makes "free · 1/9 free" worth saying instead of a bare "free".
    function seriesCountAddsNothing(r) {
        return r.freeMine && r.freeCount <= 1 && !(r.volTotal > 1);
    }

    // A store may price in something other than yen and says so on its rows
    // (k-manga prices in points), so the row's unit travels with the amount and
    // the same number renders as "718pt" there and as "¥810" everywhere else.
    function priceLabel(amount, unit) {
        return unit ? amount.toLocaleString('en-US') + unit : '\u00a5' + amount.toLocaleString('en-US');
    }

    function storeMetaText(r) {
        const bits = [];
        if (r.freeMine) bits.push('free');
        else if (isFinite(r.price) && r.price > 0) bits.push(priceLabel(r.price, r.priceUnit));
        // Subscription access is neither "free" nor a price, so it gets its own
        // token beside whichever of the two applies.
        if (r.ku && !r.freeMine) bits.unshift('KU');
        // Amazon states the series size on every card but only ever shows part of
        // the run, so the count of KU volumes is claimed only once the whole run
        // has actually been seen; otherwise just the size is stated.
        if (r.ku && r.volTotal > 1) {
            if (r.kuSeen >= r.volTotal) bits.push(r.kuCount + '/' + r.volTotal + ' on KU');
            else bits.push(r.volTotal + ' vols');
        }
        // A known series size is worth stating even with no subscription and no
        // free volume, because "¥792 · 16 vols" is the answer to "how long is this
        // run". Where a free count is known it carries the total itself, and this
        // would only repeat it.
        if (!r.ku && r.volTotal > 1 && !(r.freeCount > 0)) bits.push(r.volTotal + ' vols');
        // The series count is a separate fact from this volume's own state, so it
        // is reported either way; it is only dropped when it would just repeat
        // "free" for a single free volume.
        if (r.freeCount > 0 && !seriesCountAddsNothing(r)) {
            bits.push(freeVolumeText(r.freeCount, r.volTotal));
        }
        return bits.join(' \u00b7 ');
    }

    function storeTipFacts(r, store) {
        const facts = [];
        if (r.freeMine) facts.push('this volume is free' + (r.until ? ' (' + r.until + ')' : ''));
        else if (isFinite(r.price) && r.price > 0) facts.push('this volume is ' + priceLabel(r.price, r.priceUnit));
        if (r.ku && !r.freeMine) facts.push('included with Kindle Unlimited, which is a subscription');
        if (r.ku && r.volTotal > 1) {
            if (r.kuSeen >= r.volTotal) {
                facts.push(r.kuCount === r.volTotal
                    ? 'all ' + r.volTotal + ' volumes are on Kindle Unlimited'
                    : r.kuCount + ' of ' + r.volTotal + ' volumes are on Kindle Unlimited');
            } else {
                // Deliberately scoped to what was listed: a results page is not
                // the whole series, so the count cannot speak for all of it.
                facts.push('the series has ' + r.volTotal + ' volumes, and ' + r.kuCount +
                    ' of the ' + r.kuSeen + ' listed are on Kindle Unlimited');
            }
        }
        if (r.freeCount > 0 && !seriesCountAddsNothing(r)) {
            const n = r.freeCount;
            if (typeof store.freeBadge === 'function' && !(r.volTotal > 0)) {
                // The shop's own campaign badge, used only when the volume rows
                // themselves could not be read: a counted ratio beats a badge.
                facts.push('its campaign badge offers ' + n + (n === 1 ? ' volume' : ' volumes') + ' free');
            } else if (r.volTotal > n) {
                facts.push(n + ' of ' + r.volTotal + ' volumes can be read free');
            } else if (n > 1) {
                facts.push('all ' + n + ' volumes can be read free');
            } else {
                facts.push('1 volume can be read free');
            }
        } else if (!r.ku && r.volTotal > 1) {
            facts.push('the series has ' + r.volTotal + ' volumes');
        }
        if (!facts.length && r.rows) facts.push('no price or free-volume marker for this volume');
        return facts;
    }

    // The cards column is not wide, so a pill is measured in sixths of the card
    // and pills pack into rows of at most STORE_MAX_PER_ROW. A row of k pills
    // gives each pill STORE_GRID_TRACKS / k tracks: one or two pills a row keep
    // the full size badge and padding, while a row of three is the only case
    // whose cells are a third of the card and needs the compact metrics. Rows are
    // filled as evenly as the count allows, with the leftover going to the later
    // rows, so the first line keeps the widest cells. Five shops are therefore
    // two half-width pills over three third-width ones, two lines with no name
    // ellipsized, which is the shape the card has always had.
    //
    // To restyle every count at once, change these two numbers and the compact
    // values in STORE_CSS below.
    const STORE_GRID_TRACKS = 6;
    const STORE_MAX_PER_ROW = 3;

    // The row sizes for a given number of pills, widest row first. The spans are
    // then STORE_GRID_TRACKS / size, so every row fills the grid exactly.
    function storeRowSizes(count) {
        const n = Math.max(0, Number(count) || 0);
        if (!n) return [];
        const rows = Math.ceil(n / STORE_MAX_PER_ROW);
        const base = Math.floor(n / rows);
        const extra = n % rows;
        const out = [];
        for (let i = 0; i < rows; i++) out.push(base + (i >= rows - extra ? 1 : 0));
        return out;
    }

    // The per-pill spans in render order plus whether any row is compact. One
    // function so the card, and the tests that pin it, agree on the layout.
    function storeLayout(count) {
        const rows = storeRowSizes(count);
        const spans = [];
        for (const size of rows) for (let i = 0; i < size; i++) spans.push(STORE_GRID_TRACKS / size);
        return { rows: rows, spans: spans, compact: rows.some(size => size >= 3) };
    }

    // The card's CSS travels with the feature: a build that does not include
    // this module carries neither the markup nor the styling.
    const STORE_CSS = `
/* Card sizing. The row is a ${STORE_GRID_TRACKS}-track grid and each pill spans
   STORE_GRID_TRACKS / (pills in its row) tracks, set inline by storeLayout().
   The compact values apply when a row holds three pills, the only row whose
   cells are a third of the card wide. These are the knobs for the whole card:
   change them here and every count follows. */
.bwdd-store-row { display: grid; grid-template-columns: repeat(${STORE_GRID_TRACKS}, minmax(0, 1fr)); gap: 6px; }
.bwdd-store-row.is-compact { gap: 4px; }
.bwdd-store-row.is-compact > .bwdd-store-link,
.bwdd-store-row.is-compact > .bwdd-store-pending { padding: 3px 4px; column-gap: 3px; }
.bwdd-store-row.is-compact .bwdd-store-badge { width: 12px; height: 12px; font-size: 9px; }
.bwdd-store-link, .bwdd-store-pending {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-areas: "badge name" "state state";
  align-items: center; column-gap: 5px; min-width: 0;
  border: 1px solid var(--bwdd-border);
  border-radius: 10px;
  padding: 3px 6px;
  font-size: 11px; font-weight: 600; line-height: 1.5;
  text-decoration: none; color: var(--bwdd-text);
  background: var(--bwdd-bg);
}
/* A shop whose search has not answered yet. It keeps the shop's place in the
   grid so the pill count never jumps as answers land, but it carries no price,
   no link and no claim; the state line is an empty bar while it waits. */
.bwdd-store-pending { cursor: default; }
.bwdd-store-pending .bwdd-store-name { color: var(--bwdd-text-muted); }
.bwdd-store-pending .bwdd-store-state { height: 8px; width: 70%; border-radius: 4px; background: var(--bwdd-border); }
.bwdd-store-pending { animation: bwdd-store-wait 1.2s ease-in-out infinite; }
@keyframes bwdd-store-wait { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.85; } }
@media (prefers-reduced-motion: reduce) { .bwdd-store-pending { animation: none; opacity: 0.6; } }
.bwdd-store-link:hover { border-color: var(--bwdd-store, var(--bwdd-link)); background: var(--bwdd-link-hover-bg); text-decoration: none; }
.bwdd-store-link:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 2px; }
.bwdd-store-badge {
  grid-area: badge;
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--bwdd-store, #6b7280); color: #fff;
  font-size: 10px; font-weight: 700; line-height: 1; flex: 0 0 auto;
}
.bwdd-store-name { grid-area: name; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bwdd-store-state {
  grid-area: state;
  color: var(--bwdd-text-muted); font-weight: 500;
  font-size: 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bwdd-store-link.is-free .bwdd-store-state { color: #15803d; font-weight: 700; }
/* Kindle Unlimited is readable on subscription, not free, so it is not green. */
.bwdd-store-link.is-ku .bwdd-store-state { color: #0e7490; font-weight: 700; }
`;
    let storeStylesMounted = false;
    function mountStoreStyles() {
        if (storeStylesMounted || typeof document === 'undefined') return;
        storeStylesMounted = true;
        try {
            const style = document.createElement('style');
            style.textContent = STORE_CSS;
            (document.head || document.documentElement).appendChild(style);
        } catch (e) {}
    }

    // A test hook, live only under ?bwddDebug: whether every shop's answer has
    // landed. The card is painted as each answer arrives now, so "the card
    // exists" no longer means "every shop has answered".
    function markStoresSettled(statsEl, done) {
        if (!BWDD_DEBUG || !statsEl) return;
        try { statsEl.setAttribute('data-stores-done', done ? '1' : '0'); } catch (e) {}
    }

    // `pending` are the shops still being asked. As soon as one shop confirms the
    // book the card appears with that pill and a placeholder for every shop whose
    // answer is still in flight, so the wait is visible instead of a card that
    // stays empty until the slowest search returns. Each placeholder is replaced
    // when its shop answers, and a shop that turns out not to carry the book
    // simply loses it.
    function renderStoresCard(statsEl, results, pending) {
        if (!statsEl) return null;
        const shown = (results || []).filter(r => r.available);
        const waiting = pending || [];
        // Nothing is claimed before the first shop confirms it: a card made only
        // of placeholders would announce a search that has not answered yet.
        if (!shown.length) return upsertCard(statsEl, 'stores', () => null);
        mountStoreStyles();
        return upsertCard(statsEl, 'stores', () => {
            const card = emptyCard('Also available on');
            const byId = new Map(shown.map(r => [r.store.id, r]));
            const waitingIds = new Set(waiting.map(s => s.id));
            // Catalog order, so a shop keeps its place while its own answer is in
            // flight and the two long names keep the wide cells even before every
            // answer has arrived.
            const slots = AVAILABILITY_STORES.filter(s => byId.has(s.id) || waitingIds.has(s.id));
            // The layout comes from how many pills are present, never from a
            // per-count rule: see the sizing block above for the one place that
            // decides the card's shape.
            const layout = storeLayout(slots.length);
            const row = el('div', 'bwdd-store-row' + (layout.compact ? ' is-compact' : ''));
            const activeId = (ACTIVE_SITE && ACTIVE_SITE.id) || '';
            slots.forEach((store, index) => {
                const span = 'span ' + (layout.spans[index] || STORE_GRID_TRACKS);
                const r = byId.get(store.id);
                if (!r) {
                    const ph = el('div', 'bwdd-store-pending');
                    ph.style.gridColumn = span;
                    ph.style.setProperty('--bwdd-store', store.color);
                    ph.setAttribute('aria-busy', 'true');
                    ph.title = 'Checking ' + store.label + '\u2026';
                    const badge = el('span', 'bwdd-store-badge', store.short);
                    badge.setAttribute('aria-hidden', 'true');
                    ph.append(badge, el('span', 'bwdd-store-name', store.pill || store.label),
                        el('span', 'bwdd-store-state'));
                    row.appendChild(ph);
                    return;
                }
                const here = store.siteId && store.siteId === activeId;
                const meta = storeMetaText(r);
                const a = el('a', 'bwdd-store-link is-found' +
                    ((r.freeMine || r.freeCount > 0) ? ' is-free' : '') +
                    ((r.ku && !r.freeMine) ? ' is-ku' : ''));
                a.href = r.url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.style.gridColumn = span;
                a.style.setProperty('--bwdd-store', store.color);
                let tip = (r.why === 'exact')
                    ? store.label + ' \u2014 the store page for this book'
                    : 'On ' + store.label + ' \u2014 open its page for this book';
                const facts = storeTipFacts(r, store);
                if (facts.length) tip += ' \u2014 ' + facts.join('; ');
                if (here) tip += ' (the store you are reading on)';
                a.title = tip;
                a.setAttribute('aria-label', tip);
                const badge = el('span', 'bwdd-store-badge', store.short);
                badge.setAttribute('aria-hidden', 'true');
                a.append(badge, el('span', 'bwdd-store-name', store.pill || store.label));
                // No "available" filler: an empty state is left empty.
                if (meta) a.appendChild(el('span', 'bwdd-store-state', meta));
                row.appendChild(a);
            });
            card.appendChild(row);
            return card;
        });
    }

    async function lookupAvailability(statsEl, seriesTitle, bookTitle, volNum) {
        const raw = String(seriesTitle || bookTitle || '').trim();
        const seed = cleanStoreSeed(raw) || raw;
        if (!seed || !statsEl) return null;
        const cacheKey = seed + '|' + (volNum == null ? '' : volNum);
        const cached = availabilityMemory.get(cacheKey);
        if (cached) { markStoresSettled(statsEl, true); renderStoresCard(statsEl, cached); return cached; }
        const candidates = [];
        for (const base of [seed, raw]) {
            if (!base) continue;
            for (const c of searchTitleCandidates(base)) {
                if (c && candidates.indexOf(c) === -1) candidates.push(c);
            }
        }
        let entry = availabilityInflight.get(cacheKey);
        if (!entry) {
            // Every answer is recorded as it lands and the card is repainted from
            // whatever is known so far, so the first shop to carry the book shows
            // at once and the rest fill in around it.
            const settled = new Array(AVAILABILITY_STORES.length).fill(null);
            const state = { el: statsEl };
            const paint = () => {
                const known = settled.filter(Boolean);
                const pending = AVAILABILITY_STORES.filter((s, i) => settled[i] === null);
                try { renderStoresCard(state.el, known, pending); } catch (e) {}
            };
            const tasks = AVAILABILITY_STORES.map(async (store, i) => {
                const base = Object.assign(blankDetail(), { store: store });
                let result = null;
                let exact = null;
                if (typeof store.exactPage === 'function') {
                    try { exact = store.exactPage(); } catch (e) { exact = null; }
                }
                if (exact) {
                    // The viewer told us the store page outright, so go straight to
                    // it for the price and free-volume rows.
                    const d = await storeDetail(store, exact, '', '', volNum, bookTitle);
                    result = Object.assign(base, d, { available: true, url: exact, why: 'exact' });
                } else {
                    try {
                        const hit = await checkStoreAvailability(store, candidates, volNum, bookTitle);
                        if (hit) result = Object.assign(base, hit, { available: true, url: hit.url, why: 'match' });
                    } catch (e) { /* fall through to the search link */ }
                    if (!result) {
                        base.available = false;
                        base.why = 'search';
                        base.url = store.search(candidates[0] || seed);
                        result = base;
                    }
                }
                settled[i] = result;
                paint();
                return result;
            });
            entry = { work: Promise.all(tasks), state: state };
            availabilityInflight.set(cacheKey, entry);
            markStoresSettled(statsEl, false);
        } else {
            // A later caller can hold a freshly mounted column, and the next
            // incremental paint should land in the one that is on screen now.
            entry.state.el = statsEl;
        }
        let results;
        try { results = await entry.work; }
        finally { if (availabilityInflight.get(cacheKey) === entry) availabilityInflight.delete(cacheKey); }
        availabilityMemory.set(cacheKey, results);
        // Session-lifetime cache, one entry per series|volume: drop the oldest
        // rather than letting a long browsing session grow it without bound.
        while (availabilityMemory.size > AVAILABILITY_CACHE_MAX) {
            availabilityMemory.delete(availabilityMemory.keys().next().value);
        }
        if (BWDD_DEBUG) {
            try {
                console.info('[bwdd] availability seed="' + seed + '" vol=' + (volNum == null ? '?' : volNum) +
                    ' -> ' + results.map(r => r.store.id + ':' + (r.available ? 'found' : 'not-carried')).join(' '));
            } catch (e) {}
        }
        markStoresSettled(statsEl, true);
        renderStoresCard(statsEl, results);
        return results;
    }

    // A test hook, live only under ?bwddDebug. It exposes the registry and the
    // layout so a test can lay out a synthetic source without adding a real
    // store, and the card renderer so that source can be drawn and measured.
    if (BWDD_DEBUG) {
        try {
            debugRealm().__bwddAvailability = {
                stores: AVAILABILITY_STORES,
                register: registerAvailabilityStore,
                layout: storeLayout,
                render: renderStoresCard,
            };
        } catch (e) {}
    }
