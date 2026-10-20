// test_proxy_parking.js — a failing proxy must not delete its lanes.
//
// The real-world failure: the bridge hit its fd limit under a wide burst, every
// port 502'd at once, the old code splice()d all 48 out of proxyPorts, and the
// whole download collapsed onto the 6-socket page lane (191 of 204 pages,
// 11s average per page, 37s total). Ports must be PARKED instead, and must come
// back once the burst has passed.
'use strict';
const puppeteer = require('puppeteer');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');
const N_PORTS = 6;
const DEAD_BRIDGE_PORT = 63999;
const BUF = Buffer.alloc(1024, 5);

let mode = 'ok';                    // 'ok' | 'fail'
let proxyHits = 0, proxy502 = 0;
let PORTS = [];
// The proxy stand-in on 7010.. so the page lane (pointed at the CDN below) can
// still succeed while the proxy is failing — that fall-through is what keeps a
// download alive when the bridge breaks.
const srv = http.createServer((req, res) => {
  const path0 = req.url.split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (path0 === '/__bwdd_health') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ bwddFetchProxy: true, portList: PORTS }));
  }
  proxyHits++;
  if (mode === 'fail') { proxy502++; res.statusCode = 502; return res.end('{"error":"upstream fetch failed"}'); }
  res.setHeader('Content-Type', 'image/jpeg');
  res.end(BUF);
});
// The real page source: a healthy local CDN the page lane talks to directly.
let cdnHits = 0;
const cdnSrv = http.createServer((req, res) => {
  cdnHits++;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'image/jpeg');
  res.end(BUF);
});

const appSrv = https.createServer(
  { key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')) },
  (req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body></body></html>'); });

const listen = (s, p) => new Promise(r => s.listen(p || 0, '127.0.0.1', () => r(s.address().port)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await listen(srv, 7010);
  PORTS = Array.from({ length: N_PORTS }, (_, i) => 7010 + i);
  const cdnPort = await listen(cdnSrv);
  const CDN = 'http://127.0.0.1:' + cdnPort + '/';
  const appPort = await listen(appSrv);
  const APP = 'https://127.0.0.1:' + appPort + '/?bwddDebug=1';

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', r => { if (/bookwalker\.jp/.test(r.url())) return r.abort(); r.continue(); });
  page.on('console', m => { const t = m.text(); if (/retired after repeated parks/.test(t)) console.log('   [console] ' + t.slice(0,120)); });
  await page.goto(APP);
  const src = fs.readFileSync(US, 'utf8').replace(
    "'http://127.0.0.1:62642'", "'http://127.0.0.1:" + DEAD_BRIDGE_PORT + "'");
  await page.addScriptTag({ content: src });
  await sleep(300);
  await page.evaluate((cdn) => {
    const s = window.__bwdd.state;
    s.baseUrl = cdn;
    s.auth = { hti: 'x', Policy: 'p', Signature: 's' };
    s.cid = 'parking';
  }, CDN);

  const results = [];
  const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };

  const probed = await page.evaluate(() => window.__bwdd.probeFetchProxy().then(p => p.length));
  check('proxy lanes are discovered', probed === N_PORTS, probed + ' ports');

  mode = 'fail';
  await page.evaluate(async (n) => {
    const b = window.__bwdd;
    await Promise.all(Array.from({ length: n }, (_, i) =>
      b.cdnFetch(() => b.state.baseUrl + 'p' + i + '.jpg?a=1', 8000).then(r => r.blob()).catch(() => {})));
  }, N_PORTS * 20);
  const after = await page.evaluate(() => {
    const b = window.__bwdd;
    const los = b.laneStats;
    return {
      lanesRemaining: b.allLanes().filter(l => l.name.startsWith('px:')).length,
      portsRemaining: b.proxyPorts.length,
      parked: Object.keys(los).filter(k => k.startsWith('px:') && los[k].parkUntil > Date.now()).length,
    };
  });
  check('a failing burst does NOT delete the proxy ports',
    after.portsRemaining === N_PORTS,
    after.portsRemaining + '/' + N_PORTS + ' ports still registered (old code deleted all of them)');
  check('failing ports are parked, not lost',
    after.lanesRemaining === 0 && after.parked === N_PORTS,
    after.parked + ' parked, ' + after.lanesRemaining + ' still selectable during the burst');

  check('requests still succeeded via the page lane while parked',
    cdnHits > 0, cdnHits + ' pages fell through to the page lane (proxy was 502ing)');

  mode = 'ok';
  await sleep(4200);   // outlast PROXY_PARK_MS
  const recovered = await page.evaluate(() => window.__bwdd.allLanes().filter(l => l.name.startsWith('px:')).length);
  check('parked ports return to the pool after the cooldown',
    recovered === N_PORTS, recovered + '/' + N_PORTS + ' proxy lanes selectable again');

  proxyHits = 0; cdnHits = 0; proxy502 = 0;
  const okAfter = await page.evaluate(async () => {
    const b = window.__bwdd;
    let ok = 0;
    await Promise.all(Array.from({ length: 24 }, (_, i) =>
      b.cdnFetch(() => b.state.baseUrl + 'q' + i + '.jpg?a=2', 8000)
        .then(r => r.blob()).then(bl => { if (bl.size > 0) ok++; }).catch(() => {})));
    return ok;
  });
  const pxUsed = proxyHits;   // counted at the proxy stand-in, not via laneStats
  const diag = await page.evaluate(() => {
    const b = window.__bwdd;
    const out = {};
    for (const k of Object.keys(b.laneStats)) {
      if (k.startsWith('px:')) out[k] = { errors: b.laneStats[k].errors, parks: b.laneStats[k].parks };
    }
    return { lanes: b.allLanes().length, proxy: out };
  });
  check('after recovery, traffic flows through the proxy again',
    okAfter === 24 && pxUsed > 0,
    okAfter + '/24 ok; ' + pxUsed + ' via proxy, ' + cdnHits + ' via page lane, ' + proxy502 + ' x 502');
  if (okAfter !== 24) console.log('   diag: ' + JSON.stringify(diag));

  console.log('\n--- summary ---');
  console.log('after failing burst : ' + after.portsRemaining + ' ports kept, ' + after.parked + ' parked');
  console.log('after cooldown      : ' + recovered + ' lanes back, ' + pxUsed + ' via proxy / ' + cdnHits + ' via page');

  await page.close(); await browser.close(); srv.close(); cdnSrv.close(); appSrv.close();
  const failed = results.filter(r => !r.pass);
  fs.writeFileSync(path.join(__dirname, 'proxy_parking_result.json'), JSON.stringify({ after, recovered, pxUsed, results }, null, 2));
  console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
