'use strict';
/*
 * Shared boot for the k-manga tests.
 *
 * Every one of them needs the same three things: a comic.k-manga.jp document
 * served from memory (so no DNS and no store is touched), the built userscript
 * injected on it with ?bwddDebug so the adapter publishes its protocol surface,
 * and the other store / bridge / stats hosts refused. Keeping that here means
 * the tests differ only in what they assert.
 */
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

const BODY = '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
    + '<title>k-manga test</title></head><body></body></html>';

// The reader page the adapter now claims, with the query its own parser reads.
const DEFAULT_PATH = '/viewer/pc/viewer.html'
    + '?p0=BGTK_0000000000000000000000000000000_20260101000000'
    + '&p1=0000000000000000000000000000001&p2=2&p3=100007&p4=1'
    + '&p8=sid0000000000000000000000&p10=2'
    + '&p20=00000005-0000-4000-8000-000000000005&p21=0';

async function launch(pathname) {
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true,
        args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
    // Bound every protocol operation, so a page that never answers fails this
    // file quickly instead of sitting on the runner's 15-minute per-file budget.
    page.setDefaultTimeout(20000);
    await page.setRequestInterception(true);
    page.on('request', req => {
        const url = req.url();
        // The store page is fabricated, so the test never depends on the site
        // being up, on a login, or on the machine having DNS at all.
        if (/^https:\/\/comic\.k-manga\.jp\//.test(url)) {
            return req.respond({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: BODY });
        }
        return req.abort();
    });
    // The adapter only claims the reader, so the default page is a viewer URL.
    const path = pathname || DEFAULT_PATH;
    await page.goto(
        'https://comic.k-manga.jp' + path + (path.includes('?') ? '&' : '?') + 'bwddDebug=1',
        { waitUntil: 'domcontentloaded' },
    );
    await page.addScriptTag({ content: loadUserscript() });
    // page.evaluate has no timeout of its own: a page whose main thread never
    // returns would hang the whole file, so every call is raced against a node
    // timer on this side.
    const ready = await Promise.race([
        page.evaluate(() => !!(window.__bwddKmangaProtocol
            && window.__bwddSite && window.__bwddSite.id === 'kmanga')),
        new Promise((_, reject) => setTimeout(() => reject(new Error('the injected page never answered')), 15000)),
    ]);
    return { browser, page, ready };
}

function reporter() {
    const results = [];
    // page.evaluate has no timeout of its own, so a page that never answers
    // would otherwise burn the runner's 15-minute per-file budget. Fail loudly
    // instead, naming the file so the hang is attributable.
    const watchdog = setTimeout(() => {
        console.error('FATAL  ' + require('path').basename(process.argv[1] || 'test') + ' did not finish within 150s');
        process.exit(1);
    }, 150000);
    const check = (name, pass, detail) => {
        results.push({ name, pass: !!pass });
        console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail !== undefined ? '  \u2014 ' + detail : ''));
    };
    const finish = () => {
        clearTimeout(watchdog);
        const failed = results.filter(r => !r.pass);
        console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
        process.exit(failed.length ? 1 : 0);
    };
    return { check, finish, results };
}

/** V8-safe base64 -> byte array, for handing a fixture into the page. */
function bytesToBase64(buffer) {
    return Buffer.from(buffer).toString('base64');
}

module.exports = { launch, reporter, bytesToBase64, CHROME, BODY };
