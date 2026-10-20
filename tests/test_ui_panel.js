// test_ui_panel.js — the panel's format picker and the pre-flight indicator.
//
// Uses a stand-in bridge so the ON state is deterministic, and a dead port for
// the OFF state. The script's hardcoded bridge URL is substituted as a test
// fixture only — the shipped file keeps http://127.0.0.1:62642.
'use strict';
const puppeteer = require('puppeteer');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');
const UP = 63842, DEAD = 63899, NPORTS = 12;

const ports = Array.from({ length: NPORTS }, (_, i) => UP + 1 + i);
const bridge = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url.startsWith('/__bwdd_health')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ bwddFetchProxy: true, portList: ports }));
  }
  if (req.url.startsWith('/health')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ app: 'mokuro-bridge', status: 'ok', output_dir: '/tmp/out', upload_methods: [], upload_method_default: 'local', fetchProxyPorts: ports }));
  }
  if (req.url.startsWith('/upload-methods')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ methods: [{ id: 'local', name: 'Local' }], upload_method_default: 'local' }));
  }
  res.statusCode = 404; res.end('nope');
});

const appSrv = https.createServer(
  { key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')) },
  (req, res) => { res.setHeader('Content-Type','text/html'); res.end('<html><body></body></html>'); });
const listen = (s, p) => new Promise((r, j) => s.listen(p || 0, '127.0.0.1', () => r(s.address().port)).on('error', j));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await listen(bridge, UP);
  const appPort = await listen(appSrv);
  const APP = 'https://127.0.0.1:' + appPort + '/?bwddDebug=1';
  const src = fs.readFileSync(US, 'utf8');
  const fileVersion = (src.match(/@version\s+([0-9.]+)/) || [])[1];
  const results = [];
  const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass?'PASS  ':'FAIL  ')+n+'  — '+d); };

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--ignore-certificate-errors',
    // Store hosts resolve to the local server so the reader gate can be proved
    // against the real host names without a live session.
    '--host-resolver-rules=MAP viewer.bookwalker.jp 127.0.0.1, MAP bookwalker.jp 127.0.0.1, MAP ebookjapan.yahoo.co.jp 127.0.0.1'] });

  async function loadPanel(bridgePort, fmt, quality) {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0,180)));
    await page.evaluateOnNewDocument((bp, f, q) => {
      try { localStorage.clear();
        if (f) localStorage.setItem('bwddImageFormat', f);
        if (q) localStorage.setItem('bwddImageQuality', q);
      } catch (e) {}
    }, bridgePort, fmt, quality);
    await page.goto(APP);
    const patched = src.replace("'http://127.0.0.1:62642'", "'http://127.0.0.1:" + bridgePort + "'");
    if (patched === src) throw new Error('bridge URL substitution failed');
    await page.addScriptTag({ content: patched });
    await sleep(900);   // let the first bridge poll + port discovery settle
    return page;
  }

  let page = await loadPanel(UP);
  const on = await page.evaluate(() => {
    const root = document.querySelector('.bwdd-bridge-anchor .bwdd-caps-line');
    const fmt = document.querySelector('#bwdd-image-format');
    const q = document.querySelector('#bwdd-image-quality');
    return {
      hasCaps: !!root,
      capsText: root ? root.textContent : null,
      bodyHasCapsRow: !!document.querySelector('#bwdd-body .bwdd-caps'),
      capsPopHidden: !!document.querySelector('.bwdd-bridge-anchor .bwdd-bridge-pop[hidden]'),
      capsDotLabelled: !!document.querySelector('.bwdd-bridge-anchor .bwdd-info-dot[aria-label]'),
      connSection: (() => {
        const pop = document.querySelector('.bwdd-bridge-anchor .bwdd-bridge-pop');
        if (!pop) return null;
        const secs = [...pop.querySelectorAll('.bwdd-bridge-info-section')];
        const conn = secs.find(x => /Connection speed/i.test(x.textContent));
        return conn ? conn.textContent.replace(/\s+/g,' ').trim() : null;
      })(),
      capsDotCount: document.querySelectorAll('.bwdd-caps .bwdd-info-dot').length,
      anchorDotCount: document.querySelectorAll('.bwdd-bridge-anchor .bwdd-info-dot').length,
      fmtOpen: !!(document.querySelector('.bwdd-fmt') || {}).open,
      fmtSummary: (document.querySelector('.bwdd-fmt-summary') || {}).textContent || null,
      capsClass: root && root.closest('.bwdd-bridge-info-section') ? root.closest('.bwdd-bridge-info-section').className : null,
      hasFmt: !!fmt, opts: fmt ? [...fmt.options].map(o=>o.value) : null, fmtVal: fmt ? fmt.value : null,
      qVisible: q ? getComputedStyle(q.closest('.bwdd-opt-row')).display !== 'none' : null,
      summary: window.__bwddUI && window.__bwddUI.capabilitySummary ? window.__bwddUI.capabilitySummary() : null,
      expectedWorkers: Math.min(Math.max(4, navigator.hardwareConcurrency || 8), 16),
      codec: window.__bwdd.imageCodec,
    };
  });
  check('the readout is hidden in the "?" popover, not the panel body',
    on.hasCaps === true && on.bodyHasCapsRow === false,
    `inPopover=${on.hasCaps} standaloneRow=${on.bodyHasCapsRow}`);

  await page.evaluate(() => { const d = document.querySelector('.bwdd-fmt'); if (d) d.open = true; });
  const layout = await page.evaluate(() => {
    const r = (sel) => { const e = document.querySelector(sel); if (!e) return null;
      const b = e.getBoundingClientRect(); return { x:b.x, y:b.y, w:b.width, h:b.height, disp:getComputedStyle(e).display }; };
    const fmt = r('#bwdd-image-format'), q = r('#bwdd-image-quality'),
          acts = r('.bwdd-actions'), root = r('.bwdd-root') || r('#bwdd-root');
    const panelRight = root ? root.x + root.w : Infinity;
    const overflow = [fmt, q, acts].filter(b => b && (b.x + b.w > panelRight + 1 || b.w <= 0 || b.h <= 0));
    return { fmt, q, acts, overflow: overflow.length,
             fmtAboveActions: !!(fmt && acts && fmt.y + fmt.h <= acts.y) };
  });
  check('every control has real size and fits inside the panel',
    layout.overflow === 0 && layout.fmt && layout.fmt.w > 0 && layout.fmt.h > 18,
    `overflow=${layout.overflow} format=${layout.fmt && Math.round(layout.fmt.w)}x${layout.fmt && Math.round(layout.fmt.h)}`);
  check('the (expanded) format control sits above the action buttons',
    layout.fmtAboveActions,
    `fmt.y=${layout.fmt && Math.round(layout.fmt.y)} actions.y=${layout.acts && Math.round(layout.acts.y)}`);
  check('it reports the bridge ports it found', on.summary && on.summary.ports === NPORTS,
    `ports=${on.summary && on.summary.ports} sockets=${on.summary && on.summary.sockets} workers=${on.summary && on.summary.workers}`);
  check('it shows ports, sockets and workers on one short line',
    /12 ports/.test(on.capsText||'') && /78 sockets/.test(on.capsText||'') &&
      (on.capsText || '').includes(on.expectedWorkers + ' workers'),
    JSON.stringify(on.capsText));
  check('the connection reasoning sits under the bridge row\u2019s single "?"',
    on.capsPopHidden === true && on.capsDotLabelled === true && /Connection speed/i.test(on.connSection||''),
    `hidden=${on.capsPopHidden} sections=${JSON.stringify((on.connSection||'').slice(0,60))}`);
  check('the caps row no longer carries its own "?"',
    on.capsDotCount === 0 && on.anchorDotCount === 1,
    `caps dots=${on.capsDotCount}, bridge-anchor dots=${on.anchorDotCount}`);
  check('advanced image settings are collapsed by default',
    on.fmtOpen === false && /JPEG/i.test(on.fmtSummary||'') && /0\.92/.test(on.fmtSummary||''),
    `open=${on.fmtOpen} summary=${JSON.stringify(on.fmtSummary)}`);
  check('sockets = 6 per port + the page lane', on.summary && on.summary.sockets === 6*(1+NPORTS),
    `sockets=${on.summary && on.summary.sockets}`);
  check('with the bridge up it promises the full budget',
    on.summary && on.summary.bridgeOnline === true && on.summary.effectiveSockets === 6*(1+NPORTS),
    `effective=${on.summary && on.summary.effectiveSockets}`);
  check('workers matches the batched pool the run will spawn',
    on.summary && on.summary.workers === on.expectedWorkers,
    `workers=${on.summary && on.summary.workers} expected=${on.expectedWorkers}`);
  check('bridge-on state is styled as active', on.capsClass && on.capsClass.includes('on'), on.capsClass);

  const gh = await page.$('.bwdd-gh');
  const ghBox = gh && await gh.boundingBox();
  await page.evaluate(() => {
    window.__ghClickCount = 0;
    const link = document.querySelector('.bwdd-gh');
    link.addEventListener('click', (e) => { window.__ghClickCount++; e.preventDefault(); });
  });
  if (ghBox) await page.mouse.click(ghBox.x + ghBox.width / 2, ghBox.y + ghBox.height / 2);
  const ghState = await page.evaluate(() => {
    const link = document.querySelector('.bwdd-gh');
    return { clicks: window.__ghClickCount, href: link && link.href, target: link && link.target };
  });
  check('the header GitHub link is clickable and opens the repository target',
    ghBox && ghState.clicks === 1 && ghState.href === 'https://github.com/GolyBidoof/dokuha-userscript' && ghState.target === '_blank',
    JSON.stringify(ghState));

  check('format picker exists with all four choices',
    on.hasFmt && JSON.stringify(on.opts) === JSON.stringify(['jpeg','webp','lossless','png']), JSON.stringify(on.opts));
  check('defaults to jpeg', on.fmtVal === 'jpeg' && on.codec.fmt === 'jpeg', `select=${on.fmtVal} codec=${on.codec.fmt}`);
  check('quality control is shown for a lossy format', on.qVisible === true, 'quality row visible');

  const lossless = await page.evaluate(() => {
    const before = window.__bwdd.imageCodec.fmt;
    const sel = document.querySelector('#bwdd-image-format');
    sel.value = 'lossless';
    sel.dispatchEvent(new Event('change'));
    const q = document.querySelector('#bwdd-image-quality');
    return {
      before, after: window.__bwdd.imageCodec,
      stored: localStorage.getItem('bwddImageFormat'),
      qHidden: getComputedStyle(q.closest('.bwdd-opt-row')).display === 'none',
      batch: window.__bwdd.workerBatchSize(window.__bwdd.imageCodec.type),
      decodePages: window.__bwddUI.capabilitySummary().decodePages,
    };
  });
  check('choosing Lossless updates the live codec without a reload',
    lossless.after.fmt === 'lossless' && lossless.after.lossless === true, `${lossless.before} -> ${lossless.after.fmt}`);
  check('it persists the choice', lossless.stored === 'lossless', 'localStorage=' + lossless.stored);
  check('quality is hidden for lossless', lossless.qHidden === true, 'quality row hidden');
  check('codec-specific worker batching is reflected in the capability summary',
    lossless.batch === 1 && lossless.decodePages === on.expectedWorkers,
    `batch=${lossless.batch} decodePages=${lossless.decodePages}`);

  const q85 = await page.evaluate(() => {
    document.querySelector('#bwdd-image-format').value = 'jpeg';
    document.querySelector('#bwdd-image-format').dispatchEvent(new Event('change'));
    const q = document.querySelector('#bwdd-image-quality');
    q.value = '0.85'; q.dispatchEvent(new Event('change'));
    return { codec: window.__bwdd.imageCodec, stored: localStorage.getItem('bwddImageQuality'),
             qBack: getComputedStyle(q.closest('.bwdd-opt-row')).display !== 'none' };
  });
  check('changing quality applies to the live codec',
    q85.codec.quality === 0.85 && q85.codec.fmt === 'jpeg', `q=${q85.codec.quality} fmt=${q85.codec.fmt}`);
  check('quality control comes back for jpeg', q85.qBack === true, 'quality row visible again');
  await page.close();

  page = await loadPanel(DEAD);
  const off = await page.evaluate(() => {
    const root = document.querySelector('.bwdd-bridge-anchor .bwdd-caps-line');
    return {
      text: root.textContent.replace(/\s+/g,' ').trim(),
      cls: root.closest('.bwdd-bridge-info-section').className,
      summary: window.__bwddUI.capabilitySummary(),
    };
  });
  check('with the bridge off it still reports workers and sockets',
    off.summary.workers >= 4 && off.summary.sockets === 6,
    `sockets=${off.summary.sockets} workers=${off.summary.workers}`);
  check('it says so explicitly rather than showing nothing',
    /no bridge/i.test(off.text) && /6 sockets/i.test(off.text),
    off.text.slice(0, 160));
  check('bridge-off state is styled as inactive', off.cls.includes('off'), off.cls);
  // Regression: bridgeHealth() forgives misses, so a cold load with no bridge
  // used to advertise "online" for the first few polls while the socket readout
  // already said otherwise. The two must agree.
  const rowSays = await page.evaluate(() =>
    (document.querySelector('.bwdd-bridge-anchor .bwdd-bridge-text') || {}).textContent || '');
  check('the bridge row does not claim online when the readout says otherwise',
    rowSays.length > 0 && /not found on port/i.test(rowSays) && !/online/i.test(rowSays),
    JSON.stringify(rowSays.slice(0, 90)));
  const offPop = await page.evaluate(() => {
    const dot = document.querySelector('.bwdd-bridge-anchor .bwdd-info-dot');
    const pop = document.querySelector('.bwdd-bridge-anchor .bwdd-bridge-pop');
    if (!dot || !pop) return null;
    dot.click();
    const secs = [...pop.querySelectorAll('.bwdd-bridge-info-section')]
      .map(x => x.textContent.replace(/\s+/g,' ').trim());
    return { opened: !pop.hidden, conn: secs.find(t => /Connection speed/i.test(t)) || null };
  });
  check('the "?" still opens with the bridge off, and explains the connection',
    !!(offPop && offPop.opened && /Connection speed/i.test(offPop.conn||'')),
    offPop ? JSON.stringify((offPop.conn||'').slice(0,80)) : 'no popover');
  check('the format picker still works with no bridge', 
    await page.evaluate(() => !!document.querySelector('#bwdd-image-format')), 'present');
  await page.close();

  page = await loadPanel(DEAD);
  const before = await page.evaluate(() => window.__bwddUI.capabilitySummary().ports);
  // swap the bridge onto the port the page is watching: restart on DEAD
  await new Promise(r => bridge.close(r));
  await listen(bridge, DEAD);
  await page.evaluate(() => new Promise(r => setTimeout(r, 11000)));  // one poll cycle
  const after = await page.evaluate(() => ({ ports: window.__bwddUI.capabilitySummary().ports,
                                             text: document.querySelector('.bwdd-bridge-anchor .bwdd-caps-line').textContent.replace(/\s+/g,' ').trim() }));
  check('ports light up when the bridge starts after page load',
    before === 0 && after.ports === NPORTS, `ports ${before} -> ${after.ports}`);
  check('the indicator text updates too', /12 ports/.test(after.text), after.text.slice(0,120));

  await new Promise(r => bridge.close(r));
  await page.evaluate(() => new Promise(r => setTimeout(r, 11000)));
  const gone = await page.evaluate(() => ({
    s: window.__bwddUI.capabilitySummary(),
    text: document.querySelector('.bwdd-bridge-anchor .bwdd-caps-line').textContent.replace(/\s+/g,' ').trim(),
    cls: document.querySelector('.bwdd-bridge-anchor .bwdd-caps-line').closest('.bwdd-bridge-info-section').className,
  }));
  check('a bridge that dies stops being counted as available',
    gone.s.bridgeOnline === false && gone.s.ports === 0 && gone.s.effectiveSockets === 6,
    `online=${gone.s.bridgeOnline} ports=${gone.s.ports} effective=${gone.s.effectiveSockets}`);
  const gonePop = await page.evaluate(() => {
    const secs = [...document.querySelectorAll('.bwdd-bridge-anchor .bwdd-bridge-pop .bwdd-bridge-info-section')]
      .map(x => x.textContent.replace(/\s+/g,' ').trim());
    return secs.find(t => /Connection speed/i.test(t)) || '';
  });
  check('and it explains the fallback rather than silently changing',
    /not (?:reachable now|running)/i.test(gonePop) && gone.cls.includes('off'),
    gonePop.slice(0, 150) || gone.text.slice(0,120));
  await page.close();


  // BWDD_VERSION was pinned at a literal and went stale for four releases, so the
  // panel claimed an old version no matter what was installed. Pin it down.
  {
    const vp = await browser.newPage();
    await vp.evaluateOnNewDocument(() => {
      try { localStorage.clear(); } catch (e) {}
      window.GM_info = { script: { version: '9.9.9-sentinel' } };
    });
    await vp.goto(APP);
    await vp.addScriptTag({ content: src.replace("'http://127.0.0.1:62642'", "'http://127.0.0.1:" + UP + "'") });
    await sleep(400);
    const shown = await vp.evaluate(() => (document.querySelector('.bwdd-subtitle') || {}).textContent || '');
    check('the panel shows the version the userscript manager reports',
      shown.includes('9.9.9-sentinel'), JSON.stringify(shown));
    check('the panel actually has both new controls mounted in its body',
      await vp.evaluate(() => {
        const body = document.querySelector('#bwdd-body');
        return !!(body && body.querySelector('.bwdd-bridge-anchor .bwdd-caps-line') &&
                  body.querySelector('#bwdd-image-format') && !body.querySelector('.bwdd-caps'));
      }), 'caps + format picker are children of #bwdd-body');
    await vp.close();
  }
  {
    const vp = await browser.newPage();
    await vp.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
    await vp.goto(APP);
    await vp.addScriptTag({ content: src.replace("'http://127.0.0.1:62642'", "'http://127.0.0.1:" + UP + "'") });
    await sleep(400);
    const shown = await vp.evaluate(() => (document.querySelector('.bwdd-subtitle') || {}).textContent || '');
    check('with no GM_info the fallback matches @version in the file',
      shown.includes(fileVersion), `panel=${JSON.stringify(shown)} file=@version ${fileVersion}`);
    await vp.close();
  }

  // The reader gate: only a reader page selects an adapter and gets the panel.
  // A storefront page now runs nothing at all - no adapter, no panel, no debug
  // surface - instead of the old panelAllowed() behaviour, which kept the
  // adapter installed behind a hidden panel. The unclaimed host this file
  // otherwise uses is deliberately outside the gate, so every check above still
  // runs against the fallback panel.
  {
    const patched = src.replace("'http://127.0.0.1:62642'", "'http://127.0.0.1:" + UP + "'");
    async function probeHost(url) {
      const p = await browser.newPage();
      p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0,180)));
      await p.evaluateOnNewDocument(() => {
        try { localStorage.clear(); } catch (e) {}
        window.__origFetch = window.fetch;
      });
      await p.goto(url);
      await p.addScriptTag({ content: patched });
      await sleep(700);
      const out = await p.evaluate(() => ({
        site: window.__bwddSite && window.__bwddSite.id,
        panel: !!document.querySelector('#bwdd-root'),
        zip: !!document.querySelector('button.bwdd-btn.zip'),
        debug: !!(window.__bwdd || window.__bwddSite || window.__bwddUI),
        fetchWrapped: window.fetch !== window.__origFetch,
      }));
      await p.close();
      return out;
    }
    const bwStore = await probeHost('https://bookwalker.jp:' + appPort + '/series/900002/list/?bwddDebug=1');
    check('a BookWalker series page selects no adapter and paints no panel',
      bwStore.site === undefined && bwStore.panel === false && bwStore.zip === false &&
      bwStore.debug === false,
      `site=${bwStore.site} panel=${bwStore.panel} zip=${bwStore.zip} debug=${bwStore.debug}`);
    // The /de<uuid> detail page is the one the headless CLI is injected into. A
    // normal page load there is not a reader either, so it must select nothing;
    // the headless claim is covered by test_site_dispatch.js.
    const bwDetail = await probeHost('https://bookwalker.jp:' + appPort + '/decf5c400b-42c7-4c7f-af26-7181721d9f5e/?bwddDebug=1');
    check('a BookWalker /de<uuid> detail page selects no adapter and paints no panel',
      bwDetail.site === undefined && bwDetail.panel === false && bwDetail.zip === false &&
      bwDetail.debug === false,
      `site=${bwDetail.site} panel=${bwDetail.panel} zip=${bwDetail.zip} debug=${bwDetail.debug}`);
    const bwViewer = await probeHost('https://viewer.bookwalker.jp:' + appPort + '/deno/1/1/1/?cid=abc123&bwddDebug=1');
    check('the BookWalker viewer still gets the panel',
      bwViewer.site === 'bookwalker' && bwViewer.panel === true && bwViewer.zip === true,
      `site=${bwViewer.site} panel=${bwViewer.panel} zip=${bwViewer.zip}`);
    const ejBooks = await probeHost('https://ebookjapan.yahoo.co.jp:' + appPort + '/books/716241/A001624701/?bwddDebug=1');
    check('an ebookjapan /books/ volume page selects no adapter and paints no panel',
      ejBooks.site === undefined && ejBooks.panel === false && ejBooks.zip === false &&
      ejBooks.debug === false,
      `site=${ejBooks.site} panel=${ejBooks.panel} zip=${ejBooks.zip} debug=${ejBooks.debug}`);
    const ejViewer = await probeHost('https://ebookjapan.yahoo.co.jp:' + appPort + '/viewer/free/A000000001/?bwddDebug=1');
    check('the ebookjapan viewer still gets the panel',
      ejViewer.site === 'ebookjapan' && ejViewer.panel === true && ejViewer.zip === true,
      `site=${ejViewer.site} panel=${ejViewer.panel} zip=${ejViewer.zip}`);
  }

  // The panel's own form controls are self-sufficient: a store stylesheet aimed
  // at generic input/select elements must not move them. The hostile sheet is
  // proved live on a plain host input in the same page, so the comparison cannot
  // pass by the sheet simply not matching anything.
  {
    const HOSTILE = `
      html body input[type="text"], html body input:not([type]), html body select, html body textarea {
        height: 54px;
        min-height: 54px;
        line-height: 3.2;
        padding: 14px 18px;
        margin: 9px 0;
        box-sizing: content-box;
        background: #fde68a;
        color: #fde68a;
        border: 4px dotted #dc2626;
        border-radius: 0;
        font-family: "Comic Sans MS", cursive;
        font-size: 21px;
        appearance: textfield;
        -webkit-appearance: textfield;
      }`;
    const PROPS = ['height','minHeight','lineHeight','paddingTop','paddingBottom','paddingLeft','paddingRight',
      'boxSizing','backgroundColor','color','borderTopWidth','borderTopStyle','borderTopColor',
      'fontFamily','fontSize','fontStyle','fontWeight','appearance','width'];
    async function controlStyles(hostile) {
      const p = await browser.newPage();
      p.on('pageerror', e => console.log('[pageerror]', String(e).slice(0,180)));
      await p.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch (e) {} });
      await p.goto(APP);
      if (hostile) {
        await p.evaluate(() => {
          const probe = document.createElement('input');
          probe.type = 'text';
          probe.id = 'hostile-probe';
          document.body.appendChild(probe);
        });
        await p.addStyleTag({ content: hostile });
      }
      await p.addScriptTag({ content: src.replace("'http://127.0.0.1:62642'", "'http://127.0.0.1:" + UP + "'") });
      await sleep(700);
      const out = await p.evaluate((props) => {
        const read = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          const o = {};
          for (const k of props) o[k] = cs[k];
          return o;
        };
        // The palette is light or dark depending on the environment, so read
        // the tokens the panel actually resolved instead of hard-coding either.
        let tokens = null;
        const root = document.querySelector('#bwdd-root');
        if (root) {
          const probe = document.createElement('span');
          probe.style.cssText = 'position:absolute;background:var(--bwdd-bg);' +
            'color:var(--bwdd-root-fg);border:1px solid var(--bwdd-border-strong)';
          root.appendChild(probe);
          const ps = getComputedStyle(probe);
          tokens = { bg: ps.backgroundColor, fg: ps.color, border: ps.borderTopColor };
          probe.remove();
        }
        return { name: read('#bwdd-archive-name'), fmt: read('#bwdd-image-format'),
                 probe: read('#hostile-probe'), tokens };
      }, PROPS);
      await p.close();
      return out;
    }
    const clean = await controlStyles(null);
    const hostile = await controlStyles(HOSTILE);

    check('the archive-name field has a real, bounded height',
      !!clean.name && parseFloat(clean.name.height) > 20 && parseFloat(clean.name.height) < 34,
      `height=${clean.name && clean.name.height}`);
    check('the field is border-box, 12px, and wears the panel colours and border',
      !!clean.name && !!clean.tokens && clean.name.boxSizing === 'border-box' &&
        clean.name.fontSize === '12px' &&
        clean.name.borderTopWidth === '1px' && clean.name.borderTopStyle === 'solid' &&
        clean.name.backgroundColor === clean.tokens.bg && clean.name.color === clean.tokens.fg &&
        clean.name.borderTopColor === clean.tokens.border,
      JSON.stringify(clean.name));
    check('a text input does not keep the platform appearance',
      !!clean.name && clean.name.appearance === 'none', `appearance=${clean.name && clean.name.appearance}`);
    check('the hostile stylesheet is live on a plain host input',
      !!hostile.probe && hostile.probe.backgroundColor === 'rgb(253, 230, 138)' &&
        parseFloat(hostile.probe.height) >= 54 && /Comic Sans/i.test(hostile.probe.fontFamily),
      JSON.stringify(hostile.probe));
    check('the hostile stylesheet cannot move the archive-name field',
      JSON.stringify(clean.name) === JSON.stringify(hostile.name),
      `clean=${JSON.stringify(clean.name)} hostile=${JSON.stringify(hostile.name)}`);
    check('the same reset holds the panel selects and the other text input',
      !!clean.fmt && !!hostile.fmt && !!clean.tokens &&
        JSON.stringify(clean.fmt) === JSON.stringify(hostile.fmt) &&
        clean.fmt.boxSizing === 'border-box' && clean.fmt.fontSize === '12px' &&
        clean.fmt.backgroundColor === clean.tokens.bg,
      `hostile=${JSON.stringify(hostile.fmt)}`);
  }

  await browser.close(); appSrv.close(); bridge.close();
  const failed = results.filter(r=>!r.pass);
  fs.writeFileSync(path.join(__dirname,'ui_panel_result.json'), JSON.stringify({results},null,2));
  console.log(failed.length ? '\n'+failed.length+' FAILED' : '\nALL '+results.length+' CHECKS PASSED');
  process.exit(failed.length?1:0);
})().catch(e=>{ console.error('FATAL', e); process.exit(1); });
