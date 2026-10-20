// test_upstream_path.js — how a bridge lane is told which CDN to fetch, and
// what that costs in CORS.
//
// A real browser, a real CORS preflight, and a local proxy that records every
// request it is sent.
//
// The page is served from loopback rather than https://www.cmoa.jp because a
// current Chrome gates public -> loopback fetches behind the Local Network
// Access permission and denies it in headless, which would fail both forms and
// measure nothing. Loopback -> loopback is not a local-network transition, so
// the CORS machinery - the thing under test - runs exactly as it does for real.
// (The recorded HAR shows the real run was not LNA-gated either: all 299 of its
// preflights came back 200 from the CORS middleware, and the bridge answers an
// LNA preflight with 204.)
//
// The two contracts:
//   - x-bwdd-upstream header: a custom header, so the request is NOT a CORS
//     "simple request" and the browser answers every unique URL with its own
//     OPTIONS first. Measured on a real 160-page CMOA volume: 299 preflights.
//   - /_bwdd/<host>/<path>: no custom header, so no preflight at all.
//
// The header case is kept as a *control*: it proves this harness can observe a
// preflight, which is what makes its absence in the path case meaningful.
'use strict';
const puppeteer = require('puppeteer');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');

const CDN = 'cdn-under-test.example';
const BODY = Buffer.from('pretend-this-is-a-page.jpeg');

let bridgeHealth = null;    // what the fake bridge /health answers
let proxyHits = [];         // every request the fake proxy port received

const proxy = http.createServer((req, res) => {
    proxyHits.push({ method: req.method, url: req.url, upstream: req.headers['x-bwdd-upstream'] || null });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    res.setHeader('Content-Type', 'image/jpeg');
    res.end(BODY);
});

const app = https.createServer(
    {
        key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')),
    },
    (req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>app</title></head><body></body></html>');
    });

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

(async () => {
    const PROXY_PORT = await listen(proxy);
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
        page.on('pageerror', e => {
            const s = String(e);
            if (!/cookie|SecurityError|not valid JSON/i.test(s)) console.log('[pageerror]', s.slice(0, 160));
        });
        await page.setRequestInterception(true);
        page.on('request', req => {
            const url = req.url();
            if (url.includes(':' + APP_PORT + '/')) return req.continue();
            // The bridge's own main port: this is the discovery the script
            // really performs, so the capability has to travel this way.
            if (/^http:\/\/127\.0\.0\.1:62642\//.test(url)) {
                return req.respond({
                    status: 200,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                    body: JSON.stringify(bridgeHealth || {}),
                });
            }
            // Only the proxy port under test may serve lane traffic; anything
            // else on loopback (a real bridge the developer happens to be
            // running, the standalone helper) is kept out of the measurement.
            if (/^http:\/\/127\.0\.0\.1:/.test(url)) {
                if (url.includes(':' + PROXY_PORT + '/')) return req.continue();
                return req.abort();
            }
            if (/^https?:\/\/127\.0\.0\.1:/.test(url)) return req.abort();
            return req.continue();
        });

        await page.goto('https://127.0.0.1:' + APP_PORT + '/?bwddDebug=1', { waitUntil: 'domcontentloaded' });
        await page.addScriptTag({ content: uscript });
        await new Promise(r => setTimeout(r, 800));

        const wired = await page.evaluate(() => !!(window.__bwdd && window.__bwdd.laneFetch));
        check('the transport internals are reachable on the page', wired, 'window.__bwdd.laneFetch=' + wired);
        if (!wired) throw new Error('the userscript did not expose its debug surface');

        // Drive every laneFetch onto the proxy lane: the page lane's score is
        // in-flight / 6, so parking a large in-flight count on it makes the
        // proxy the least-utilised lane deterministically.
        const fetchThroughProxy = (n) => page.evaluate(async ({ cdn, count, port }) => {
            const b = window.__bwdd;
            b.laneStats.page.inflight = 999;
            const out = [];
            for (let i = 0; i < count; i++) {
                try {
                    const res = await b.laneFetch('https://' + cdn + '/sbc/sbcGetImg.php?src=p' + i + '.jpg&q=1&p=tok', 8000, { allowProxy: true });
                    const blob = await res.blob();
                    out.push({ ok: true, size: blob.size, lane: res._lane });
                } catch (e) { out.push({ ok: false, error: String(e && e.message || e) }); }
            }
            return {
                out,
                onlineLanes: b.allLanes(true).map(l => l.name),
                pageInflight: b.laneStats.page.inflight,
            };
        }, { cdn: CDN, count: n, port: PROXY_PORT });

        // A bridge that advertises the path form: the host rides in the URL, so
        // the request stays CORS-simple and the browser sends no preflight.
        bridgeHealth = {
            app: 'mokuro-bridge', version: '0.0.0', status: 'ok',
            fetchProxyPorts: [PROXY_PORT], fetchUpstreams: ['*'], fetchPathUpstream: true,
            active_sessions: 0,
        };
        proxyHits = [];
        const lanes = await page.evaluate(async () => {
            await window.__bwdd.discoverProxyPorts();
            return window.__bwdd.allLanes().filter(l => l.kind === 'proxy')
                .map(l => ({ name: l.name, pathUpstream: !!l.pathUpstream }));
        });
        check('discovery hides the new contract until the bridge advertises it',
            lanes.length === 1 && lanes[0].pathUpstream === true,
            JSON.stringify(lanes));

        const pathRun = await fetchThroughProxy(6);
        const pathOut = pathRun.out;
        const pathOk = pathOut.filter(r => r.ok && r.size > 0);
        const pathGets = proxyHits.filter(h => h.method === 'GET');
        const pathOptions = proxyHits.filter(h => h.method === 'OPTIONS');
        check('every page fetched through the path form arrives',
            pathOk.length === 6, pathOk.length + '/6 bodies returned; lanes=' +
            JSON.stringify(pathRun.onlineLanes) + ' pageInflight=' + pathRun.pageInflight +
            ' outcomes=' + JSON.stringify(pathOut.slice(0, 2)));
        check('the CDN is named as the first path segment',
            pathGets.length === 6 && pathGets.every(h => h.url.startsWith('/_bwdd/' + CDN + '/')),
            JSON.stringify(pathGets.slice(0, 2).map(h => h.url)));
        check('the signed query survives the path form untouched',
            pathGets.every(h => /src=p\d\.jpg&q=1&p=tok$/.test(h.url)),
            JSON.stringify(pathGets.slice(0, 1).map(h => h.url)));
        check('no x-bwdd-upstream header is sent with the path form',
            proxyHits.every(h => h.upstream === null),
            'headers seen: ' + JSON.stringify(proxyHits.map(h => h.upstream)));
        check('the path form costs ZERO CORS preflights',
            pathOptions.length === 0,
            pathOptions.length + ' OPTIONS request(s) for 6 pages');

        // The control: a bridge that only knows the original contract. The
        // header must still be honoured, and it must still cost a preflight -
        // otherwise the check above would pass for the wrong reason.
        bridgeHealth = {
            app: 'mokuro-bridge', version: '0.0.0', status: 'ok',
            fetchProxyPorts: [PROXY_PORT], fetchUpstreams: ['*'],
            active_sessions: 0,
        };
        proxyHits = [];
        const lanesOld = await page.evaluate(async () => {
            await window.__bwdd.discoverProxyPorts();
            return window.__bwdd.allLanes().filter(l => l.kind === 'proxy')
                .map(l => ({ name: l.name, pathUpstream: !!l.pathUpstream }));
        });
        check('an older bridge keeps the header contract',
            lanesOld.length === 1 && lanesOld[0].pathUpstream === false,
            JSON.stringify(lanesOld));

        const headRun = await fetchThroughProxy(6);
        const headOut = headRun.out;
        const headOk = headOut.filter(r => r.ok && r.size > 0);
        const headGets = proxyHits.filter(h => h.method === 'GET');
        const headOptions = proxyHits.filter(h => h.method === 'OPTIONS');
        check('every page fetched through the header form arrives',
            headOk.length === 6, headOk.length + '/6 bodies returned');
        check('the header form still names the CDN in x-bwdd-upstream',
            headGets.length === 6 && headGets.every(h => h.upstream === CDN),
            JSON.stringify(headGets.slice(0, 1).map(h => ({ url: h.url, upstream: h.upstream }))));
        check('the header form really does cost one preflight per page',
            headOptions.length === headGets.length && headGets.length === 6,
            headOptions.length + ' OPTIONS for ' + headGets.length + ' GET');

        console.log('\n--- summary ---');
        console.log('path form:   ' + pathGets.length + ' GET, ' + pathOptions.length + ' OPTIONS');
        console.log('header form: ' + headGets.length + ' GET, ' + headOptions.length + ' OPTIONS');
    } finally {
        if (page) await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }

    proxy.close();
    app.close();
    const failed = results.filter(r => !r.pass);
    fs.writeFileSync(path.join(__dirname, 'upstream_path_result.json'),
        JSON.stringify({ results, proxyHits }, null, 2));
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); proxy.close(); app.close(); process.exit(1); });
