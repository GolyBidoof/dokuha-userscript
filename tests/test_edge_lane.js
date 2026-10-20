// test_edge_lane.js — end-to-end test of the userscript's HTTP/2 edge-mirror
// lane, using a LOCAL h2 server that implements the same contract as
// bw-edge-mirror.js (same paths, same /__bwdd_health shape). This proves the
// lane wiring and the concurrency win without needing a Cloudflare account.
'use strict';
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const http = require('http');
const http2 = require('http2');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');
const DELAY = 300;
const BUF = Buffer.alloc(4096, 8);
const N = 60;

const cdn = { cur: 0, max: 0, hits: 0, viaEdge: 0 };
const cdnSrv = http.createServer((req, res) => {
  cdn.cur++; cdn.hits++; if (cdn.cur > cdn.max) cdn.max = cdn.cur;
  if (req.headers['x-bwdd-edge']) cdn.viaEdge++;
  setTimeout(() => {
    cdn.cur--;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.end(BUF);
  }, DELAY);
});

let CDN = '';
const edge = { conns: 0, cur: 0, max: 0, token: '' };
const edgeSrv = http2.createSecureServer({
  key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')),
  allowHTTP1: false,
});
edgeSrv.on('connection', () => { edge.conns++; });
edgeSrv.on('session', s => s.on('error', () => {}));
edgeSrv.on('stream', (stream, headers) => {
  const p = headers[':path'] || '/';
  const origin = headers['origin'];
  if (p === '/__bwdd_health') {
    stream.respond({ ':status': 200, 'content-type': 'application/json',
      'access-control-allow-origin': origin || '*' });
    return stream.end(JSON.stringify({ bwddEdgeMirror: true, version: 1, tokenRequired: !!edge.token }));
  }
  if (edge.token && headers['x-bwdd-token'] !== edge.token) {
    stream.respond({ ':status': 403 });
    return stream.end('forbidden');
  }
  edge.cur++; if (edge.cur > edge.max) edge.max = edge.cur;
  fetch(CDN + p, { headers: { 'x-bwdd-edge': '1' } })
    .then(async (r) => {
      const buf = Buffer.from(await r.arrayBuffer());
      stream.respond({ ':status': r.status, 'content-type': 'application/octet-stream',
        'access-control-allow-origin': origin || '*' });
      stream.end(buf);
    })
    .catch(() => { try { stream.respond({ ':status': 502 }); stream.end(); } catch (e) {} })
    .finally(() => { edge.cur--; });
});

const appSrv = https.createServer(
  { key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')) },
  (req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body></body></html>'); });

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const uscript = loadUserscript();

(async () => {
  const cdnPort = await listen(cdnSrv);
  CDN = 'http://127.0.0.1:' + cdnPort;
  const edgePort = await listen(edgeSrv);
  const EDGE = 'https://127.0.0.1:' + edgePort;
  const APP = 'https://127.0.0.1:' + (await listen(appSrv)) + '/?bwddDebug=1';

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'],
  });

  const results = [];
  const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };

  async function freshPage(edgeUrl, token) {
    const p = await browser.newPage();
    p.on('pageerror', e => { const s = String(e); if (!/cookie|SecurityError|not valid JSON/i.test(s)) console.log('[pageerror]', s.slice(0, 140)); });
    await p.setRequestInterception(true);
    p.on('request', r => {
      const u = r.url();
      if (/bookwalker\.jp/.test(u) && !u.startsWith('http://127.0.0.1') && !u.startsWith('https://127.0.0.1')) return r.abort();
      r.continue();
    });
    await p.goto(APP);
    await p.addScriptTag({ content: uscript });
    await new Promise(r => setTimeout(r, 250));
    await p.evaluate((cdn, eu, tok) => {
      const s = window.__bwdd.state;
      s.baseUrl = cdn + '/';
      s.auth = { hti: 'x', Policy: 'p1', Signature: 's1' };
      s.cid = 'edge-test';
      if (eu) window.__bwddEdgeMirror = eu;
      if (tok) window.__bwddEdgeToken = tok;
    }, CDN, edgeUrl, token);
    return p;
  }

  const fire = (p, n) => p.evaluate(async (count) => {
    const b = window.__bwdd;
    let ok = 0;
    await Promise.all(Array.from({ length: count }, (_, i) =>
      b.cdnFetch(() => b.state.baseUrl + 'p' + i + '.png', 15000)
        .then(r => r.blob()).then(bl => { if (bl.size > 0) ok++; }).catch(() => {})));
    return ok;
  }, n);

  let page = await freshPage(null, null);
  const noEdge = await page.evaluate(() => window.__bwdd.probeEdgeMirror().then(v => ({ v, lanes: window.__bwdd.allLanes().map(l => l.name) })));
  check('with no mirror configured the lane stays off',
    noEdge.v === false && !noEdge.lanes.includes('edge'), JSON.stringify(noEdge));

  cdn.cur = 0; cdn.max = 0; cdn.hits = 0; cdn.viaEdge = 0;
  const baseOk = await fire(page, N);
  check('baseline is capped at 6 concurrent CDN fetches',
    cdn.max === 6, 'peak = ' + cdn.max + ' (ok=' + baseOk + '/' + N + ')');
  await page.close();

  cdn.cur = 0; cdn.max = 0; cdn.hits = 0; cdn.viaEdge = 0;
  edge.conns = 0; edge.cur = 0; edge.max = 0;
  page = await freshPage(EDGE, null);
  const on = await page.evaluate(() => window.__bwdd.probeEdgeMirror().then(v => ({ v, lanes: window.__bwdd.allLanes().map(l => l.name), budget: window.__bwdd.fetchSocketBudget() })));
  check('probe enables the edge lane', on.v === true && on.lanes.includes('edge'), JSON.stringify(on));

  const edgeOk = await fire(page, N);
  check('every request succeeds through the edge lane', edgeOk === N, 'ok=' + edgeOk + '/' + N);
  check('traffic really flowed through the edge',
    cdn.viaEdge >= N * 0.8, 'viaEdge=' + cdn.viaEdge + '/' + cdn.hits);
  check('CDN-side concurrency blows past the 6-socket ceiling',
    cdn.max > 6, 'peak CDN concurrency = ' + cdn.max + ' (direct was 6)');
  check('the browser multiplexed over the h2 connection',
    edge.max >= 30, 'peak concurrent h2 streams = ' + edge.max + ' over ' + edge.conns + ' TCP conn(s)');
  await page.close();

  edge.token = 'sekrit';
  page = await freshPage(EDGE, null);
  const noTok = await page.evaluate(() => window.__bwdd.probeEdgeMirror().then(v => ({ v, lanes: window.__bwdd.allLanes().map(l => l.name) })));
  check('a token-protected mirror refuses to activate without the token',
    noTok.v === false && !noTok.lanes.includes('edge'), JSON.stringify(noTok));
  await page.close();

  page = await freshPage(EDGE, 'sekrit');
  const withTok = await page.evaluate(() => window.__bwdd.probeEdgeMirror().then(v => ({ v, lanes: window.__bwdd.allLanes().map(l => l.name) })));
  check('supplying the token activates the lane',
    withTok.v === true && withTok.lanes.includes('edge'), JSON.stringify(withTok));

  console.log('\n--- summary ---');
  console.log('baseline : peak CDN concurrency 6');
  console.log('edge lane: peak CDN concurrency ' + cdn.max + ', peak h2 streams ' + edge.max);

  await page.close(); await browser.close();
  cdnSrv.close(); edgeSrv.close(); appSrv.close();
  fs.writeFileSync(path.join(__dirname, 'edge_lane_result.json'), JSON.stringify({
    noEdge, baselinePeak: 6, on, edgeOk, cdnPeak: cdn.max, edgePeakStreams: edge.max,
    edgeTcpConns: edge.conns, noTok, withTok, results,
  }, null, 2));
  const failed = results.filter(r => !r.pass);
  console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
