// test_ebookjapan_gm_lane.js — reaching the accelerator from a page whose CSP
// forbids loopback.
//
// ebookjapan serves `connect-src 'self' https: wss:`, so a page-realm
// fetch('http://127.0.0.1:<port>/...') is refused before a socket opens. That is
// what made the whole accelerator look unreachable for this site: discovery
// (probeBridgeFetchProxy) and the proxy lane transport were both page-realm
// fetches, so no port was ever registered and every page went out over
// GM_xmlhttpRequest straight at the CDN — one origin, six sockets, however many
// bridge ports were running.
//
// The fix is that the loopback requests ride GM when the realm is sealed: GM is
// not subject to the page's CSP, and each port is its own origin, so 48 ports
// become 48 socket pools. This test serves the real CSP, so the page realm is
// genuinely sealed, and shims GM so the transport choice is observable.
'use strict';
const puppeteer = require('puppeteer');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');
const SPLIT = path.resolve(__dirname, '..', 'ebookjapan-only.user.js');

const PROXY_PORT = 63111;
const CDN = 'prod-contents-br-page.akamaized.net';
const PAGE_URL = 'https://' + CDN + '/pages/A6/A6100533218061/1GEn47/deadbeef.webp';

// Byte-for-byte the directive the viewer sends.
const EBJ_CSP = "base-uri 'none'; font-src 'self' https: data:; form-action 'self' https:; "
    + "frame-ancestors 'self'; img-src 'self' https: data:; object-src 'none'; "
    + "script-src-attr 'none'; style-src 'self' https: 'unsafe-inline'; "
    + "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https:; "
    + "upgrade-insecure-requests; frame-src 'self' https:; connect-src 'self' https: wss:;";

const HEALTH = {
    app: 'mokuro-bridge', status: 'ok',
    fetchProxyPorts: [PROXY_PORT],
    fetchUpstreams: ['*'],
    fetchPathUpstream: true,
    active_sessions: 0,
};
const IMAGE = Buffer.from('these-are-the-page-bytes');

const app = https.createServer(
    {
        key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')),
    },
    (req, res) => {
        res.setHeader('Content-Security-Policy', EBJ_CSP);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>v</title></head><body></body></html>');
    });

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

(async () => {
    const APP_PORT = await listen(app);
    const uscript = fs.readFileSync(US, 'utf8');
    const results = [];
    const check = (n, pass, d) => {
        results.push({ n, pass, d });
        console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d);
    };

    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true,
        args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    let page;
    try {
        page = await browser.newPage();
        // A GM_xmlhttpRequest that answers the bridge and the port and records
        // every URL it was asked for. It must not touch the network: the point is
        // to observe which transport the code chose, and a page-realm fetch would
        // be refused by the CSP we are deliberately serving.
        await page.evaluateOnNewDocument((health, image, port) => {
            window.__gmCalls = [];
            window.GM_xmlhttpRequest = function (o) {
                window.__gmCalls.push({ url: o.url, method: o.method || 'GET' });
                const done = () => {
                    let body = null, type = 'application/json';
                    if (o.url.indexOf('__bwdd_health') !== -1 || /\/health(\?|$)/.test(o.url)) {
                        body = JSON.stringify(health);
                    } else if (o.url.indexOf('/_bwdd/') !== -1) {
                        body = new Uint8Array(image).buffer;
                        type = 'image/jpeg';
                    } else {
                        if (o.onerror) o.onerror(new Error('unexpected GM url ' + o.url));
                        return;
                    }
                    if (o.onload) {
                        o.onload({
                            status: 200,
                            response: new Blob([body], { type: type }),
                            responseHeaders: 'content-type: ' + type + '\r\n',
                        });
                    }
                };
                setTimeout(done, 1);
            };
        }, HEALTH, Array.from(IMAGE), PROXY_PORT);

        await page.setRequestInterception(true);
        page.on('request', req => {
            const url = req.url();
            if (url.includes(':' + APP_PORT + '/')) return req.continue();
            // Any loopback request the page realm tried to make would show up in
            // the server log; there is no server here, so abort and count it.
            if (/^https?:\/\/127\.0\.0\.1:/.test(url)) { loopbackTries.push(url); return req.abort(); }
            return req.abort();
        });
        const loopbackTries = [];

        await page.goto('https://127.0.0.1:' + APP_PORT + '/?bwddDebug=1', { waitUntil: 'domcontentloaded' });
        await page.addScriptTag({ content: uscript });
        await new Promise(r => setTimeout(r, 700));

        const realm = await page.evaluate(async () => {
            try {
                const r = await fetch('http://127.0.0.1:63111/_bwdd/' + 'x.example' + '/a.jpg', { credentials: 'omit' });
                return 'HTTP ' + r.status;
            } catch (e) { return 'THREW'; }
        });
        check('the page realm cannot reach a loopback port (CSP is really enforced)',
            realm === 'THREW', 'page-realm fetch said: ' + realm);

        // Boot discovery should have already asked the bridge and learned that this
        // realm cannot open a loopback port, so a run never pays a refusal. Bounded
        // wait: the probe is a real round trip.
        const bootFlag = await page.evaluate(async () => {
            for (let i = 0; i < 40; i++) {
                if (window.__bwdd.proxyRealmBlocked) return true;
                await new Promise(r => setTimeout(r, 100));
            }
            return window.__bwdd.proxyRealmBlocked;
        });
        check('boot discovery settles the loopback question before any run starts',
            bootFlag === true, 'proxyRealmBlocked=' + bootFlag);

        // This is the field failure. `proxyLaneFetch` reached laneAttempt and the
        // page-realm branch, was refused by CSP, and the page fell back to
        // GM-at-the-CDN - one refused request per page, accelerator unused. The
        // port is registered here directly (no discovery), so nothing has had the
        // chance to notice the realm is sealed and the attempt itself has to.
        const triesBefore = loopbackTries.length;
        const healed = await page.evaluate(async (pageUrl) => {
            const b = window.__bwdd;
            b.clearProxySource('bridge');
            // Same state the field failure had: the bridge's allowlist and its
            // port are both known, only the realm's reachability is not.
            b.setProxyUpstreams(['*']);
            b.addProxyPorts([63111], 'bridge', { pathUpstream: true });
            // Boot discovery normally settles this before any click, which is the
            // point of doing it at load. Clear it to reproduce a run started
            // immediately, where the first page is the one that has to find out.
            b.resetProxyRealmFlag();
            window.__gmCalls.length = 0;
            const before = b.proxyRealmBlocked;
            const res = await b.proxyLaneFetch(pageUrl, 8000);
            const out = { before: before, after: b.proxyRealmBlocked, got: null };
            if (res) { const buf = await (await res.blob()).arrayBuffer(); out.got = buf.byteLength; }
            out.gmCalls = window.__gmCalls.map(c => c.url);
            return out;
        }, PAGE_URL);
        healed.pageRealmTries = loopbackTries.length - triesBefore;
        check('a page-realm refusal self-heals onto GM instead of losing the page',
            healed.got === IMAGE.length && healed.before === false && healed.after === true,
            JSON.stringify({ before: healed.before, after: healed.after, bytes: healed.got }));
        // pageRealmTries is 0 on purpose: Chrome refuses the loopback fetch at the
        // CSP check, so it never becomes a network request for interception to see.
        // The proof the realm was tried is the flag flipping in the same call.
        check('the healed request rode GM, and the refused attempt never even became a request',
            (healed.gmCalls || []).length === 1 && healed.pageRealmTries === 0,
            'GM=' + JSON.stringify(healed.gmCalls) + ' page-realm requests=' + healed.pageRealmTries);

        const found = await page.evaluate(async () => {
            await window.__bwdd.discoverProxyPorts();
            return {
                lanes: window.__bwdd.allLanes().filter(l => l.kind === 'proxy')
                    .map(l => ({ name: l.name, pathUpstream: !!l.pathUpstream })),
                blocked: window.__bwdd.proxyRealmBlocked,
                gmCalls: window.__gmCalls.map(c => c.url),
            };
        });
        check('discovery reaches the bridge through GM and registers its port',
            found.lanes.length === 1 && found.lanes[0].pathUpstream === true,
            JSON.stringify(found.lanes));
        check('the realm is marked sealed, so later requests do not retry the refused fetch',
            found.blocked === true, 'proxyRealmBlocked=' + found.blocked);
        check('the bridge health was read over GM',
            found.gmCalls.some(u => u.indexOf('/health') !== -1),
            JSON.stringify(found.gmCalls.slice(0, 3)));

        // The panel polls this and every run asks for it, and the bridge's /health
        // is ~0.7s server-side. Two overlapping callers must share one probe, and a
        // caller arriving just after a success must not pay again.
        const coalesced = await page.evaluate(async () => {
            window.__bwdd.clearProxySource('bridge');
            window.__gmCalls.length = 0;
            await Promise.all([
                window.__bwdd.discoverProxyPorts(),
                window.__bwdd.discoverProxyPorts(),
                window.__bwdd.discoverProxyPorts(),
            ]);
            const together = window.__gmCalls.filter(c => c.url.indexOf('/health') !== -1).length;
            window.__gmCalls.length = 0;
            await window.__bwdd.discoverProxyPorts();
            const later = window.__gmCalls.filter(c => c.url.indexOf('/health') !== -1).length;
            return { together: together, later: later };
        });
        check('three overlapping discoveries share a single probe',
            coalesced.together === 1, 'health calls=' + coalesced.together);
        // Deliberately not cached: a bridge can be restarted or reconfigured while
        // the page is open, so a later call must ask again rather than trust a
        // result from seconds ago.
        check('a later discovery asks again instead of trusting a stale answer',
            coalesced.later === 1, 'health calls=' + coalesced.later);

        const portTriesBefore = loopbackTries.length;
        const viaPort = await page.evaluate(async (pageUrl) => {
            window.__gmCalls.length = 0;
            const before = window.__bwdd.laneStats['px:63111'].inflight;
            const res = await window.__bwdd.proxyLaneFetch(pageUrl, 8000);
            if (!res) return { failed: true };
            const buf = await (await res.blob()).arrayBuffer();
            return {
                ok: res.ok, status: res.status, bytes: buf.byteLength,
                lane: res._lane, before: before,
                gmCalls: window.__gmCalls.map(c => c.url),
            };
        }, PAGE_URL);
        viaPort.pageRealmTries = loopbackTries.length - portTriesBefore;
        check('a page is fetched through the accelerator port',
            !!viaPort.ok && viaPort.bytes === IMAGE.length && /^px:/.test(viaPort.lane || ''),
            JSON.stringify({ ok: viaPort.ok, bytes: viaPort.bytes, lane: viaPort.lane }));
        check('the CDN is named inside the URL, so no custom header is needed',
            (viaPort.gmCalls || []).some(u => u === 'http://127.0.0.1:' + PROXY_PORT +
                '/_bwdd/' + CDN + '/pages/A6/A6100533218061/1GEn47/deadbeef.webp'),
            JSON.stringify(viaPort.gmCalls));
        check('the port request went over GM, not the page realm',
            (viaPort.gmCalls || []).length === 1 && viaPort.pageRealmTries === 0,
            'GM=' + JSON.stringify(viaPort.gmCalls) + ' page-realm tries=' + viaPort.pageRealmTries);

        const offList = await page.evaluate(async () => {
            window.__bwdd.setProxyUpstreams(['bw-v-epubs.example']);
            const res = await window.__bwdd.proxyLaneFetch('https://elsewhere.example/page.webp', 5000);
            await window.__bwdd.discoverProxyPorts();
            return res === null;
        });
        check('a CDN outside the bridge allowlist is refused rather than aimed at a port',
            offList === true, 'proxyLaneFetch returned null: ' + offList);

        const src = fs.readFileSync(SPLIT, 'utf8');
        const body = src.slice(src.indexOf('async function ebjFetchPage'));
        const end = body.indexOf('\n    }\n');
        const fn = end === -1 ? body : body.slice(0, end);
        check('ebjFetchPage tries the accelerator before falling back to GM-to-CDN',
            fn.indexOf('proxyLaneFetch') !== -1 &&
            fn.indexOf('proxyLaneFetch') < fn.indexOf('GM_xmlhttpRequest'),
            'proxyLaneFetch@' + fn.indexOf('proxyLaneFetch') +
            ' GM_xmlhttpRequest@' + fn.indexOf('GM_xmlhttpRequest'));
        check('the old fan-out cap of 16 is gone',
            src.indexOf('Math.min(16, budget)') === -1, 'no Math.min(16, budget) in the shipped split');
        check('the fan-out is sized from the socket budget with a memory cap',
            /inflightCap = 256/.test(src) && /budget \+ Math\.max\(8/.test(src),
            'found the 256 cap and the budget-scaled window');
        // The path form names the CDN in the URL. Using it only when the host
        // *differs* from the bridge's default makes every request a bet that the
        // bridge's default upstream is the CDN this run wants, and a stale one
        // answers from the wrong host - a 404 or a wrong page, not an error.
        check('the path form names the CDN even when it equals the bridge default',
            /if \(host && lane\.pathUpstream\) target = proxyPathUrlFor\(lane\.port, host, url\);/
                .test(src),
            'path form is unconditional on the host matching the default');
        check('the GM mirror can name the host too, since GM pays no preflight',
            /x-bwdd-upstream/.test(src) && /gmProxyRequest\(target, host, to, gmHeaders\)/.test(src),
            'GM carries the host header when the bridge predates the path form');
        check('gmBlobFetch forwards headers to GM_xmlhttpRequest',
            /function gmBlobFetch\(url, timeoutMs, headers\)/.test(src) &&
            /headers: headers \|\| undefined,/.test(src));
        // A port that answers 404 or refuses the host must say so. Swallowing it
        // is what made "every page fell back to the CDN" cost a whole round trip
        // of guessing: the run reported lanes gm and nothing named the ports.
        check('a port that answers badly says so instead of failing silently',
            /function gmProxyNote\(why\)/.test(src) &&
            /if \(!gm\.ok\) gmProxyNote\('HTTP ' \+ gm\.status/.test(src),
            'the unusable reason is logged once per distinct cause');
    } finally {
        if (page) await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }

    app.close();
    const failed = results.filter(r => !r.pass);
    fs.writeFileSync(path.join(__dirname, 'ebookjapan_gm_lane_result.json'),
        JSON.stringify({ results }, null, 2));
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); app.close(); process.exit(1); });
