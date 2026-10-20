'use strict';
/*
 * Find a target that is free *right now*.
 *
 * Pinning a volume UUID or cid in the test would rot: these storefronts rotate
 * what is free, so a hardcoded target eventually stops being free and the
 * acceptance run starts failing for a reason that has nothing to do with the
 * downloader. Every target is therefore discovered at run time from the store's
 * own server-rendered listing, and then re-validated against the store before
 * it is handed to a downloader.
 *
 * Each store reports how it was found and refuses to guess: a discovery that
 * cannot confirm a readable free volume throws `DiscoveryError`, which the
 * runner reports distinctly from a download failure. "The store has no free
 * volume today" and "our downloader broke" must not look the same in CI.
 *
 * The endpoints below were verified by hand against the live stores; see
 * README.md next to this file for the observed status codes and markers.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

class DiscoveryError extends Error {
    constructor(message, detail) {
        super(message);
        this.name = 'DiscoveryError';
        this.detail = detail;
    }
}

async function fetchText(url, opts = {}) {
    const res = await fetch(url, {
        redirect: opts.follow === false ? 'manual' : 'follow',
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.9', ...(opts.headers || {}) },
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, url: res.url };
}

async function fetchJson(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja,en;q=0.9' } });
    if (!res.ok) throw new DiscoveryError(`HTTP ${res.status} from ${url}`);
    return res.json();
}

const randomKey = () => Array.from({ length: 32 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[Math.floor(Math.random() * 64)]).join('');

// `https://bookwalker.jp/free/` is server-rendered and carries one
// `?sample=2` link per genuinely-free title. Trials are a different route
// (`?sample=1` -> viewer-trial) and this listing contains none, which is why it
// is preferred over hunting product pages.
async function discoverBookwalker(opts = {}) {
    const listing = await fetchText('https://bookwalker.jp/free/');
    if (listing.status !== 200) throw new DiscoveryError(`bookwalker /free/ returned ${listing.status}`);
    const re = /class="t-c-read-free-button">\s*<a\s+href="https:\/\/bookwalker\.jp\/(de[0-9a-f-]{36})\/\?sample=2"/g;
    const uuids = [...new Set([...listing.text.matchAll(re)].map(m => m[1]))];
    if (!uuids.length) throw new DiscoveryError('bookwalker /free/ carried no readable free-volume marker');

    const attempts = [];
    for (const uuid of uuids.slice(0, opts.tries || 4)) {
        const url = `https://bookwalker.jp/${uuid}/?sample=2`;
        const hop = await fetchText(url, { follow: false });
        const location = hop.headers.get('location') || '';
        if (hop.status === 302 && /viewer\.bookwalker\.jp/.test(location)) {
            return { store: 'bookwalker', url, kind: 'free', uuid, how: `/free/ listing (${uuids.length} candidates)` };
        }
        attempts.push({ uuid, status: hop.status, location: location.slice(0, 120) });
    }
    throw new DiscoveryError('bookwalker candidates did not reach the free viewer', attempts);
}

// The search endpoint filters server-side and is paginated, which beats the
// curated landing pages. `/free/` and `/trial/` are traps: both answer 200 with
// the site's error page, so a status check alone would "succeed" and parse
// nothing.
//
// Discovery is not trusted on its own. `bibGetCntntInfo.php` is the viewer's own
// data API and answers `result: 1` for a volume this client may actually read
// and `result: -100` when it may not — cookie-free. A volume that has just
// stopped being free is caught here instead of surfacing as an unexplained
// download failure.
async function cmoaReadable(cid) {
    const url = `https://www.cmoa.jp/bib/sws/bibGetCntntInfo.php?cid=${cid}&k=${randomKey()}&dmytime=${Date.now()}&u0=1`;
    const json = await fetchJson(url);
    return { result: json.result, title: (json.items && json.items[0] && (json.items[0].SubTitle || json.items[0].Title)) || null };
}

async function discoverCmoa(opts = {}) {
    const listing = await fetchText('https://www.cmoa.jp/search/result/?free_cam_flg=1&sort=16');
    if (listing.status !== 200) throw new DiscoveryError(`cmoa search returned ${listing.status}`);
    if (/<title>[^<]*エラー/.test(listing.text)) throw new DiscoveryError('cmoa search returned its error page');
    const re = /\/reader\/sample\/title_id\/(\d+)\/content_id\/(\d+)\//g;
    const seen = new Set();
    const candidates = [];
    for (const m of listing.text.matchAll(re)) {
        const titleId = m[1], contentId = m[2];
        if (seen.has(contentId)) continue;
        seen.add(contentId);
        // content_id = "1" + 10-digit title id + 4-digit volume.
        const volume = Number(contentId.slice(11, 15));
        if (!Number.isInteger(volume) || volume < 1) continue;
        candidates.push({
            titleId, contentId, volume,
            cid: `${String(titleId).padStart(10, '0')}_jp_${String(volume).padStart(4, '0')}`,
        });
    }
    if (!candidates.length) throw new DiscoveryError('cmoa search carried no free reader links');

    const attempts = [];
    for (const c of candidates.slice(0, opts.tries || 5)) {
        const check = await cmoaReadable(c.cid);
        if (check.result === 1) {
            return {
                store: 'cmoa', kind: 'free', cid: c.cid, title: check.title,
                url: `https://www.cmoa.jp/bib/speedreader/?cid=${c.cid}&u0=1`,
                how: `search free_cam_flg=1 (${candidates.length} candidates), bibGetCntntInfo result=1`,
            };
        }
        attempts.push({ cid: c.cid, result: check.result });
    }
    throw new DiscoveryError('no cmoa free volume was readable', attempts);
}

async function discoverEbookjapan(opts = {}) {
    const { discoverEbookjapan: impl } = require('./discover-ebookjapan.js');
    return impl(fetchText, DiscoveryError, opts);
}

const STORES = {
    bookwalker: discoverBookwalker,
    cmoa: discoverCmoa,
    ebookjapan: discoverEbookjapan,
};

/** Discover one target per requested store. Failures are returned, not thrown. */
async function discoverAll(keys, opts = {}) {
    const out = {};
    for (const key of keys) {
        const fn = STORES[key];
        if (!fn) { out[key] = { store: key, error: `unknown store ${key}` }; continue; }
        try {
            out[key] = await fn(opts);
        } catch (e) {
            out[key] = { store: key, error: e.message, detail: e.detail || null, discovery: e.name === 'DiscoveryError' };
        }
    }
    return out;
}

module.exports = { discoverAll, discoverBookwalker, discoverCmoa, discoverEbookjapan, DiscoveryError, fetchText, UA };
