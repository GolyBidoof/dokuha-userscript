'use strict';
/*
 * ebookjapan discovery, kept separate because it is the one store whose listing
 * is a serialised payload rather than plain HTML.
 *
 * `https://ebookjapan.yahoo.co.jp/free/` is server-rendered and embeds a Nuxt
 * `__NUXT_DATA__` document: a devalue *flat* array, where every structured value
 * lives at an index and refers to its children by number. Resolving it needs a
 * cycle-tolerant resolver (`devalue`), which is why this is its own file.
 *
 * The fields that matter, all verified against the live payload:
 *   firstPublication.goods.isFree               genuinely free
 *   firstPublication.goods.isBrowserSpecialFree free-to-read-in-browser promo
 *   firstPublication.goods.saleEndDatetime      the 無料期限 expiry
 *   firstPublication.goods.bookCd               the code the viewer takes
 *   firstPublication.publicationCd              the detail-page code
 *
 * Pick the furthest-out expiry so a run does not start failing next week, then
 * confirm the choice against the viewer's own publication API before trusting it.
 */

function devalue(flat) {
    const seen = new Map();
    const NEG = { '-1': undefined, '-2': undefined, '-3': NaN, '-4': Infinity, '-5': -Infinity, '-6': -0 };

    function resolve(ref) {
        if (typeof ref !== 'number') return ref;
        if (ref < 0) return NEG[String(ref)];
        if (seen.has(ref)) return seen.get(ref);
        const v = flat[ref];
        if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return v;
        if (Array.isArray(v)) {
            const tag = v[0];
            if (typeof tag === 'string') {
                if (/^(Reactive|ShallowReactive|Ref|ShallowRef|toJSON|EmptyRef|StaleRef)$/.test(tag)) return resolve(v[1]);
                if (tag === 'Date') return v[1];
                if (tag === 'BigInt') return v[1];
                if (tag === 'null') return null;
                // Set/Map/RegExp: the payload does not need their identity here.
                if (tag === 'Set' || tag === 'Map' || tag === 'RegExp') return resolve(v[1]);
            }
            const arr = [];
            seen.set(ref, arr);
            for (const e of v) arr.push(resolve(e));
            return arr;
        }
        const obj = {};
        seen.set(ref, obj);
        for (const k of Object.keys(v)) obj[k] = resolve(v[k]);
        return obj;
    }

    // Index 0 is the format descriptor; index 1 is the document root.
    return resolve(1);
}

function extractRoot(html) {
    const m = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!m) return null;
    let flat;
    try {
        flat = JSON.parse(m[1]);
    } catch (e) {
        return null;
    }
    if (!Array.isArray(flat)) return null;
    try {
        return devalue(flat);
    } catch (e) {
        return null;
    }
}

function freeCandidates(root) {
    const data = root && root.data;
    if (!data || typeof data !== 'object') return [];
    const out = [];
    for (const key of Object.keys(data)) {
        if (!/^free_/i.test(key)) continue;
        const modules = data[key];
        if (!modules || typeof modules !== 'object') continue;
        for (const modName of Object.keys(modules)) {
            const titles = modules[modName] && modules[modName].titles;
            if (!Array.isArray(titles)) continue;
            for (const t of titles) {
                const fp = t && t.firstPublication;
                const goods = fp && fp.goods;
                if (!fp || !goods || !goods.bookCd) continue;
                const free = goods.isFree === true || goods.isBrowserSpecialFree === true;
                if (!free) continue;
                out.push({
                    module: modName,
                    name: t.name || '',
                    titleId: t.titleId || null,
                    publicationCd: fp.publicationCd || null,
                    bookCd: goods.bookCd,
                    expiry: goods.saleEndDatetime || null,
                    detailUrl: t.titleId && fp.publicationCd
                        ? `https://ebookjapan.yahoo.co.jp/books/${t.titleId}/${fp.publicationCd}/`
                        : null,
                    viewerUrl: `https://ebookjapan.yahoo.co.jp/viewer/book/${goods.bookCd}`,
                });
            }
        }
    }
    const when = (s) => (s ? Date.parse(String(s).replace(/\//g, '-')) || 0 : 0);
    return out.sort((a, b) => when(b.expiry) - when(a.expiry));
}

module.exports = { devalue, extractRoot, freeCandidates, discoverEbookjapan };

/**
 * Discovery entry point, injected with the shared fetchText/DiscoveryError so
 * this file stays free of a second HTTP helper.
 */
async function discoverEbookjapan(fetchText, DiscoveryError, opts = {}) {
    const listing = await fetchText('https://ebookjapan.yahoo.co.jp/free/');
    if (listing.status !== 200) throw new DiscoveryError(`ebookjapan /free/ returned ${listing.status}`);
    const root = extractRoot(listing.text);
    if (!root) throw new DiscoveryError('ebookjapan /free/ carried no decodable __NUXT_DATA__ payload');
    const candidates = freeCandidates(root);
    if (!candidates.length) throw new DiscoveryError('ebookjapan /free/ payload listed no free volume with an expiry');

    const attempts = [];
    for (const c of candidates.slice(0, opts.tries || 5)) {
        // The viewer's own metadata API is the liveness check: an expired promo
        // still appears in the listing page until it is rebuilt.
        try {
            const res = await fetch('https://ebookjapan.yahoo.co.jp/proxy/apis/viewer/publication?bookCd=' + c.bookCd, {
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
            });
            if (!res.ok) { attempts.push({ bookCd: c.bookCd, status: res.status }); continue; }
            const json = await res.json();
            const goods = json.goods || {};
            const free = goods.isFree === true || goods.isBrowserSpecialFree === true || goods.price === 0;
            if (free && json.totalPage > 0) {
                return {
                    store: 'ebookjapan',
                    kind: 'free',
                    bookCd: c.bookCd,
                    title: json.name || c.name,
                    totalPage: json.totalPage,
                    expiry: goods.saleEndDatetime || c.expiry,
                    // Userscript matches /viewer/*; the CLI resolves the detail page.
                    url: c.viewerUrl,
                    cliUrl: c.detailUrl || c.viewerUrl,
                    how: `/free/ payload (${candidates.length} candidates), publication API confirms free${c.expiry ? ` until ${c.expiry}` : ''}`,
                };
            }
            attempts.push({ bookCd: c.bookCd, free, totalPage: json.totalPage, price: goods.price });
        } catch (e) {
            attempts.push({ bookCd: c.bookCd, error: String(e.message).slice(0, 120) });
        }
    }
    throw new DiscoveryError('no ebookjapan free volume passed the publication check', attempts);
}
