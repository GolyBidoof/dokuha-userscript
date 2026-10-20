// test_lanes.js — focused harness for the transport-lane changes in
// dokuha-userscript.user.js.
//
// Two local HTTP servers stand in for the two "socket pools":
//   * cdnPort  — hit by the page lane (plain fetch())
//   * gmPort   — hit by a GM_xmlhttpRequest stub installed before the userscript
//                loads, standing in for Tampermonkey's background context.
//
// Verifies:
//   1. with a working GM lane, both lanes serve pages
//   2. a broken GM lane (throws) still lets every page succeed, and retires
//      itself instead of failing requests
//   3. a 403 on the page lane is retried and recovered
//   4. that 403 recovery does NOT trip the global rate-limit breaker
//   5. a duplicate relPath is only fetched once (inflight de-dupe)
'use strict';
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const state = { cdnHits: [], gmHits: [], mode: 'ok', seen: new Set() };

function makeServer(tag) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const page = u.searchParams.get('p') || u.pathname;
    if (tag === 'cdn') state.cdnHits.push(page); else state.gmHits.push(page);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'image/png');
    if (tag === 'cdn') {
      if (state.mode === '403once' && !state.seen.has(page)) {
        state.seen.add(page);
        res.statusCode = 403;
        return res.end('<html>cached error page</html>');
      }

    }
    res.statusCode = 200;
    res.end(PNG);
  });
}

const cdnSrv = makeServer('cdn');
const gmSrv = makeServer('gm');
// A real HTTP origin for the page itself: about:blank has an opaque origin and
// makes document.cookie throw inside the userscript's auth helpers.
const appSrv = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><body><div id="viewer"></div></body></html>');
});

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

(async () => {
  const cdnPort = await listen(cdnSrv);
  const gmPort = await listen(gmSrv);
  const appPort = await listen(appSrv);
  const CDN = 'http://127.0.0.1:' + cdnPort;
  const GM = 'http://127.0.0.1:' + gmPort;
  const APP = 'http://127.0.0.1:' + appPort + '/?bwddDebug=1';

  const uscript = loadUserscript();
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  page.on('pageerror', e => {
    const s = String(e);
    if (/cookie|SecurityError|not valid JSON/i.test(s)) return;   // harness noise
    console.log('[pageerror]', s.slice(0, 200));
  });

  // Intercept the auth-refresh endpoints so refreshAuthBest() fails fast
  // instead of reaching out to the real site.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (/bookwalker\.jp/.test(u) && !u.startsWith('http://127.0.0.1')) return req.abort();
    req.continue();
  });

  // GM_xmlhttpRequest stub, installed BEFORE the userscript runs. It rewrites
  // the target host to the "GM pool" server so hits can be attributed.
  await page.evaluateOnNewDocument((gmBase, broken) => {
    window.__gmBroken = broken;
    window.GM_xmlhttpRequest = function (d) {
      if (window.__gmBroken) {
        setTimeout(() => d.onerror && d.onerror({ error: 'stub failure' }), 5);
        return;
      }
      const target = d.url.replace(/^https?:\/\/[^/]+/, gmBase);
      fetch(target, { credentials: 'omit' })
        .then(async (r) => {
          const b = await r.blob();
          d.onload && d.onload({ status: r.status, response: b, responseText: '' });
        })
        .catch((e) => d.onerror && d.onerror({ error: String(e) }));
    };
  }, GM, false);

  await page.goto(APP);
  await page.addScriptTag({ content: uscript });
  await new Promise(r => setTimeout(r, 300));

  const ok = await page.evaluate(() => !!(window.__bwdd && window.__bwdd.cdnFetch));
  if (!ok) { console.log('FAIL: __bwdd hook missing'); await browser.close(); process.exit(1); }

  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
  };

  const setup = async () => page.evaluate((cdn) => {
    const s = window.__bwdd.state;
    s.baseUrl = cdn + '/';
    s.auth = { hti: 'x', cfg: '1', bid: 'b', pfCd: '03', Policy: 'p1', Signature: 's1', 'Key-Pair-Id': 'k' };
    s.cid = 'test-cid';
    window.__bwdd.laneStats.page = { inflight: 0, done: 0, bytes: 0, ms: 0, errors: 0 };
    window.__bwdd.laneStats.gm = { inflight: 0, done: 0, bytes: 0, ms: 0, errors: 0 };
  }, CDN);

  await setup();
  state.cdnHits.length = 0; state.gmHits.length = 0; state.mode = 'ok';
  const served = await page.evaluate(async () => {
    const b = window.__bwdd;
    let ok = 0;
    const jobs = [];
    for (let i = 0; i < 24; i++) {
      jobs.push(b.cdnFetch((a) => b.state.baseUrl + 'page' + i + '.jpeg?p=p' + i, 8000)
        .then(r => { if (r.ok) ok++; }).catch(() => {}));
    }
    await Promise.all(jobs);
    return ok;
  });
  const pageHits = state.cdnHits.length, gmHits = state.gmHits.length;
  check('every request is served', served === 24, 'ok=' + served + '/24');
  check('round-robin stays balanced (within 40%)',
    Math.min(pageHits, gmHits) / Math.max(pageHits, gmHits) >= 0.6,
    pageHits + ' vs ' + gmHits);

  // laneSummary arithmetic — this is what a real run logs to the console
  await setup();
  const summary = await page.evaluate(() => {
    const b = window.__bwdd;
    b.recordLane('page', 1000, 1048576);
    b.recordLane('page', 1000, 0);
    b.recordLane('gm', 1000, 0);
    return b.laneSummary();
  });
  check('laneSummary reports pages / avg latency / MB / share',
    summary.page.pages === 2 && summary.page.avgMs === 1000 &&
    summary.page.mb === 1 && summary.page.share === '67%' &&
    summary.gm.pages === 1 && summary.gm.share === '33%' &&
    summary.page.pagesPerSec === undefined,
    JSON.stringify(summary));

  await setup();
  state.cdnHits.length = 0; state.gmHits.length = 0;
  await page.evaluate(() => { window.__gmBroken = true; });
  // reload the stub flag is read at call time, so this works live
  const brokenRes = await page.evaluate(async () => {
    const b = window.__bwdd;
    let okCount = 0;
    for (let i = 0; i < 12; i++) {
      try {
        const r = await b.cdnFetch((a) => b.state.baseUrl + 'b' + i + '.jpeg?p=b' + i, 8000);
        const bl = await r.blob();
        if (r.ok && bl.size > 0) okCount++;
      } catch (e) {}
    }
    return { okCount, gmUsable: b.gmUsable };
  });
  check('broken GM lane still delivers every page via the page lane',
    brokenRes.okCount === 12, 'ok=' + brokenRes.okCount + '/12');
  check('broken GM lane retires itself', brokenRes.gmUsable === false,
    'gmUsable=' + brokenRes.gmUsable);
  await page.evaluate(() => { window.__gmBroken = false; });

  await setup();
  state.cdnHits.length = 0; state.gmHits.length = 0; state.seen.clear(); state.mode = '403once';
  const t403 = await page.evaluate(async () => {
    const b = window.__bwdd;
    const t0 = performance.now();
    let okCount = 0;
    for (let i = 0; i < 10; i++) {
      try {
        const r = await b.cdnFetch((a) => b.state.baseUrl + 'c' + i + '.jpeg?p=c' + i, 8000);
        if (r.ok) okCount++;
      } catch (e) {}
    }
    return { okCount, ms: performance.now() - t0 };
  });
  check('a 403 is retried and recovered', t403.okCount === 10, 'ok=' + t403.okCount + '/10');
  // With a per-request jittered backoff and no global breaker, 10 pages each
  // 403-ing once then succeeding should stay well under a single 8s cooldown.
  check('403 recovery does not trip the 8s global breaker',
    t403.ms < 4000, Math.round(t403.ms) + 'ms for 10 pages (breaker would add 8s)');

  const busted = state.cdnHits.filter(p => p.startsWith('c'));
  check('403 retries carry a cache-busting param',
    busted.length >= 20, busted.length + ' cdn hits for 10 pages (expect 2 each)');

  await setup();
  state.cdnHits.length = 0; state.gmHits.length = 0; state.mode = 'ok';
  const dedupe = await page.evaluate(async () => {
    const b = window.__bwdd;
    const map = new Map();
    let starts = 0;
    const start = async () => {
      starts++;
      const r = await b.cdnFetch(() => b.state.baseUrl + 'dupe.jpeg?p=dupe', 8000);
      return await r.blob();
    };
    const [a, c] = await Promise.all([
      b.dedupeInflight(map, 'dupe', start),
      b.dedupeInflight(map, 'dupe', start),
    ]);
    // a third, sequential request after settle must start a fresh fetch
    await b.dedupeInflight(map, 'dupe', start);
    return { starts, same: a === c, size: a.size };
  });
  check('concurrent identical requests share one fetch', dedupe.starts === 2,
    'starts=' + dedupe.starts + ' (1 shared + 1 after settle)');
  check('de-duped callers get the same blob', dedupe.same === true,
    'size=' + dedupe.size);

  const failed = results.filter(r => !r.pass);
  console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL ' + results.length + ' CHECKS PASSED'));
  fs.writeFileSync(path.join(__dirname, 'lane_test_result.json'),
    JSON.stringify({ pageHits, gmHits, brokenRes, t403, results }, null, 2));

  await browser.close();
  cdnSrv.close(); gmSrv.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
