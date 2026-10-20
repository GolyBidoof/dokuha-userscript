#!/usr/bin/env node
'use strict';
/*
 * Site dispatch test.
 *
 * The unified script picks an adapter from the page host, and since the
 * reader-only change that choice is also a gate: a store host selects its
 * adapter only on a reader URL. A normal page load on a storefront, series,
 * title or product page runs nothing at all - no adapter, no panel, no debug
 * surface, no network capture, no bridge probe.
 *
 * What this pins:
 *   - every BookWalker viewer host and the four other stores' readers select
 *     their adapter, install the network capture and mount the panel;
 *   - each store's own storefront / series / title / product page selects NO
 *     adapter and does nothing, the regression from the old panelAllowed()
 *     behaviour where the adapter stayed installed behind a hidden panel;
 *   - a host no store owns (127.0.0.1 stub servers, unclaimed.example) still
 *     falls back to BookWalker, which the rest of the suite relies on;
 *   - with window.__BWDD_HEADLESS__ set before injection a BookWalker
 *     /de<uuid>/ page and an ebookjapan /books/<id>/<code>/ page still select
 *     their adapter and install window.__bwddAutomation (the CLI injection
 *     path), while a store product page with no headless claim still does
 *     nothing.
 */
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');

const BODY = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>Test Volume 1巻</title></head><body>
<div id="content"></div>
<div data-ptbinb="/bib/sws/bibGetCntntInfo.php?u0=1" data-ptbinb-cid="0000249510_jp_0001"></div>
</body></html>`;

// The four viewer hosts the BookWalker adapter must claim.
const BW_VIEWERS = [
    'viewer.bookwalker.jp',
    'viewer-trial.bookwalker.jp',
    'viewer-ptrial.bookwalker.jp',
    'viewer-subscription.bookwalker.jp',
];

// Store pages that are NOT readers: the store owns the host, but no reader URL
// pattern matches, so a normal page load must select nothing.
const STOREFRONTS = [
    ['a BookWalker series page', 'https://bookwalker.jp/series/900002/list/?bwddDebug=1'],
    ['a BookWalker /de<uuid> product page', 'https://bookwalker.jp/decf5c400b-42c7-4c7f-af26-7181721d9f5e/?bwddDebug=1'],
    ['a CMOA title page', 'https://www.cmoa.jp/title/100001/?bwddDebug=1'],
    ['an ebookjapan volume page', 'https://ebookjapan.yahoo.co.jp/books/716241/A001624701/?bwddDebug=1'],
    ['a Kindle product page outside /manga/', 'https://read.amazon.co.jp/dp/B000000001?bwddDebug=1'],
    ['a k-manga title page', 'https://comic.k-manga.jp/title/100007/pv?bwddDebug=1'],
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const src = loadUserscript();
    const fileVersion = (src.match(/@version\s+([0-9.]+)/) || [])[1];
    const results = [];
    const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };

    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true,
        args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    try {
        async function probe(url, opts) {
            const page = await browser.newPage();
            const requests = [];
            page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 160)));
            await page.setRequestInterception(true);
            page.on('request', req => {
                const u = req.url();
                requests.push(u);
                // Serve the synthetic page for any navigation: the unclaimed-host
                // case must not depend on DNS resolving.
                if (req.resourceType() === 'document' || req.isNavigationRequest()) {
                    return req.respond({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: BODY });
                }
                // Nothing off this machine is reached and no real bridge answers.
                return req.abort().catch(() => {});
            });
            await page.evaluateOnNewDocument((headless) => {
                try { localStorage.clear(); } catch (e) {}
                // Recorded before the userscript runs so we can tell whether it
                // wrapped fetch (its network capture) on this page.
                window.__origFetch = window.fetch;
                if (headless) window.__BWDD_HEADLESS__ = true;
            }, !!(opts && opts.headless));
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.addScriptTag({ content: src });
            await sleep(800);
            const out = await page.evaluate(() => ({
                siteId: window.__bwddSite && window.__bwddSite.id,
                panel: !!document.querySelector('#bwdd-root'),
                zip: !!document.querySelector('button.bwdd-btn.zip'),
                title: (document.querySelector('#bwdd-panel-title') || {}).textContent || '',
                fetchWrapped: window.fetch !== window.__origFetch,
                hasDebug: !!(window.__bwdd || window.__bwddSite || window.__bwddUI ||
                    window.__bwddCmoa || window.__bwddEbookjapan || window.__bwddKindle || window.__bwddKmanga),
                hasAutomation: !!window.__bwddAutomation,
                automationVersion: (window.__bwddAutomation && window.__bwddAutomation.version) || null,
                cmoaCid: window.__bwddCmoa ? window.__bwddCmoa.cid : null,
                bwCid: window.__bwdd && window.__bwdd.state ? window.__bwdd.state.cid : null,
                kindleAsin: window.__bwddKindle ? window.__bwddKindle.asin : null,
                ejCode: window.__bwddEbookjapan ? window.__bwddEbookjapan.code : null,
                kmangaBookId: window.__bwddKmanga ? window.__bwddKmanga.bookId : null,
            }));
            await page.close();
            // The bridge's ports are asked for at page load on a live page. The
            // bridge URL is substituted to a closed port by the loader, so the
            // probe is visible in the request log without leaving the machine.
            out.bridgeProbes = requests.filter(u => /^http:\/\/127\.0\.0\.1:1(?:[/:?#]|$)/.test(u)).length;
            return out;
        }

        // ---- Readers: every reader host still selects its adapter and boots.
        for (const host of BW_VIEWERS) {
            const out = await probe(`https://${host}/deno/1/1/1/?cid=abc123&bwddDebug=1`);
            check(`${host} selects the BookWalker adapter`, out.siteId === 'bookwalker', 'adapter=' + out.siteId);
            check(`${host} gets the panel, its controls and the BookWalker capture`,
                out.panel && out.zip && out.fetchWrapped,
                `panel=${out.panel} zip=${out.zip} fetchWrapped=${out.fetchWrapped}`);
        }
        const bw = await probe('https://viewer.bookwalker.jp/deno/1/1/1/?cid=abc123&bwddDebug=1');
        check('the BookWalker panel is branded for BookWalker',
            /BookWalker/.test(bw.title) && !/CMOA/.test(bw.title), JSON.stringify(bw.title.trim()));
        check('the BookWalker id is taken from the page URL',
            bw.bwCid === 'abc123', 'cid=' + JSON.stringify(bw.bwCid));
        check('the CMOA adapter state stays empty on a BookWalker page',
            bw.cmoaCid === null, 'cmoa cid=' + JSON.stringify(bw.cmoaCid));

        const cm = await probe('https://www.cmoa.jp/bib/speedreader/?cid=0000249510_jp_0001&u0=1&bwddDebug=1');
        check('a CMOA speed-reader page selects the CMOA adapter', cm.siteId === 'cmoa', 'adapter=' + cm.siteId);
        check('the CMOA capture is installed on its own page', cm.fetchWrapped === true, 'window.fetch wrapped=' + cm.fetchWrapped);
        check('the CMOA panel is branded for CMOA',
            /CMOA/.test(cm.title) && !/BookWalker/.test(cm.title), JSON.stringify(cm.title.trim()));
        check('the CMOA id comes from the page URL on its page',
            cm.cmoaCid === '0000249510_jp_0001', 'cid=' + JSON.stringify(cm.cmoaCid));
        const cmReader = await probe('https://www.cmoa.jp/reader/sample/?bwddDebug=1');
        check('a CMOA /reader/ page also selects the CMOA adapter',
            cmReader.siteId === 'cmoa' && cmReader.panel && cmReader.zip,
            `adapter=${cmReader.siteId} panel=${cmReader.panel} zip=${cmReader.zip}`);

        const ej = await probe('https://ebookjapan.yahoo.co.jp/viewer/free/A000000001/?bwddDebug=1');
        check('an ebookjapan viewer page selects the ebookjapan adapter', ej.siteId === 'ebookjapan', 'adapter=' + ej.siteId);
        check('the ebookjapan panel is branded for ebookjapan',
            /ebookjapan/.test(ej.title) && !/BookWalker/.test(ej.title), JSON.stringify(ej.title.trim()));
        check('the ebookjapan adapter exposes its own debug surface',
            ej.hasDebug === true && ej.ejCode === 'A000000001',
            'ejDebug=' + ej.hasDebug + ' code=' + JSON.stringify(ej.ejCode));

        const kindle = await probe('https://read.amazon.co.jp/manga/B000000001?bwddDebug=1');
        check('a Kindle manga reader page selects the Kindle adapter', kindle.siteId === 'kindle', 'adapter=' + kindle.siteId);
        check('the Kindle panel is branded for Kindle',
            /Kindle/.test(kindle.title) && !/BookWalker/.test(kindle.title), JSON.stringify(kindle.title.trim()));
        check('the Kindle id is taken from the page URL',
            kindle.kindleAsin === 'B000000001', 'asin=' + JSON.stringify(kindle.kindleAsin));

        // The viewer URL owns the session (ticket + obfuid) and carries the book
        // id in p3, so the adapter can publish them from the address alone.
        const kmanga = await probe('https://comic.k-manga.jp/viewer/pc/viewer.html'
            + '?p0=BGTK_0000000000000000000000000000000_20260101000000'
            + '&p1=0000000000000000000000000000001&p2=2&p3=100007&p4=1'
            + '&p8=sid000000000000000000000000&p10=2&p20=00000005-0000-4000-8000-000000000005&p21=0'
            + '&bwddDebug=1');
        check('a k-manga viewer page selects the k-manga adapter', kmanga.siteId === 'kmanga', 'adapter=' + kmanga.siteId);
        check('the k-manga panel is branded for k-manga',
            /k-manga/.test(kmanga.title) && !/BookWalker/.test(kmanga.title), JSON.stringify(kmanga.title.trim()));
        check('the k-manga adapter exposes its own debug surface',
            kmanga.hasDebug === true && kmanga.kmangaBookId === '100007',
            'kmangaDebug=' + kmanga.hasDebug + ' bookId=' + JSON.stringify(kmanga.kmangaBookId));

        // ---- Storefronts: the store owns the host, so no adapter may be picked.
        for (const [name, url] of STOREFRONTS) {
            const out = await probe(url);
            check(`${name} selects no adapter`,
                out.siteId === undefined, 'adapter=' + out.siteId);
            check(`${name} paints no panel and no controls`,
                out.panel === false && out.zip === false,
                `panel=${out.panel} zip=${out.zip}`);
            check(`${name} exposes no debug surface and no automation API`,
                out.hasDebug === false && out.hasAutomation === false,
                `debug=${out.hasDebug} automation=${out.hasAutomation}`);
            check(`${name} leaves fetch unwrapped and probes no bridge`,
                out.fetchWrapped === false && out.bridgeProbes === 0,
                `fetchWrapped=${out.fetchWrapped} bridgeProbes=${out.bridgeProbes}`);
        }

        // ---- Hosts no store owns still get the BookWalker fallback.
        const unknown = await probe('https://unclaimed.example/reader/?bwddDebug=1');
        check('a host no adapter claims still falls back to BookWalker',
            unknown.siteId === 'bookwalker' && unknown.panel && unknown.zip && unknown.fetchWrapped,
            `adapter=${unknown.siteId} panel=${unknown.panel} zip=${unknown.zip} fetchWrapped=${unknown.fetchWrapped}`);
        const loopback = await probe('http://127.0.0.1:10419/?bwddDebug=1');
        check('a bare 127.0.0.1 test server still falls back to BookWalker',
            loopback.siteId === 'bookwalker' && loopback.panel && loopback.zip,
            `adapter=${loopback.siteId} panel=${loopback.panel} zip=${loopback.zip}`);

        // ---- Headless exception: the CLI injects the script itself into a store
        // product page and needs that page to claim the store anyway. Detection
        // stays reader-only on a normal load (covered above); only an explicit
        // window.__BWDD_HEADLESS__ before injection unlocks the product page.
        const bwHeadless = await probe(
            'https://bookwalker.jp/decf5c400b-42c7-4c7f-af26-7181721d9f5e/?bwddDebug=1', { headless: true });
        check('headless: a BookWalker /de<uuid> product page still claims the BookWalker adapter',
            bwHeadless.hasAutomation === true && bwHeadless.fetchWrapped === true,
            `automation=${bwHeadless.hasAutomation} fetchWrapped=${bwHeadless.fetchWrapped}`);
        check('headless: the automation API reports the built @version',
            bwHeadless.automationVersion === fileVersion,
            `automation=${bwHeadless.automationVersion} file=${fileVersion}`);
        check('headless: the BookWalker product page gets no panel',
            bwHeadless.panel === false && bwHeadless.zip === false,
            `panel=${bwHeadless.panel} zip=${bwHeadless.zip}`);
        check('headless: the debug surface stays hidden in headless mode',
            bwHeadless.hasDebug === false && bwHeadless.siteId === undefined,
            `debug=${bwHeadless.hasDebug} site=${bwHeadless.siteId}`);

        const ejHeadless = await probe(
            'https://ebookjapan.yahoo.co.jp/books/716241/A001624701/?bwddDebug=1', { headless: true });
        // ebookjapan's install() does not wrap fetch, so an unwrapped fetch with
        // the automation API present is proof the ebookjapan adapter was chosen
        // rather than the BookWalker fallback.
        check('headless: an ebookjapan /books/<id>/<code> page still claims the ebookjapan adapter',
            ejHeadless.hasAutomation === true && ejHeadless.fetchWrapped === false,
            `automation=${ejHeadless.hasAutomation} fetchWrapped=${ejHeadless.fetchWrapped}`);
        check('headless: the ebookjapan product page gets no panel',
            ejHeadless.panel === false && ejHeadless.zip === false,
            `panel=${ejHeadless.panel} zip=${ejHeadless.zip}`);

        const cmHeadless = await probe('https://www.cmoa.jp/title/100001/?bwddDebug=1', { headless: true });
        check('headless: a store page with no headless claim still does nothing',
            cmHeadless.hasAutomation === false && cmHeadless.panel === false &&
            cmHeadless.fetchWrapped === false && cmHeadless.hasDebug === false,
            `automation=${cmHeadless.hasAutomation} panel=${cmHeadless.panel} ` +
            `fetchWrapped=${cmHeadless.fetchWrapped} debug=${cmHeadless.hasDebug}`);
    } finally {
        await browser.close().catch(() => {});
    }

    const failed = results.filter(r => !r.pass);
    fs.writeFileSync(path.join(__dirname, 'site_dispatch_result.json'), JSON.stringify({ results }, null, 2));
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
