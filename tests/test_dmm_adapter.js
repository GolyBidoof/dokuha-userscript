#!/usr/bin/env node
'use strict';
/*
 * DMMブックス adapter/run test — hermetic, like the CMOA, Kindle, ebookjapan
 * and k-manga tests.
 *
 * A local HTTPS server stands in for both book.dmm.com and the image CDN, and
 * Chromium is pointed at it with --host-resolver-rules, so nothing leaves the
 * machine. The real userscript is injected into the real DMM viewer URL and the
 * real shared panel's "Save as ZIP" button is clicked. The ZIP is captured the
 * same way the acceptance harness does it (URL.createObjectURL wrapper) and
 * parsed in Node.
 *
 * What this covers that test_dmm_protocol.js / test_dmm_worker.js cannot:
 *   - adapter selection on https://book.dmm.com/product/<series>/<content>/
 *     free_streaming/?, including the parsed viewer identity;
 *   - the production auth round trip: /viewerapi/auth/ answers with CloudFront
 *     cookies, the adapter reads document.cookie and the manifest request
 *     carries Policy/Signature/Key-Pair-Id as query parameters (the 403 bug the
 *     protocol test pins at the pure-function level);
 *   - the manifest probe filling the panel with the page count and the page
 *     resolution (DummyWidth/DummyHeight and Size.Width/Height);
 *   - a full run: one ZIP entry per page, flat page-NNNN.jpg names, every page
 *     a real 128x128 JPEG whose four 64px tiles land exactly where
 *     dmmTileRects() says they should (the fixture is the scrambled image; the
 *     test reads the destination mapping out of the page's own protocol
 *     surface and compares pixels, so a run that skipped the unshuffle or
 *     applied the wrong geometry fails);
 *   - the 403 refresh path: a page refused after the signature rolled over
 *     triggers one shared dmmAuth() refresh and is retried against the
 *     replacement session (the two requests carry different Policy values);
 *   - page-cache resume: a partial run keeps the pages it saved, and the next
 *     run fetches only the page that failed and completes the archive;
 *   - the tachiyomi sampler: auth_info query signing instead of cookies, the
 *     （試し読み） title suffix and the sample cache id.
 *
 * NOT asserted: byte-identical descrambled output. Canvas JPEG encoding is the
 * browser's and is not stable across machines. The tile GEOMETRY is pinned
 * against a real capture by test_dmm_protocol.js; this test pins that the run
 * fetches, decodes, applies that geometry and archives in page order.
 *
 * `?bwddDebug=1` is needed for the debug globals (__bwddSite, __bwddDmm,
 * __bwddDmmProtocol, __bwdd.clearPageCache). The run is driven through the
 * panel button, not window.__bwddAutomation, because headless automation turns
 * the page cache OFF (src/core/11-automation.js normalizeRunOptions) and the
 * resume path is one of the things under test.
 *
 * The one non-hermetic-friendly detail: dmmAuth() builds its URL from the
 * hardcoded https://book.dmm.com origin with no port (src/sites/dmm/
 * 01-protocol.js:68), and the local stub listens on an ephemeral port, so the
 * page-level fetch is re-pointed at that port before it runs. Everything else
 * reaches the stub through the host-resolver rules.
 */
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { loadUserscript } = require('./_userscript');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US_SRC = loadUserscript();
const HAS_DMM = US_SRC.indexOf("id: 'dmm'") !== -1 &&
    US_SRC.indexOf("'DMMブックス Native Downloader'") !== -1;

const TITLE = 'サンプル作品 3巻';
const CLEAN = 128;           // page size the manifest declares
const ENCODED = 128;         // scrambled image size: 2x2 tiles of 64
const TILE = 64;
const DUMMY = 0;             // no padding: the shuffle is a pure tile permutation
const PAGES = 3;
const FREE_PATH = '/product/605237/b999asqex01885/free_streaming/?cid=TEST&lin=0&bwddDebug=1';
const SAMPLE_PATH = '/product/605237/b999asqex01885/tachiyomi/?cid=TEST2&lin=1&bwddDebug=1';
const CDN_HOST = 'ebook04.dmm.com';

const results = [];
const check = (n, pass, d) => {
    results.push({ n, pass, d });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + (d == null ? '' : d));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fixtures: three 128x128 "scrambled" JPEGs, four flat 64px tiles each. Every
// page has its own palette so a ZIP entry can be traced back to its page, and
// no palette colour is within JPEG noise of another within the same page.
// ---------------------------------------------------------------------------
function tileColors(pageIdx) {
    const at = v => Math.max(0, Math.min(255, v));
    const shift = pageIdx * 60;
    return [
        { r: at(220 - shift), g: at(40 + shift), b: 50 },   // served TL
        { r: at(50 + shift), g: at(210 - shift), b: 60 },   // served TR
        { r: 60, g: 70, b: at(220 - shift) },               // served BL
        { r: at(230 - shift), g: at(220 - shift), b: 40 },  // served BR
    ];
}

async function buildScrambledPage(pageIdx) {
    const colors = tileColors(pageIdx);
    const tiles = await Promise.all(colors.map(color => sharp({
        create: { width: TILE, height: TILE, channels: 3, background: color },
    }).png().toBuffer()));
    return sharp({
        create: { width: ENCODED, height: ENCODED, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
        .composite([
            { input: tiles[0], left: 0, top: 0 },
            { input: tiles[1], left: TILE, top: 0 },
            { input: tiles[2], left: 0, top: TILE },
            { input: tiles[3], left: TILE, top: TILE },
        ])
        .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
        .toBuffer();
}

const PAGE_FILES = Array.from({ length: PAGES },
    (_, i) => 'item/xhtml/p-' + String(i + 1).padStart(3, '0') + '.xhtml');

// A minimal Linear manifest: one linear JPEG item per page, each with the
// DummyWidth/DummyHeight pair (zero still means "shuffle") plus the clean Size.
function manifest() {
    const contents = PAGE_FILES.map(file => ({ file, type: 'jpeg' }));
    const body = { configuration: { contents } };
    PAGE_FILES.forEach(file => {
        body[file] = {
            Linear: 1,
            FileLinkInfo: {
                PageLinkInfoList: [{
                    Page: {
                        No: 0,
                        DummyWidth: DUMMY,
                        DummyHeight: DUMMY,
                        Size: { Width: CLEAN, Height: CLEAN },
                    },
                }],
            },
        };
    });
    return Buffer.from(JSON.stringify(body), 'utf8');
}

function viewerHtml() {
    return '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
        '<meta property="og:title" content="' + TITLE + '">' +
        '<title>' + TITLE + ' | DMMブックス</title></head><body>' +
        '<div id="viewer"></div></body></html>';
}

// ---------------------------------------------------------------------------
// Stub server. Same process as the test, so request counters are just fields.
// ---------------------------------------------------------------------------
const stub = {
    epoch: 0,
    authCalls: 0,
    page2: 'allow',          // 'allow' | 'deny'
    manifest: [],
    pages: [],               // { page, policy, status }
    reset() { this.authCalls = 0; this.manifest = []; this.pages = []; },
};

let PAGE_JPEGS = [];
let PORT = 0;

function route(req, res) {
    const url = new URL(req.url, 'https://stub');
    const q = url.searchParams;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    const send = (status, headers, body) => {
        res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store' }, headers));
        res.end(body);
    };

    if (url.pathname === '/viewerapi/auth/') {
        stub.authCalls++;
        stub.epoch++;
        const policy = 'POLICY' + stub.epoch;
        const signature = 'SIG' + stub.epoch;
        const base = 'https://' + CDN_HOST + ':' + PORT + '/book/';
        if (q.get('lin') === '1') {
            // The sampler answers with auth_info instead of CloudFront cookies.
            return send(200, Object.assign({ 'Content-Type': 'application/json' }, cors), JSON.stringify({
                status: 200, url: base,
                auth_info: { Policy: policy, Signature: signature, 'Key-Pair-Id': 'TESTKEY' },
            }));
        }
        // A free/campaign volume: three non-HttpOnly CloudFront cookies.
        return send(200, Object.assign({
            'Content-Type': 'application/json',
            'Set-Cookie': [
                'CloudFront-Policy=' + policy + '; Path=/',
                'CloudFront-Signature=' + signature + '; Path=/',
                'CloudFront-Key-Pair-Id=TESTKEY; Path=/',
            ],
        }, cors), JSON.stringify({ status: 200, url: base }));
    }

    if (url.pathname.endsWith('/configuration_pack.json')) {
        stub.manifest.push({ policy: q.get('Policy'), signature: q.get('Signature') });
        if (!q.get('Policy') || !q.get('Signature')) {
            return send(403, Object.assign({ 'Content-Type': 'text/plain' }, cors), 'signature required');
        }
        return send(200, Object.assign({ 'Content-Type': 'application/json' }, cors),
            manifest());
    }

    const m = /^\/book\/item\/xhtml\/(p-\d{3})\.xhtml\/0\.jpeg$/.exec(url.pathname);
    if (m) {
        const pageNo = Number(m[1].slice(2));
        const signed = !!(q.get('Policy') && q.get('Signature'));
        let status = 200;
        if (!signed) status = 403;
        else if (pageNo === 2 && stub.page2 === 'deny') status = 403;
        stub.pages.push({ page: pageNo, policy: q.get('Policy'), status });
        if (status !== 200) {
            return send(status, Object.assign({ 'Content-Type': 'text/plain' }, cors), 'signature rolled over');
        }
        return send(200, Object.assign({ 'Content-Type': 'image/jpeg' }, cors), PAGE_JPEGS[pageNo - 1]);
    }

    if (url.pathname.indexOf('/product/') === 0) {
        return send(200, { 'Content-Type': 'text/html; charset=utf-8' }, viewerHtml());
    }
    return send(404, { 'Content-Type': 'text/plain' }, 'stub: no route for ' + url.pathname);
}

// ---------------------------------------------------------------------------
// ZIP reader: the userscript's own writer stores entries uncompressed, so sizes
// are literal.
// ---------------------------------------------------------------------------
function readStoreZip(buf) {
    const entries = [];
    let off = 0;
    while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
        const size = buf.readUInt32LE(off + 18);
        const nameLen = buf.readUInt16LE(off + 26);
        const extraLen = buf.readUInt16LE(off + 28);
        const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
        const start = off + 30 + nameLen + extraLen;
        entries.push({ name, data: buf.subarray(start, start + size) });
        off = start + size;
    }
    return entries;
}

async function decodeJpeg(buf) {
    const { data, info } = await sharp(buf).removeAlpha().raw()
        .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels };
}

function pixelAt(img, x, y) {
    const i = (y * img.width + x) * img.channels;
    return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2] };
}

// The destination quadrant colours implied by the page's own tile geometry.
// `rects` comes from the page's exposed dmmTileRects(); a 128x128 page has
// exactly four full 64x64 tiles, so the mapping must cover four destinations.
function expectedQuadrants(colors, rects) {
    const out = [null, null, null, null];
    for (const r of rects) {
        if (r.w !== TILE || r.h !== TILE || r.sx % TILE || r.sy % TILE) continue;
        const src = (r.sy / TILE) * 2 + (r.sx / TILE);
        const dst = (r.dy / TILE) * 2 + (r.dx / TILE);
        if (src < 0 || src > 3 || dst < 0 || dst > 3) continue;
        out[dst] = colors[src];
    }
    return out;
}

function quadrantCenters(rects) {
    const centers = [null, null, null, null];
    for (const r of rects) {
        const dst = (r.dy / TILE) * 2 + (r.dx / TILE);
        if (dst < 0 || dst > 3) continue;
        centers[dst] = { x: r.dx + TILE / 2, y: r.dy + TILE / 2 };
    }
    return centers;
}

const JPEG_TOL = 18;

async function checkPageImage(pageIdx, data, rects) {
    const colors = tileColors(pageIdx);
    const expected = expectedQuadrants(colors, rects);
    const centers = quadrantCenters(rects);
    const problems = [];
    let img;
    try { img = await decodeJpeg(data); }
    catch (e) { return { ok: false, detail: 'not a decodable JPEG: ' + (e.message || e) }; }
    if (img.width !== CLEAN || img.height !== CLEAN) {
        return { ok: false, detail: 'size ' + img.width + 'x' + img.height + ', want ' + CLEAN + 'x' + CLEAN };
    }
    if (expected.some(c => !c) || centers.some(c => !c)) {
        return { ok: false, detail: 'geometry did not cover four quadrants: ' + JSON.stringify(rects) };
    }
    for (let dst = 0; dst < 4; dst++) {
        const cx = centers[dst].x, cy = centers[dst].y;
        if (cx < 0 || cy < 0 || cx >= img.width || cy >= img.height) {
            problems.push('q' + dst + ' centre (' + cx + ',' + cy + ') is outside the ' +
                img.width + 'x' + img.height + ' page');
            continue;
        }
        const got = pixelAt(img, cx, cy);
        const want = expected[dst];
        if (Math.abs(got.r - want.r) > JPEG_TOL || Math.abs(got.g - want.g) > JPEG_TOL ||
            Math.abs(got.b - want.b) > JPEG_TOL) {
            problems.push('q' + dst + '=(' + got.r + ',' + got.g + ',' + got.b + ') want (' +
                want.r + ',' + want.g + ',' + want.b + ')');
        }
    }
    // A run that skipped the shuffle would leave the served arrangement in
    // place, which for this fixture is detectable as an identity mapping.
    const identity = expected.every((c, i) =>
        c.r === colors[i].r && c.g === colors[i].g && c.b === colors[i].b);
    return { ok: problems.length === 0, identity, detail: problems.join('; ') || 'tiles match the mapping' };
}

// ---------------------------------------------------------------------------
// Browser page: one per scenario. The local stub listens on an ephemeral port
// while dmmAuth() hardcodes the portless https://book.dmm.com origin, so that
// one request is re-pointed in the page. Everything else resolves through the
// host-resolver rules.
// ---------------------------------------------------------------------------
async function openViewer(browser, port, viewerPath) {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
    await page.evaluateOnNewDocument((stubPort) => {
        const ORIGIN = 'https://book.dmm.com';
        const LOCAL = ORIGIN + ':' + stubPort;
        const origFetch = window.fetch;
        window.fetch = function (input, init) {
            try {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                if (url.indexOf(ORIGIN + '/viewerapi/') === 0) {
                    input = LOCAL + url.slice(ORIGIN.length);
                }
            } catch (e) { /* fall through to the real fetch */ }
            return origFetch.call(this, input, init);
        };

        // Capture the archive the same way tests/acceptance/lib/browser.js does:
        // the shared harness hands a ZIP Blob to URL.createObjectURL and clicks
        // an anchor for the download (src/core/61-run-harness.js finishZip).
        window.__bwddZips = [];
        window.__bwddDownload = null;
        const origCreate = URL.createObjectURL;
        URL.createObjectURL = function (blob) {
            try {
                if (blob && blob.size > 0 && blob.type === 'application/zip') window.__bwddZips.push(blob);
            } catch (e) {}
            return origCreate.call(this, blob);
        };
        const origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            try {
                if (this.download) { window.__bwddDownload = this.download; return; }
            } catch (e) {}
            return origClick.apply(this, arguments);
        };
    }, port);
    await page.setRequestInterception(true);
    page.on('request', req => {
        let u = null;
        try { u = new URL(req.url()); } catch (e) {}
        const stubHost = u && (u.hostname === 'book.dmm.com' || u.hostname === CDN_HOST) &&
            u.port === String(port);
        if (stubHost) return req.continue();
        // No live network: the stats/availability lookups are background noise.
        return req.abort();
    });
    await page.goto('https://book.dmm.com:' + port + viewerPath, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: US_SRC });
    return page;
}

async function waitForProbe(page, pages) {
    await page.waitForFunction(
        n => window.__bwddDmm && window.__bwddDmm.total === n && !!window.__bwddDmm.probe,
        { timeout: 20000 }, pages,
    ).catch(() => {});
}

// Wait for the run's ZIP Blob and read it out. The panel poll/worker also create
// object URLs, but those blobs are not application/zip, so the count only moves
// for the archive.
async function runZip(page) {
    const before = await page.evaluate(() => (window.__bwddZips || []).length);
    await page.click('button.bwdd-btn.zip');
    await page.waitForFunction(n => (window.__bwddZips || []).length > n, { timeout: 45000 }, before);
    await sleep(200);
    return page.evaluate(async () => {
        const list = window.__bwddZips || [];
        const blob = list[list.length - 1];
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        const details = document.querySelector('.bwdd-hint-box');
        return {
            name: window.__bwddDownload,
            size: bytes.length,
            b64: btoa(bin),
            details: details ? details.textContent.replace(/\s+/g, ' ').trim() : '',
        };
    });
}

(async () => {
    if (!HAS_DMM) {
        console.log('SKIP  test_dmm_adapter.js — this artifact does not carry the DMMブックス adapter');
        console.log('\nALL 0 CHECKS PASSED');
        process.exit(0);
    }

    PAGE_JPEGS = await Promise.all(Array.from({ length: PAGES }, (_, i) => buildScrambledPage(i)));
    const tls = {
        key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')),
    };
    const server = https.createServer(tls, route);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    PORT = server.address().port;

    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true,
        args: ['--no-sandbox', '--ignore-certificate-errors',
            '--host-resolver-rules=MAP book.dmm.com 127.0.0.1, MAP ' + CDN_HOST +
            ' 127.0.0.1, MAP * 127.0.0.1'],
    });
    let pageA = null, pageB = null, pageC = null;
    try {
        //
        // Page A: adapter selection, probe, and a clean run.
        //
        pageA = await openViewer(browser, PORT, FREE_PATH);
        await waitForProbe(pageA, PAGES);
        await pageA.waitForFunction(resolution => {
            const card = document.querySelector('.bwdd-cards');
            return card && card.textContent.indexOf(resolution) !== -1;
        }, { timeout: 15000 }, CLEAN + ' × ' + CLEAN).catch(() => {});

        const boot = await pageA.evaluate(() => {
            const site = window.__bwddSite || {};
            const dmm = window.__bwddDmm || {};
            const titleEl = document.querySelector('#bwdd-panel-title');
            const card = document.querySelector('.bwdd-cards');
            let book = null, preview = null;
            try { book = site.getBook ? site.getBook() : null; } catch (e) {}
            try { preview = site.getPreview ? site.getPreview() : null; } catch (e) {}
            return {
                id: site.id, label: site.label, panelTitle: site.panelTitle,
                domTitle: titleEl ? titleEl.textContent.trim() : null,
                viewer: dmm.viewer, total: dmm.total, resolution: dmm.resolution,
                rawTitle: dmm.rawTitle, stateTitle: dmm.title, sample: dmm.sample,
                cid: site.getCid ? site.getCid() : null,
                book, preview,
                cardText: card ? card.textContent.replace(/\s+/g, ' ') : '',
                hasZip: !!document.querySelector('button.bwdd-btn.zip'),
                hasOcr: !!document.querySelector('button.bwdd-btn.ocr'),
                cookies: document.cookie,
            };
        });
        check('the userscript selects the DMM adapter on a free_streaming viewer URL',
            boot.id === 'dmm' && boot.label === 'DMMブックス', 'adapter=' + boot.id + ' label=' + boot.label);
        check('the shared panel is mounted and branded for DMMブックス',
            /DMM/.test(boot.domTitle || '') && !/BookWalker/.test(boot.domTitle || '') && boot.hasZip && boot.hasOcr,
            JSON.stringify(boot.domTitle));
        check('the viewer URL is parsed into series, content, viewer mode and cid',
            boot.viewer && boot.viewer.seriesId === '605237' &&
            boot.viewer.contentId === 'b999asqex01885' &&
            boot.viewer.viewer === 'free_streaming' && boot.viewer.cid === 'TEST' &&
            boot.viewer.lin === '0',
            JSON.stringify(boot.viewer));
        check('the page cache id is the content id for a free volume',
            boot.cid === 'b999asqex01885', 'cid=' + boot.cid);
        check('the auth + manifest probe fills in the page count',
            boot.total === PAGES && boot.preview && boot.preview.pages === PAGES,
            'state.total=' + boot.total + ' preview=' + JSON.stringify(boot.preview && boot.preview.pages));
        check('the manifest Dummy/Size fields give the page resolution',
            boot.resolution === CLEAN + ' × ' + CLEAN,
            'resolution=' + JSON.stringify(boot.resolution));
        check('the panel card shows the page count, size and free edition',
            /Pages3/.test(boot.cardText.replace(/\s+/g, '')) &&
            boot.cardText.indexOf(CLEAN + ' × ' + CLEAN) !== -1 && /DMMブックス 無料/.test(boot.cardText),
            JSON.stringify(boot.cardText.slice(0, 140)));
        check('the title comes from the page metadata and the series/volume split',
            boot.stateTitle === TITLE && boot.book && boot.book.series === 'サンプル作品' &&
            boot.book.volNum === 3,
            JSON.stringify(boot.book));
        check('the CloudFront cookies the auth answer set are visible to the page',
            /CloudFront-Policy=/.test(boot.cookies) && /CloudFront-Signature=/.test(boot.cookies),
            boot.cookies.slice(0, 120));
        check('the manifest request carries the cookies as signed-URL parameters',
            stub.manifest.length > 0 && /^POLICY\d+$/.test(stub.manifest[0].policy || '') &&
            /^SIG\d+$/.test(stub.manifest[0].signature || ''),
            JSON.stringify(stub.manifest[0] || null));

        stub.reset();
        const zipA = await runZip(pageA);
        const entriesA = readStoreZip(Buffer.from(zipA.b64, 'base64'));
        check('the ZIP download is offered under the shared archive name',
            zipA.name === TITLE + '.zip', JSON.stringify(zipA.name));
        check('the archive holds one flat page-NNNN.jpg entry per page, in page order',
            JSON.stringify(entriesA.map(e => e.name)) ===
            JSON.stringify(Array.from({ length: PAGES }, (_, i) => 'page-' + String(i + 1).padStart(4, '0') + '.jpg')),
            JSON.stringify(entriesA.map(e => e.name)));
        check('a clean run fetches every page exactly once',
            stub.pages.length === PAGES &&
            stub.pages.map(p => p.page).sort((a, b) => a - b).join(',') === '1,2,3' &&
            stub.pages.every(p => p.status === 200),
            JSON.stringify(stub.pages));
        check('every archive entry is a real JPEG page',
            entriesA.length === PAGES &&
            entriesA.every(e => e.data[0] === 0xff && e.data[1] === 0xd8 && e.data[2] === 0xff),
            entriesA.map(e => e.name + ':' + (e.data.length || 0) + 'B').join(' '));

        const pageMeta = await pageA.evaluate(() => {
            const d = window.__bwddDmm;
            const P = window.__bwddDmmProtocol;
            if (!d.probe) return null;
            return d.probe.pages.map(p => ({
                no: p.no, file: p.file, pattern: p.pattern,
                rects: P.tileRects(128, 128, p.pattern),
            }));
        });
        check('the probe page list exposes the path-derived tile pattern per page',
            pageMeta && pageMeta.length === PAGES && pageMeta.every(p => p.pattern >= 1 && p.pattern <= 4),
            JSON.stringify(pageMeta && pageMeta.map(p => p.pattern)));

        let allTiles = true, mappingDetail = [];
        for (let i = 0; i < PAGES; i++) {
            const rects = pageMeta && pageMeta[i] ? pageMeta[i].rects : [];
            const got = entriesA[i] ? await checkPageImage(i, entriesA[i].data, rects) : { ok: false, detail: 'missing entry' };
            if (!got.ok) allTiles = false;
            if (got.identity) allTiles = false;
            mappingDetail.push('p' + (i + 1) + ':' + (got.ok ? (got.identity ? 'identity' : 'ok') : got.detail));
        }
        check('every page is descrambled: all four 64px tiles land where dmmTileRects says',
            allTiles, mappingDetail.join(' | '));

        //
        // Page B: a 403 after the signature rolled over, then a resume.
        //
        stub.page2 = 'deny';
        pageB = await openViewer(browser, PORT, FREE_PATH);
        await pageB.evaluate(() => window.__bwdd.clearPageCache());
        await waitForProbe(pageB, PAGES);

        stub.reset();
        const zipB1 = await runZip(pageB);
        const entriesB1 = readStoreZip(Buffer.from(zipB1.b64, 'base64'));
        const page2Fetches = stub.pages.filter(p => p.page === 2);
        check('a page refused with 403 is retried after a shared auth refresh',
            page2Fetches.length >= 2 &&
            page2Fetches.every(p => p.status === 403) &&
            new Set(page2Fetches.map(p => p.policy)).size >= 2 &&
            stub.authCalls >= 1,
            'page2 requests=' + JSON.stringify(page2Fetches) + ' authCalls=' + stub.authCalls);
        check('the refused page is the only failure and the rest of the book is archived',
            entriesB1.length === PAGES - 1 &&
            JSON.stringify(entriesB1.map(e => e.name)) === JSON.stringify(['page-0001.jpg', 'page-0003.jpg']) &&
            /Saved 2 of 3 pages/.test(zipB1.details),
            entriesB1.map(e => e.name).join(',') + ' details=' + JSON.stringify(zipB1.details.slice(0, 90)));

        // The signature is renewed; now the previously refused page succeeds.
        stub.page2 = 'allow';
        await sleep(400);
        stub.reset();
        const zipB2 = await runZip(pageB);
        const entriesB2 = readStoreZip(Buffer.from(zipB2.b64, 'base64'));
        check('a resumed run fetches only the page the previous run could not save',
            stub.pages.length === 1 && stub.pages[0].page === 2 && stub.pages[0].status === 200,
            'page requests=' + JSON.stringify(stub.pages));
        check('the resumed run completes the archive from cache plus the one fetch',
            entriesB2.length === PAGES &&
            JSON.stringify(entriesB2.map(e => e.name)) ===
            JSON.stringify(['page-0001.jpg', 'page-0002.jpg', 'page-0003.jpg']) &&
            /ZIP saved: 3 pages/.test(zipB2.details),
            entriesB2.map(e => e.name).join(',') + ' details=' + JSON.stringify(zipB2.details.slice(0, 90)));

        //
        // Page C: the tachiyomi sampler signs with auth_info instead of cookies.
        //
        stub.reset();
        pageC = await openViewer(browser, PORT, SAMPLE_PATH);
        await waitForProbe(pageC, PAGES);
        const sample = await pageC.evaluate(() => {
            const site = window.__bwddSite || {};
            const dmm = window.__bwddDmm || {};
            let preview = null;
            try { preview = site.getPreview ? site.getPreview() : null; } catch (e) {}
            return {
                id: site.id, sample: dmm.sample, viewer: dmm.viewer,
                rawTitle: dmm.rawTitle, stateTitle: dmm.title, total: dmm.total,
                cid: site.getCid ? site.getCid() : null, preview,
            };
        });
        check('a tachiyomi sampler is recognised as the same adapter\'s sample mode',
            sample.id === 'dmm' && sample.sample === true &&
            sample.viewer && sample.viewer.viewer === 'tachiyomi',
            'viewer=' + JSON.stringify(sample.viewer && sample.viewer.viewer) + ' sample=' + sample.sample);
        check('the sampler title is marked and the cache id is namespaced',
            /（試し読み）/.test(sample.stateTitle || '') && sample.cid === 'b999asqex01885sample',
            JSON.stringify(sample.stateTitle) + ' cid=' + JSON.stringify(sample.cid));
        check('the sampler probe uses the auth_info query signing',
            stub.manifest.length === 1 &&
            /^POLICY\d+$/.test(stub.manifest[0].policy || '') &&
            /^SIG\d+$/.test(stub.manifest[0].signature || ''),
            JSON.stringify(stub.manifest[0] || null));
        check('the sampler panel preview reports the trial edition and page count',
            sample.preview && sample.preview.pages === PAGES &&
            /試し読み/.test(sample.preview.type || ''),
            JSON.stringify(sample.preview));
    } finally {
        for (const p of [pageA, pageB, pageC]) {
            if (p) await p.close().catch(() => {});
        }
        await browser.close().catch(() => {});
        await new Promise(r => server.close(r));
    }

    const failed = results.filter(r => !r.pass);
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
