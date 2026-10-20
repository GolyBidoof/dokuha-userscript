// test_bridge_e2e.js — how much concurrency does mokuro-bridge actually buy?
//
// Uses a second bridge instance (test port, upstream = instrumented fake CDN)
// so the peak can be measured precisely, and separately confirms discovery
// against the bridge that is actually running. The shipped script keeps its
// hardcoded http://127.0.0.1:62642; the source is substituted here as a *test
// fixture* only, so the product carries no override hook.
'use strict';
const puppeteer = require('puppeteer');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');
// MOKURO_BRIDGE_DIR lets a checkout elsewhere (this workspace keeps it under
// ~/GitHub) run the benchmark without moving anything.
const BRIDGE = process.env.MOKURO_BRIDGE_DIR || path.join(process.env.HOME, 'Projects', 'mokuro-bridge');
const REAL_PORT = 62642;      // the bridge that is actually running
const TEST_PORT = 63442;      // throwaway instance used for measurement
const N_PORTS = parseInt(process.env.N_PORTS || '48', 10);
const N_REQ = parseInt(process.env.N_REQ || '400', 10);
const DELAY = 300;
const BUF = Buffer.alloc(2048, 7);

const cdn = { cur: 0, max: 0, hits: 0 };
const cdnSrv = http.createServer((req, res) => {
  cdn.cur++; cdn.hits++; if (cdn.cur > cdn.max) cdn.max = cdn.cur;
  setTimeout(() => {
    cdn.cur--;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'image/jpeg');
    res.end(BUF);
  }, DELAY);
});
cdnSrv.maxConnections = 4096;
cdnSrv.on('connection', (s) => s.setNoDelay(true));

const appSrv = https.createServer(
  { key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')) },
  (req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body></body></html>'); });

const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const portBusy = (p) => new Promise(r => {
  const s = net.connect(p, '127.0.0.1');
  s.on('connect', () => { s.destroy(); r(true); });
  s.on('error', () => r(false));
});

(async () => {
  const results = [];
  const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };

  const cdnPort = await listen(cdnSrv);
  const CDN = 'http://127.0.0.1:' + cdnPort;
  const appPort = await listen(appSrv);
  const APP = 'https://127.0.0.1:' + appPort + '/?bwddDebug=1';

  const env = Object.assign({}, process.env, {
    MOKURO_BRIDGE_FETCH_PORTS: String(N_PORTS),
    MOKURO_BRIDGE_FETCH_UPSTREAM: CDN,
    CORS_ORIGINS: 'https://127.0.0.1:' + appPort,
  });
  delete env.UVICORN_RELOAD;

  const log = fs.openSync('/tmp/bridge_e2e.log', 'w');
  const bridge = spawn('python3', ['server.py', '--port', String(TEST_PORT)], {
    cwd: BRIDGE, env, stdio: ['ignore', log, log], detached: true,
  });

  let browser;
  let probe = { ports: [], lanes: [], budget: 0 };
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) { up = await portBusy(TEST_PORT); if (!up) await sleep(500); }
    if (!up) {
      console.error('test bridge never started:\n' + fs.readFileSync('/tmp/bridge_e2e.log', 'utf8').slice(-2500));
      process.exit(1);
    }

    browser = await puppeteer.launch({
      executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const src = fs.readFileSync(US, 'utf8');
    const patched = src.replace("'http://127.0.0.1:62642'", "'http://127.0.0.1:" + TEST_PORT + "'");
    if (patched === src) { console.error('could not substitute the bridge port in the test fixture'); process.exit(1); }

    const page = await browser.newPage();
    page.on('console', m => { const t = m.text(); if (/\[bwdd\] (local fetch proxy|transport lanes)/.test(t)) console.log('   [console] ' + t.slice(0, 170)); });
    await page.goto(APP);
    await page.addScriptTag({ content: patched });
    await sleep(300);
    await page.evaluate((cdn) => {
      const s = window.__bwdd.state;
      s.baseUrl = cdn + '/';
      s.auth = { hti: 'x', Policy: 'p1', Signature: 's1' };
      s.cid = 'bridge-e2e';
    }, CDN);

    probe = await page.evaluate(() => window.__bwdd.probeFetchProxy()
      .then(ports => ({
        ports,
        lanes: window.__bwdd.allLanes().map(l => l.name),
        budget: window.__bwdd.fetchSocketBudget(),
        raw: window.__bwdd.rawSocketBudget(),
        maxDataPlane: window.__bwdd.MAX_DATA_PLANE_SOCKETS,
        profileCeiling: window.__bwdd.CHROMIUM_SOCKETS_PER_PROCESS,
        reserve: window.__bwdd.CONTROL_PLANE_SOCKET_RESERVE,
      })));
    check('userscript discovers all ' + N_PORTS + ' bridge ports via /health',
      probe.ports.length === N_PORTS, probe.ports.length + ' ports (' + probe.ports[0] + '-' + probe.ports[probe.ports.length - 1] + ')');
    check('every bridge port becomes its own browser origin lane',
      probe.lanes.filter(l => l.startsWith('px:')).length === N_PORTS,
      probe.lanes.length + ' lanes total');
    // The per-origin sum (6 per port + the page lane) can exceed what one browser
    // profile may open, so the budget is the smaller of the two. Every lane stays
    // selectable either way; only the concurrency target is clamped.
    check('socket budget is the per-origin sum, capped at the profile ceiling',
      probe.budget === Math.min(probe.raw, probe.maxDataPlane),
      'budget = ' + probe.budget + ' (raw ' + probe.raw + ', cap ' + probe.maxDataPlane + ')');
    check('the cap leaves the control plane a reserved share',
      probe.maxDataPlane === probe.profileCeiling - probe.reserve,
      probe.maxDataPlane + ' = ' + probe.profileCeiling + ' - ' + probe.reserve);
    check('a 48-port bridge is exactly the case the cap exists for',
      N_PORTS !== 48 || probe.raw > probe.budget,
      'raw ' + probe.raw + ' vs budget ' + probe.budget);

    cdn.cur = 0; cdn.max = 0; cdn.hits = 0;
    const t0 = Date.now();
    const ok = await page.evaluate(async (n) => {
      const b = window.__bwdd;
      let done = 0;
      await Promise.all(Array.from({ length: n }, (_, i) =>
        b.cdnFetch(() => b.state.baseUrl + '6_product/abc/1/p' + i + '.jpg?Policy=x&Signature=y', 30000)
          .then(r => r.blob()).then(bl => { if (bl.size > 0) done++; }).catch(() => {})));
      return done;
    }, N_REQ);
    const ms = Date.now() - t0;

    check('every page downloaded', ok === N_REQ, 'ok=' + ok + '/' + N_REQ);
    check('peak CDN concurrency is far beyond 30',
      cdn.max > 30, 'peak = ' + cdn.max + ' concurrent (page-only is 6)');
    check('peak CDN concurrency is close to the full socket budget',
      cdn.max >= probe.budget * 0.85,
      'peak = ' + cdn.max + ' of ' + probe.budget + ' budgeted sockets (' + Math.round(100 * cdn.max / probe.budget) + '%)');

    console.log('\n--- measured ---');
    console.log('ports        : ' + N_PORTS + '  (' + probe.ports[0] + '-' + probe.ports[probe.ports.length - 1] + ')');
    console.log('socket budget: ' + probe.budget);
    console.log('peak at CDN  : ' + cdn.max + ' concurrent');
    console.log('wall time    : ' + ms + 'ms for ' + N_REQ + ' pages of ' + DELAY + 'ms each');
    console.log('throughput   : ' + (N_REQ / (ms / 1000)).toFixed(1) + ' pages/s  (page-only ~= 20/s)');

    await page.close();
  } finally {
    if (browser) await browser.close();
    try { process.kill(-bridge.pid, 'SIGTERM'); } catch (e) { try { bridge.kill('SIGTERM'); } catch (e2) {} }
    await sleep(1500);
    try { process.kill(-bridge.pid, 'SIGKILL'); } catch (e) {}
    fs.closeSync(log);
    cdnSrv.close(); appSrv.close();
  }

  const realHealth = await new Promise((resolve) => {
    http.get('http://127.0.0.1:' + REAL_PORT + '/health', (r) => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
  const realPorts = realHealth && Array.isArray(realHealth.fetchProxyPorts) ? realHealth.fetchProxyPorts : [];
  check('the running bridge on 62642 advertises its ports too',
    realPorts.length > 0, 'live bridge: ' + realPorts.length + ' ports, ' + (6 * realPorts.length + 6) + ' sockets');

  const failed = results.filter(r => !r.pass);
  fs.writeFileSync(path.join(__dirname, 'bridge_e2e_result.json'),
    JSON.stringify({ nPorts: N_PORTS, probe, cdnPeak: cdn.max, nReq: N_REQ, realPorts: realPorts.length, results }, null, 2));
  console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
