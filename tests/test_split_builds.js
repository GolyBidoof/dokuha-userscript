// test_split_builds.js — the per-store artifacts really are independent.
//
// Asserts, for every target in src/targets.json:
//   1. its metadata claims exactly its own store (name, @match, @connect), and
//      its @match list is a reader-URL allowlist only: a storefront, series,
//      title or product URL in any artifact fails the suite;
//   2. it contains no fragment from a module it does not include;
//   3. booted in a browser it selects the right adapter on the readers, selects
//      no adapter at all on a storefront page of the store it carries, and the
//      other store's internals are absent from window.__bwdd — the functional
//      proof that the two scripts do not intersect;
//   4. with window.__BWDD_HEADLESS__ set before injection it still claims the
//      product pages the CLI injects into (BookWalker /de<uuid>/, ebookjapan
//      /books/<id>/<code>/) and claims nothing else.
'use strict';
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const TARGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/targets.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/manifest.json'), 'utf8'));
// The bundles are comment-stripped, so a leak is detected against each source
// fragment's stripped form — the same bytes build.mjs emits.
const { stripSource } = require('../tools/strip-comments.js');

const results = [];
const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The store modules in the order the registry loads them. detectSite() is
// first-match-wins over this order, so "which store does this artifact carry"
// and "which store wins a shared host" are both read off it rather than from a
// hand-written if/else that has to be extended for every new store.
const STORE_MODULES = [
  ['sites/bookwalker', 'bookwalker'],
  ['sites/cmoa', 'cmoa'],
  ['sites/ebookjapan', 'ebookjapan'],
  ['sites/kindle', 'kindle'],
  ['sites/kmanga', 'kmanga'],
];

// The only URLs a store module may claim. The script now loads only on the
// reader, so a storefront or series URL in any @match list is a regression and
// must fail here rather than surface as a dead panel on a product page.
const READER_MATCHES = {
  bookwalker: [
    'https://viewer.bookwalker.jp/*',
    'https://viewer-trial.bookwalker.jp/*',
    'https://viewer-ptrial.bookwalker.jp/*',
    'https://viewer-subscription.bookwalker.jp/*',
  ],
  cmoa: [
    'https://www.cmoa.jp/bib/speedreader/*',
    'https://www.cmoa.jp/reader/*',
  ],
  ebookjapan: ['https://ebookjapan.yahoo.co.jp/viewer/*'],
  kindle: ['https://read.amazon.co.jp/manga/*'],
  kmanga: ['https://comic.k-manga.jp/viewer/*'],
};

// Names the pages that only lead up to the reader. Kept as a separate pattern
// so a failure says "storefront URL" instead of just "list differs".
const STOREFRONT_MATCH = /\/series\/|\/de[0-9a-f]{8}-|www\.cmoa\.jp\/title\/|ebookjapan\.yahoo\.co\.jp\/books\/|read\.amazon\.co\.jp\/(?!manga\/)|comic\.k-manga\.jp\/(?!viewer\/)/;

// Hosts booted in a browser. `reader` marks the pages that must select their
// adapter; the rest are store pages on the store's own host, which must select
// nothing at all. `store` is the adapter that owns the host, whether or not
// this artifact carries it.
const EXPECT = [
  { host: 'viewer.bookwalker.jp', store: 'bookwalker', reader: true },
  { host: 'www.cmoa.jp', path: '/bib/speedreader/', store: 'cmoa', reader: true },
  { host: 'ebookjapan.yahoo.co.jp', path: '/viewer/free/A000000001/', store: 'ebookjapan', reader: true },
  { host: 'read.amazon.co.jp', path: '/manga/B000000001', store: 'kindle', reader: true },
  { host: 'comic.k-manga.jp', path: '/viewer/pc/viewer.html', store: 'kmanga', reader: true },
  { host: 'bookwalker.jp', path: '/series/900002/list/', store: 'bookwalker', reader: false },
  { host: 'bookwalker.jp', path: '/decf5c400b-42c7-4c7f-af26-7181721d9f5e/', store: 'bookwalker', reader: false },
  { host: 'www.cmoa.jp', path: '/title/100001/', store: 'cmoa', reader: false },
  { host: 'ebookjapan.yahoo.co.jp', path: '/books/716241/A001624701/', store: 'ebookjapan', reader: false },
  { host: 'read.amazon.co.jp', path: '/dp/B000000001', store: 'kindle', reader: false },
  { host: 'comic.k-manga.jp', path: '/title/100007/pv', store: 'kmanga', reader: false },
];

// The deliberate non-reader path: the CLI sets window.__BWDD_HEADLESS__ and
// injects the script itself into a store product page. Only BookWalker and
// ebookjapan have a headless claim, and only for their own product page. The
// `capture` field records whether the adapter's install() wraps window.fetch,
// which proves which adapter was chosen without a debug surface.
const HEADLESS = [
  { host: 'bookwalker.jp', path: '/decf5c400b-42c7-4c7f-af26-7181721d9f5e/', store: 'bookwalker', claims: true, capture: true },
  { host: 'www.cmoa.jp', path: '/title/100001/', store: 'cmoa', claims: false },
  { host: 'ebookjapan.yahoo.co.jp', path: '/books/716241/A001624701/', store: 'ebookjapan', claims: true, capture: false },
  { host: 'read.amazon.co.jp', path: '/dp/B000000001', store: 'kindle', claims: false },
  { host: 'comic.k-manga.jp', path: '/title/100007/pv', store: 'kmanga', claims: false },
];

const carriedStoresOf = target => STORE_MODULES
  .filter(([m]) => target.modules.includes(m))
  .map(([, k]) => k);

(async () => {
  for (const [id, target] of Object.entries(TARGETS)) {
    const file = path.join(ROOT, target.out);
    if (!fs.existsSync(file)) { check(`${id}: artifact exists`, false, target.out + ' is missing'); continue; }
    const text = fs.readFileSync(file, 'utf8');
    const head = text.slice(0, text.indexOf('==/UserScript=='));
    const name = (head.match(/@name\s+(.*)/) || [])[1];
    const matches = [...head.matchAll(/@match\s+(\S+)/g)].map(m => m[1]);
    const connects = [...head.matchAll(/@connect\s+(\S+)/g)].map(m => m[1]);

    const coreVersion = (fs.readFileSync(path.join(ROOT, 'src/core/00-identity.js'), 'utf8')
      .match(/return '([0-9]+\.[0-9]+\.[0-9]+)';/) || [])[1];
    const metaVersion = (head.match(/@version\s+(\S+)/) || [])[1];
    check(`${id}: @version derives from core`, !!coreVersion && metaVersion === coreVersion,
      `@version=${metaVersion} core=${coreVersion}`);
    check(`${id}: no unsubstituted header placeholder`, !/\{\{[A-Z_]+\}\}/.test(head),
      (head.match(/\{\{[A-Z_]+\}\}/) || ['none'])[0]);
    check(`${id}: @name`, name.trim() === target.name, name.trim());

    // The reader-only gate starts in the metadata: a @match list may contain
    // nothing but the reader URLs of the stores this artifact carries. Checked
    // against targets.json and then against the built file, so neither a stale
    // build nor a widened source list can slip through.
    const carriedStores = carriedStoresOf(target);
    const readerMatches = carriedStores.flatMap(store => READER_MATCHES[store]);
    check(`${id}: targets.json names a reader-URL allowlist only`,
      JSON.stringify(target.matches) === JSON.stringify(readerMatches),
      target.matches.join(' '));
    check(`${id}: no target @match names a storefront page`,
      target.matches.every(m => !STOREFRONT_MATCH.test(m)),
      target.matches.filter(m => STOREFRONT_MATCH.test(m)).join(' ') || 'none');
    check(`${id}: @match is exactly this target's list`,
      JSON.stringify(matches) === JSON.stringify(target.matches), matches.join(' '));
    check(`${id}: @connect is exactly this target's list`,
      JSON.stringify(connects) === JSON.stringify(target.connects), connects.join(' '));
    // The debug surface is published on the page realm. A @grant-ed script runs in
    // Tampermonkey's sandbox, where `window` is the sandbox's own object, so
    // assigning __bwdd to it leaves the page console reading undefined - which is
    // how ?bwddDebug failed on ebookjapan while every in-page test passed.
    const grants = [...head.matchAll(/@grant\s+(\S+)/g)].map(m => m[1]);
    check(`${id}: unsafeWindow is granted so the debug surface reaches the page`,
      grants.indexOf('unsafeWindow') !== -1, grants.join(' '));
    check(`${id}: debug globals are published on the page realm, not the sandbox`,
      /function debugRealm\(\)/.test(text) && text.indexOf('debugRealm()[') !== -1,
      'debugRealm present');
    // The bridge's ports are asked for at page load, not when a run begins. The
    // probe is a real round trip and a run that performs it puts that latency in
    // front of its first page; done at boot, a run finds the list already in hand.
    check(`${id}: bridge ports are discovered at page load, not at run start`,
      /refreshPorts\(\)/.test(text) && /setBackgroundInterval\(refreshPorts, 30000\)/.test(text),
      'boot discovery present');

    // Every fragment of an excluded module must be absent, in its stripped
    // form. Fragments are large unique blocks, so a partial leak of one is the
    // only thing this can miss, and the booted-adapter check below covers
    // behaviour.
    const allow = new Set(target.modules);
    const leaked = [];
    for (const frag of MANIFEST.fragments) {
      if (allow.has(frag.module)) continue;
      const needle = stripSource(fs.readFileSync(path.join(ROOT, 'src', frag.file), 'utf8'));
      if (needle && text.includes(needle)) leaked.push(frag.file);
    }
    check(`${id}: no fragment from an excluded module`, leaked.length === 0,
      leaked.length ? 'leaked: ' + leaked.join(', ') : 'none of ' +
        [...new Set(MANIFEST.fragments.map(f => f.module).filter(m => !allow.has(m)))].join('/') + ' present');
  }

  const tls = {
    key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')),
  };
  const srv = https.createServer(tls, (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>t</title><body></body>');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--ignore-certificate-errors',
      '--host-resolver-rules=MAP viewer.bookwalker.jp 127.0.0.1, MAP www.cmoa.jp 127.0.0.1, MAP * 127.0.0.1'],
  });

  // ---- Booted normally: readers select their adapter, store pages select none.
  for (const [id, target] of Object.entries(TARGETS)) {
    const file = path.join(ROOT, target.out);
    if (!fs.existsSync(file)) continue;
    const carriedStores = carriedStoresOf(target);
    const fallback = carriedStores[0];
    // The combined build must not point at itself, so the module is only in
    // the single-store targets; here that is checked against the rendered panel.
    const carriesUnified = target.modules.includes('feature/unified-link');
    for (const exp of EXPECT) {
      const page = await browser.newPage();
      const requests = [];
      page.on('request', req => requests.push(req.url()));
      await page.evaluateOnNewDocument(() => { window.__origFetch = window.fetch; });
      await page.goto('https://' + exp.host + ':' + port + (exp.path || '/') + '?bwddDebug=1',
        { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ content: loadUserscript({ file }) });
      await sleep(900);
      const got = await page.evaluate(() => {
        const b = window.__bwdd || {};
        return {
          site: window.__bwddSite && window.__bwddSite.id,
          title: window.__bwddSite && window.__bwddSite.panelTitle,
          a9p: typeof b.A9p,
          hasCmoaState: !!(b.cmoaState || window.__bwddCmoa),
          hasEjState: !!(b.ebjState || window.__bwddEbookjapan),
          hasKindleState: !!(b.kindleState || window.__bwddKindle),
          hasKmangaState: !!(b.kmangaState || window.__bwddKmanga),
          hasUnified: !!document.querySelector('.bwdd-unified'),
          panel: !!document.querySelector('#bwdd-root'),
          zip: !!document.querySelector('button.bwdd-btn.zip'),
          debug: !!(window.__bwdd || window.__bwddSite),
          automation: !!window.__bwddAutomation,
          fetchWrapped: window.fetch !== window.__origFetch,
        };
      });
      got.bridgeProbes = requests.filter(u => /^http:\/\/127\.0\.0\.1:1(?:[/:?#]|$)/.test(u)).length;
      await page.close();

      // Which adapter must boot here: an artifact that carries the owning store
      // selects it on the reader and nothing at all on its storefront. An
      // artifact that does not carry the store has no adapter that owns this
      // host, so the unclaimed-host fallback boots its own store, panel and all.
      const carries = carriedStores.includes(exp.store);
      const wantAdapter = carries ? (exp.reader ? exp.store : null) : fallback;
      const wantPanel = carries ? exp.reader : true;
      const where = exp.host + (exp.path || '/');

      if (wantAdapter === null) {
        check(`${id} on ${where}: no adapter`, got.site === undefined, `site=${got.site}`);
        check(`${id} on ${where}: no panel, no controls, no debug surface and no automation API`,
          got.panel === false && got.zip === false && got.debug === false && got.automation === false,
          `panel=${got.panel} zip=${got.zip} debug=${got.debug} automation=${got.automation}`);
        check(`${id} on ${where}: fetch stays unwrapped and the bridge is not probed`,
          got.fetchWrapped === false && got.bridgeProbes === 0,
          `fetchWrapped=${got.fetchWrapped} bridgeProbes=${got.bridgeProbes}`);
      } else {
        check(`${id} on ${where}: adapter`, got.site === wantAdapter, `site=${got.site} title=${got.title}`);
        check(`${id} on ${where}: panel ${wantPanel ? 'mounts in the reader' : 'is held back'}`,
          got.panel === wantPanel && got.zip === wantPanel,
          `panel=${got.panel} zip=${got.zip} expected=${wantPanel}`);
        // A panel that is not mounted cannot render the pointer either, so this
        // compares against what the panel would have rendered where it exists.
        check(`${id} on ${where}: "all-in-one downloader" pointer`,
          got.hasUnified === (carriesUnified && got.panel),
          `rendered=${got.hasUnified} expected=${carriesUnified && got.panel}`);
      }

      if (!target.modules.includes('sites/bookwalker')) {
        check(`${id} on ${exp.host}: no BookWalker internals`, got.a9p === 'undefined', `typeof A9p=${got.a9p}`);
      }
      if (!target.modules.includes('sites/cmoa')) {
        check(`${id} on ${exp.host}: no CMOA internals`, got.hasCmoaState === false, `cmoaState present=${got.hasCmoaState}`);
      }
      if (!target.modules.includes('sites/kindle')) {
        check(`${id} on ${exp.host}: no Kindle internals`, got.hasKindleState === false,
          `kindleState present=${got.hasKindleState}`);
      }
      if (!target.modules.includes('sites/kmanga')) {
        check(`${id} on ${exp.host}: no k-manga internals`, got.hasKmangaState === false,
          `kmangaState present=${got.hasKmangaState}`);
      }
      // The combined artifact carries every module, but window.__bwdd gets only
      // the ACTIVE adapter's debug surface, so assert the matching one - only
      // where an adapter is supposed to be active at all. That the other modules
      // are present is what the fragment check above establishes.
      if (carriedStores.length > 1 && wantAdapter !== null) {
        const ok = (exp.store === 'bookwalker') ? got.a9p === 'function'
          : (exp.store === 'cmoa') ? got.hasCmoaState === true
          : (exp.store === 'ebookjapan') ? got.hasEjState === true
          : (exp.store === 'kmanga') ? got.hasKmangaState === true
          : got.hasKindleState === true;
        check(`${id} on ${exp.host}: active store's internals exported`, ok,
          `A9p=${got.a9p} cmoaState=${got.hasCmoaState} ebookjapanState=${got.hasEjState} kindleState=${got.hasKindleState} kmangaState=${got.hasKmangaState}`);
      }
    }
  }

  // ---- Headless injection: only the two documented product pages are claimed.
  for (const [id, target] of Object.entries(TARGETS)) {
    const file = path.join(ROOT, target.out);
    if (!fs.existsSync(file)) continue;
    const carriedStores = carriedStoresOf(target);
    for (const exp of HEADLESS) {
      if (!carriedStores.includes(exp.store)) continue;
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        window.__origFetch = window.fetch;
        window.__BWDD_HEADLESS__ = true;
      });
      await page.goto('https://' + exp.host + ':' + port + exp.path, { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({ content: loadUserscript({ file }) });
      await sleep(800);
      const got = await page.evaluate(() => ({
        automation: !!window.__bwddAutomation,
        panel: !!document.querySelector('#bwdd-root'),
        zip: !!document.querySelector('button.bwdd-btn.zip'),
        debug: !!(window.__bwdd || window.__bwddSite),
        fetchWrapped: window.fetch !== window.__origFetch,
      }));
      await page.close();
      const where = 'headless ' + exp.host + exp.path;
      check(`${id} on ${where}: ${exp.claims ? 'the product page is claimed and installs the automation API' : 'no adapter is selected'}`,
        exp.claims
          ? (got.automation === true && got.panel === false && got.zip === false && got.debug === false)
          : (got.automation === false && got.panel === false && got.debug === false),
        `automation=${got.automation} panel=${got.panel} debug=${got.debug}`);
      if (exp.capture !== undefined) {
        check(`${id} on ${where}: the ${exp.store} adapter's capture state`,
          got.fetchWrapped === exp.capture, `fetchWrapped=${got.fetchWrapped} expected=${exp.capture}`);
      }
    }
  }

  await browser.close(); srv.close();
  const failed = results.filter(r => !r.pass);
  fs.writeFileSync(path.join(__dirname, 'split_builds_result.json'), JSON.stringify({ results }, null, 2));
  console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
