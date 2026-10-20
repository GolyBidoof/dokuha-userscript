// test_socket_budget.js — the data-plane socket budget and its profile cap.
//
// Six connections per origin is the per-origin limit, not the only one: a
// Chromium profile also caps its socket pools in total (256 per process in the
// network-stack design doc). Summing 6 per advertised bridge port alone lets a
// 48-port bridge claim 300 sockets, so ~20% of the budget is unreachable and the
// shared pool starts queueing the policy refresh and bridge /health polls behind
// a page burst.
//
// This pins the clamp, and pins that clamping the *budget* never removes a
// *lane*: every discovered port must stay selectable, because the budget only
// decides how many requests to keep in flight.
'use strict';
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

const appSrv = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html><body><div id="viewer"></div></body></html>');
});
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

(async () => {
  const appPort = await listen(appSrv);
  const APP = 'http://127.0.0.1:' + appPort + '/?bwddDebug=1';

  const uscript = loadUserscript();
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();
  page.on('pageerror', e => {
    const s = String(e);
    if (/cookie|SecurityError|not valid JSON/i.test(s)) return;
    console.log('[pageerror]', s.slice(0, 200));
  });

  // A GM lane must exist for the baseline to be 12 rather than 6, and it must be
  // installed before the userscript runs so gmUsable is decided with it present.
  await page.evaluateOnNewDocument(() => {
    window.GM_xmlhttpRequest = function () { /* never called here */ };
  });
  await page.goto(APP);
  await page.addScriptTag({ content: uscript });
  await new Promise(r => setTimeout(r, 300));

  if (!(await page.evaluate(() => !!(window.__bwdd && window.__bwdd.fetchSocketBudget)))) {
    console.log('FAIL: __bwdd hooks missing');
    await browser.close(); appSrv.close(); process.exit(1);
  }

  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
  };

  const readState = () => page.evaluate(() => {
    const b = window.__bwdd;
    const c = b.capabilitySummary();
    return {
      budget: b.fetchSocketBudget(true),
      raw: b.rawSocketBudget(true),
      maxDataPlane: b.MAX_DATA_PLANE_SOCKETS,
      ceiling: b.CHROMIUM_SOCKETS_PER_PROCESS,
      reserve: b.CONTROL_PLANE_SOCKET_RESERVE,
      lanes: b.allLanes(true).map(l => l.name),
      proxyLanes: b.allLanes(true).filter(l => l.kind === 'proxy').length,
      summarySockets: c.sockets,
      summaryRaw: c.rawSockets,
      clamped: c.socketsClamped,
    };
  });

  const addPorts = (n, base) => page.evaluate((n, base) => {
    window.__bwdd.addProxyPorts(
      Array.from({ length: n }, (_, i) => base + i), 'helper');
  }, n, base);
  const clearPorts = () => page.evaluate(() => window.__bwdd.clearProxySource('helper'));

  await clearPorts();
  const base = await readState();
  check('with no bridge the budget is the page and GM lanes',
    base.budget === 12, 'budget = ' + base.budget);
  check('the unclamped sum equals it, so nothing is clamped yet',
    base.raw === base.budget && base.clamped === false,
    'raw = ' + base.raw + ', clamped = ' + base.clamped);

  await addPorts(2, 7100);
  const small = await readState();
  check('a small fan-out is not clamped',
    small.budget === small.raw && small.budget === 6 + 6 + 12,
    'budget = ' + small.budget + ' (raw ' + small.raw + ')');

  await clearPorts();
  await addPorts(48, 7000);
  const big = await readState();
  check('every advertised port still becomes a selectable lane',
    big.proxyLanes === 48, big.proxyLanes + ' proxy lanes');
  check('the per-origin sum ignores the profile ceiling',
    big.raw === 6 + 6 + 48 * 6, 'raw = ' + big.raw);
  check('the budget is clamped to the cap',
    big.budget === big.maxDataPlane,
    'budget = ' + big.budget + ', cap = ' + big.maxDataPlane);
  check('the cap is the profile ceiling minus a control-plane reserve',
    big.maxDataPlane === big.ceiling - big.reserve && big.reserve > 0,
    big.ceiling + ' - ' + big.reserve + ' = ' + big.maxDataPlane);
  check('the clamp is reported so the panel can say so',
    big.clamped === true && big.summaryRaw === big.raw && big.summarySockets === big.budget,
    'summary raw/sockets = ' + big.summaryRaw + '/' + big.summarySockets);

  await clearPorts();
  await addPorts(64, 7200);
  const huge = await readState();
  check('even the 64-port maximum clamps to the same cap',
    huge.budget === huge.maxDataPlane && huge.raw > big.raw,
    'budget = ' + huge.budget + ' for raw ' + huge.raw);

  check('the budget never falls below one origin of sockets',
    huge.budget >= 6 && huge.budget > 0, 'budget = ' + huge.budget);

  await clearPorts();
  const after = await readState();
  check('clearing the discovered ports restores the baseline budget',
    after.budget === 12 && after.clamped === false,
    'budget = ' + after.budget + ', proxy lanes = ' + after.proxyLanes);

  const failed = results.filter(r => !r.pass);
  console.log('\n' + (failed.length ? failed.length + ' FAILED' : 'ALL ' + results.length + ' CHECKS PASSED'));
  fs.writeFileSync(path.join(__dirname, 'socket_budget_result.json'),
    JSON.stringify({ base, small, big, huge, after, results }, null, 2));

  await browser.close();
  appSrv.close();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
