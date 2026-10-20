// test_dot_lane.js — the trailing-dot lane must (a) switch itself on when the
// server serves the dotted host, (b) stay OFF when the server rejects it, and
// (c) actually give a separate 6-socket pool when it is on.
'use strict';
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');
const DELAY = 300;
const BUF = Buffer.alloc(1024, 4);

let mode = 'ok';                     // 'ok' | 'reject'
const perHost = new Map();           // 'localhost' vs 'localhost.'

const srv = http.createServer((req, res) => {
  const host = (req.headers.host || '?').split(':')[0];
  const st = perHost.get(host) || { cur: 0, max: 0, hits: 0 };
  perHost.set(host, st);
  st.cur++; st.hits++; if (st.cur > st.max) st.max = st.cur;
  const dotted = host.endsWith('.');
  setTimeout(() => {
    st.cur--;
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (dotted && mode === 'reject') {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/html');
      return res.end('<html>403</html>');
    }
    res.setHeader('Content-Type', 'image/png');
    res.end(BUF);
  }, DELAY);
});

const appSrv = https.createServer(
  { key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')) },
  (req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body></body></html>'); });

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

(async () => {
  const P = await listen(srv);
  const APP = 'https://127.0.0.1:' + (await listen(appSrv)) + '/?bwddDebug=1';
  // 'localhost' is used because 'localhost.' is a valid FQDN that resolves to
  // the same interface — exactly the host/host. relationship we are testing.
  const BASE = 'http://localhost:' + P + '/';
  const uscript = loadUserscript();

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'],
  });

  const results = [];
  const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };

  async function freshPage() {
    const p = await browser.newPage();
    p.on('pageerror', e => { const s = String(e); if (!/cookie|SecurityError|not valid JSON/i.test(s)) console.log('[pageerror]', s.slice(0, 140)); });
    await p.setRequestInterception(true);
    p.on('request', (r) => {
      const u = r.url();
      if (/bookwalker\.jp/.test(u) && !u.startsWith('http://127.0.0.1')) return r.abort();
      r.continue();
    });
    await p.goto(APP);
    await p.addScriptTag({ content: uscript });
    await new Promise(r => setTimeout(r, 250));
    await p.evaluate((base) => {
      const s = window.__bwdd.state;
      s.baseUrl = base;
      s.auth = { hti: 'x', Policy: 'p1', Signature: 's1' };
      s.cid = 'dot-test';
    }, BASE);
    return p;
  }

  mode = 'ok'; perHost.clear();
  let page = await freshPage();
  const enabled = await page.evaluate((base) => window.__bwdd.probeDotLane(base + 'probe.png'), BASE);
  const lanesAfter = await page.evaluate(() => window.__bwdd.allLanes().map(l => l.name));
  check('probe enables the lane when the CDN serves the dotted host',
    enabled === true, 'probeDotLane → ' + enabled);
  check('dot lane joins the pool', lanesAfter.includes('dot'),
    JSON.stringify(lanesAfter));
  const budget = await page.evaluate(() => window.__bwdd.fetchSocketBudget());
  check('socket budget counts the dot lane',
    budget === 6 * lanesAfter.length,
    'budget = ' + budget + ' for ' + lanesAfter.length + ' lane(s) ' + JSON.stringify(lanesAfter));
  perHost.clear();
  const okCount = await page.evaluate(async (base) => {
    const b = window.__bwdd;
    let ok = 0;
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      b.cdnFetch(() => base + 'p' + i + '.png', 10000)
        .then(r => r.blob()).then(bl => { if (bl.size > 0) ok++; }).catch(() => {})));
    return ok;
  }, BASE);
  const bare = perHost.get('localhost') || { max: 0, hits: 0 };
  const dotted = perHost.get('localhost.') || { max: 0, hits: 0 };
  check('every request succeeds with the dot lane active', okCount === 12, 'ok=' + okCount + '/12');
  check('traffic really is split across both host spellings',
    bare.hits > 0 && dotted.hits > 0, 'bare=' + bare.hits + ' dotted=' + dotted.hits);
  check('the dotted host gets its own 6-socket pool',
    bare.max === 6 && dotted.max === 6,
    'peak bare=' + bare.max + ' dotted=' + dotted.max + ' (6/6 = separate pools)');
  await page.close();

  mode = 'reject'; perHost.clear();
  page = await freshPage();
  const rejected = await page.evaluate((base) => window.__bwdd.probeDotLane(base + 'probe.png'), BASE);
  const lanesRej = await page.evaluate(() => window.__bwdd.allLanes().map(l => l.name));
  check('probe leaves the lane OFF when the CDN rejects it',
    rejected === false, 'probeDotLane → ' + rejected);
  check('a rejected dot lane is not added to the pool',
    !lanesRej.includes('dot'), JSON.stringify(lanesRej));
  const stillOk = await page.evaluate(async (base) => {
    const b = window.__bwdd;
    let ok = 0;
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      b.cdnFetch(() => base + 'r' + i + '.png', 10000)
        .then(r => r.blob()).then(bl => { if (bl.size > 0) ok++; }).catch(() => {})));
    return ok;
  }, BASE);
  check('a rejected dot lane does not break downloads',
    stillOk === 8, 'ok=' + stillOk + '/8 (all via the page lane)');

  console.log('\n--- summary ---');
  console.log('accepted: bare=' + bare.hits + ' dotted=' + dotted.hits +
    ' peaks ' + bare.max + '/' + dotted.max);
  console.log('rejected: lane off, 8/8 still served');

  await page.close(); await browser.close(); srv.close(); appSrv.close();
  const failed = results.filter(r => !r.pass);
  fs.writeFileSync(path.join(__dirname, 'dot_lane_result.json'), JSON.stringify({
    enabled, lanesAfter, bare: { hits: bare.hits, max: bare.max }, dotted: { hits: dotted.hits, max: dotted.max },
    rejected, lanesRej, stillOk, results,
  }, null, 2));
  console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
