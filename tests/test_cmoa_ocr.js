#!/usr/bin/env node
'use strict';
/*
 * CMOA mokuro parity test.
 *
 * The CMOA ZIP test proves the fetch/descramble/naming half of the adapter. This
 * one proves the other half of "full parity": that the CMOA pipeline drives the
 * *same* mokuro-bridge conversation as BookWalker, through the shared run
 * harness.
 *
 * A stub bridge speaks the real protocol (health, upload-methods,
 * session/start, session/<id>/page, session/<id>/cover, session/<id>/status,
 * session/<id>/finalize as NDJSON) and records everything it is sent, so the
 * test can assert on the conversation itself:
 *
 *   - the session opens with the SHARED archive name, not a CMOA-specific one,
 *   - every page is POSTed exactly once with the right page_num, so the bridge
 *     never receives pages shuffled,
 *   - the bytes the bridge receives are the DESCRAMBLED page (verified
 *     pixel-by-pixel), i.e. OCR runs on the readable image, not the raw tiles,
 *   - the cover is pushed early from page 1,
 *   - finalize runs and its result is reported back into the panel.
 *
 * The storefront is a real local HTTPS server reached as www.cmoa.jp via
 * Chrome's host resolver, so the page origin genuinely is the store's hostname
 * and no request interception is used. Interception is deliberately avoided:
 * puppeteer cannot relay a binary multipart upload faithfully (postData() is
 * string-only, and the bridge uploads JPEGs), and it will not carry a
 * public-origin -> loopback hop at all, which is exactly the hop the bridge is.
 */
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');

const CID = '0000249510_jp_0001';
// The viewer renames document.title to its own label once it boots, and the
// store's SEO title on the real page advertises a *different* volume in the
// series than the one being read, so the API's SubTitle is the only value that
// can be trusted. These two deliberately disagree: the test can then prove the
// adapter used the API rather than the scraped DOM.
const VIEWER_LABEL = 'BinB Speed Reader';
const MESSY_TITLE = '無料・試し読みページ サンプル店舗作品 2巻（サンプルコミックス） ｜ サンプル作者 ｜ 漫画（マンガ）・電子書籍のコミックシーモア';
const API_TITLE = 'サンプル店舗作品 1巻';
const ARCHIVE = API_TITLE;

const SIZE = 240;
const HALF = SIZE / 2;
const PAGES = 3;

function tileColors(pageIdx) {
    const shift = pageIdx * 50;
    const at = v => Math.max(0, Math.min(255, v));
    return {
        red: { r: at(220 - shift), g: at(30 + shift), b: 40 },
        green: { r: 30, g: at(200 - shift), b: at(60 + shift) },
        blue: { r: at(40 + shift), g: 60, b: at(220 - shift) },
        yellow: { r: at(230 - shift), g: at(210 - shift), b: 30 },
    };
}

async function buildScrambled(pageIdx) {
    const c = tileColors(pageIdx);
    const tile = color => sharp({ create: { width: HALF, height: HALF, channels: 3, background: color } }).png().toBuffer();
    const [green, red, yellow, blue] = await Promise.all([
        tile(c.green), tile(c.red), tile(c.yellow), tile(c.blue),
    ]);
    return sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .composite([
            { input: green, left: 0, top: 0 },
            { input: red, left: HALF, top: 0 },
            { input: yellow, left: 0, top: HALF },
            { input: blue, left: HALF, top: HALF },
        ])
        .jpeg({ quality: 100 })
        .toBuffer();
}

// Minimal multipart/form-data part extractor (no dependency needed).
function multipartPart(body, boundary, fieldName) {
    const delim = Buffer.from('--' + boundary);
    let idx = body.indexOf(delim);
    while (idx !== -1) {
        const next = body.indexOf(delim, idx + delim.length);
        if (next === -1) break;
        const part = body.slice(idx + delim.length, next);
        const sep = part.indexOf('\r\n\r\n');
        if (sep !== -1) {
            const headers = part.slice(0, sep).toString('utf8');
            if (new RegExp('name="' + fieldName + '"').test(headers)) {
                let data = part.slice(sep + 4);
                if (data.slice(-2).toString() === '\r\n') data = data.slice(0, -2);
                return { headers, data };
            }
        }
        idx = next;
    }
    return null;
}

async function tileCenters(imageBuffer) {
    const { data, info } = await sharp(imageBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    const at = (x, y) => { const i = (y * info.width + x) * ch; return { r: data[i], g: data[i + 1], b: data[i + 2] }; };
    const cx = Math.floor(info.width / 4), cy = Math.floor(info.height / 4);
    return {
        width: info.width, height: info.height,
        tl: at(cx, cy), tr: at(info.width - cx, cy),
        bl: at(cx, info.height - cy), br: at(info.width - cx, info.height - cy),
    };
}

async function checkTilePositions(imageBuffer, pageIdx) {
    const c = tileColors(pageIdx);
    const got = await tileCenters(imageBuffer);
    const tol = 42;
    const problems = [];
    const cmp = (label, actual, expected) => {
        if (Math.abs(actual.r - expected.r) > tol || Math.abs(actual.g - expected.g) > tol || Math.abs(actual.b - expected.b) > tol) {
            problems.push(label + '=(' + actual.r + ',' + actual.g + ',' + actual.b + ') want (' + expected.r + ',' + expected.g + ',' + expected.b + ')');
        }
    };
    cmp('TL', got.tl, c.red); cmp('TR', got.tr, c.green);
    cmp('BL', got.bl, c.blue); cmp('BR', got.br, c.yellow);
    return { ok: problems.length === 0, detail: problems.join('; ') || 'received page reassembled at ' + got.width + 'x' + got.height };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A stand-in for one of the bridge's fetch-proxy ports. It serves the same
// bytes the CDN would, so a run that uses it still produces correct pages and
// the test can prove the port was genuinely usable rather than merely present.
function startFakeProxy(scrambledBySrc) {
    const seen = [];
    const server = http.createServer((req, res) => {
        const cors = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            // x-bwdd-upstream is a custom header, so the browser preflights the
            // request; without this the real GET never leaves the page.
            'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
            'Access-Control-Allow-Private-Network': 'true',
            'Access-Control-Max-Age': '600',
        };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
        const u = new URL(req.url || '/', 'http://127.0.0.1');
        // The bridge names the CDN in this header instead of in the URL.
        seen.push({ upstream: req.headers['x-bwdd-upstream'], path: u.pathname, q: u.searchParams.get('q') });
        cors['Content-Type'] = 'image/jpeg';
        if (u.searchParams.get('q') === '0') { res.writeHead(403, cors); return res.end('denied'); }
        const body = scrambledBySrc.get(u.searchParams.get('src'));
        if (!body) { res.writeHead(404, cors); return res.end('no page'); }
        res.writeHead(200, cors);
        res.end(body);
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
    });
}

function startBridge(advertisePorts, advertiseUpstreams) {
    const log = { started: null, pages: [], cover: null, finalized: false, status: 0, health: 0 };
    const server = http.createServer((req, res) => {
        const cors = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const url = req.url || '';
            const json = (code, obj) => {
                res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, cors));
                res.end(JSON.stringify(obj));
            };

            if (url === '/health') {
                log.health++;
                return json(200, {
                    app: 'mokuro-bridge', status: 'ok', busy: false,
                    output_dir: '/tmp/out', upload_method_default: 'local',
                    upload_methods: [{ id: 'local', name: 'Local', configured: true, default: true }],
                    fetchProxyPorts: advertisePorts || [],
                    fetchUpstreams: advertiseUpstreams === undefined ? ['*'] : advertiseUpstreams,
                });
            }
            if (url === '/upload-methods') {
                return json(200, {
                    methods: [{ id: 'local', name: 'Local', configured: true, default: true }],
                    upload_method_default: 'local',
                });
            }
            if (url === '/session/start') {
                const b = (req.headers['content-type'] || '').split('boundary=')[1];
                const t = b ? multipartPart(body, b, 'title') : null;
                log.started = { title: t ? t.data.toString('utf8') : null };
                return json(200, { session_id: 'sess-cmoa-1', safe_title: ARCHIVE, title: ARCHIVE });
            }
            let m = url.match(/^\/session\/([^/]+)\/page$/);
            if (m) {
                const b = (req.headers['content-type'] || '').split('boundary=')[1];
                const file = b ? multipartPart(body, b, 'page') : null;
                const num = b ? multipartPart(body, b, 'page_num') : null;
                const name = b ? multipartPart(body, b, 'filename') : null;
                log.pages.push({
                    pageNum: num ? parseInt(num.data.toString('utf8'), 10) : null,
                    filename: name ? name.data.toString('utf8') : null,
                    bytes: file ? file.data : null,
                });
                return json(200, { ok: true, received: log.pages.length });
            }
            m = url.match(/^\/session\/([^/]+)\/cover$/);
            if (m) {
                const b = (req.headers['content-type'] || '').split('boundary=')[1];
                const file = b ? multipartPart(body, b, 'cover') : null;
                log.cover = { bytes: file ? file.data : null };
                return json(200, { file: ARCHIVE + '.webp', size: file ? file.data.length : 0 });
            }
            m = url.match(/^\/session\/([^/]+)\/status$/);
            if (m) {
                log.status++;
                return json(200, {
                    pages_received: log.pages.length,
                    pages_ocr_done: log.pages.length,
                    busy: true,
                });
            }
            m = url.match(/^\/session\/([^/]+)\/finalize$/);
            if (m) {
                log.finalized = true;
                res.writeHead(200, Object.assign({ 'Content-Type': 'application/x-ndjson' }, cors));
                const cbz = ARCHIVE + '.cbz';
                res.write(JSON.stringify({ stage: 'upload', files: [{ file: cbz, total_bytes: 4096 }] }) + '\n');
                res.write(JSON.stringify({ stage: 'upload_progress', file: cbz, current_bytes: 2048, total_bytes: 4096, percent: 50 }) + '\n');
                res.write(JSON.stringify({
                    stage: 'done', file: cbz, remote_path: '/tmp/out/' + cbz,
                    reader_url: 'https://reader.mokuro.app/',
                }) + '\n');
                return res.end();
            }
            return json(404, { detail: 'not found: ' + url });
        });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, log }));
    });
}

const VIEWER_SETUP = `
window.__fakeReader = {
  cid: ${JSON.stringify(CID)},
  requestUrl: location.origin + '/bib/sws/bibGetCntntInfo.php?cid=' + encodeURIComponent(${JSON.stringify(CID)}) + '&dmytime=1790280604161&k=FAKEKEY&u0=1',
  getImageDescrambleCoords: function (image, w, h) {
    const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
    return { width: w, height: h, transfers: [{ index: 0, coords: [
      { xsrc: hw, ysrc: 0,  xdest: 0,  ydest: 0,  width: hw, height: hh },
      { xsrc: 0,  ysrc: 0,  xdest: hw, ydest: 0,  width: hw, height: hh },
      { xsrc: hw, ysrc: hh, xdest: 0,  ydest: hh, width: hw, height: hh },
      { xsrc: 0,  ysrc: hh, xdest: hw, ydest: hh, width: hw, height: hh }
    ] }] };
  }
};
window.__fakeViewer = {
  content: { page: window.__PAGES, bibliography: { title: document.title } },
  get reader() { return window.__fakeReader; }
};
window.SpeedBinb = { getInstance: function (id) { if (id !== 'content') throw new Error('nope'); return window.__fakeViewer; } };
`;

function pageHtml(pageSrcs) {
    const pages = pageSrcs.map((src, i) =>
        '{ id: ' + JSON.stringify('p' + (i + 1)) + ', image: { id: ' + JSON.stringify('p' + (i + 1)) + ', src: ' + JSON.stringify(src) + ', orgwidth: ' + SIZE + ', orgheight: ' + SIZE + ', pagespread: 0 } }'
    ).join(',\n      ');
    return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>' + MESSY_TITLE + '</title></head>\n' +
        '<body>\n' +
        '  <span id="menu_header_tittle">' + MESSY_TITLE + '</span>\n' +
        '  <div data-ptbinb="/bib/sws/bibGetCntntInfo.php?u0=1" data-ptbinb-cid="' + CID + '"></div>\n' +
        '  <div id="content"></div>\n' +
        '  <script>window.__PAGES = [ ' + pages + ' ];' + VIEWER_SETUP + '</script>\n' +
        '</body></html>';
}

// One real HTTPS server for the storefront, the content-info API and the image
// CDN (routed by path; both store hostnames resolve here).
function startApp(pageSrcs, scrambledBySrc, state) {
    const tls = {
        key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')),
    };
    const server = https.createServer(tls, (req, res) => {
        const cors = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
        const u = new URL(req.url || '/', 'https://www.cmoa.jp');
        if (u.pathname === '/bib/speedreader/') {
            res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, cors));
            return res.end(pageHtml(pageSrcs));
        }
        if (u.pathname === '/bib/sws/bibGetCntntInfo.php') {
            res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
            return res.end(JSON.stringify(state.contentInfo));
        }
        if (/sbcGetImg\.php$/.test(u.pathname)) {
            const q = u.searchParams.get('q');
            state.qualities.push(q);
            if (q === '0') { res.writeHead(403, cors); return res.end('denied'); }
            const body = scrambledBySrc.get(u.searchParams.get('src'));
            if (!body) { res.writeHead(404, cors); return res.end('no page'); }
            res.writeHead(200, Object.assign({ 'Content-Type': 'image/jpeg' }, cors));
            return res.end(body);
        }
        res.writeHead(404, cors);
        return res.end('not found');
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

(async () => {
    const pageSrcs = Array.from({ length: PAGES }, (_, i) => 'pages/page' + (i + 1) + '.jpg');
    const scrambled = await Promise.all(Array.from({ length: PAGES }, (_, i) => buildScrambled(i)));
    const scrambledBySrc = new Map(pageSrcs.map((src, i) => [src, scrambled[i]]));

    const results = [];
    const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };

    const state = { qualities: [], contentInfo: null };
    const proxyPort = await startFakeProxy(scrambledBySrc);
    const bridge = await startBridge([proxyPort.port], ['*']);
    const app = await startApp(pageSrcs, scrambledBySrc, state);
    // ContentsServer points at the local app server: the CDN hostname but the
    // test port, so image fetches are genuine cross-origin https requests.
    state.contentInfo = {
        result: 1,
        items: [{
            ContentID: '100002495100001',
            ContentsServer: 'https://free-binb-cmoa.akamaized.net:' + app.port + '/sbc',
            Title: MESSY_TITLE,
            SubTitle: API_TITLE,
            p: 'TOKEN-ONE',
            ViewMode: 2,
            ContentDate: '99991031163056',
        }],
    };

    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true,
        args: [
            '--no-sandbox',
            '--ignore-certificate-errors',
            // Resolve the store hostnames to the local test server so the page
            // origin really is https://www.cmoa.jp (the adapter keys off
            // location.hostname) with no request interception. The stat
            // providers are mapped too so their lookups fail fast instead of
            // reaching the network.
            '--host-resolver-rules=MAP www.cmoa.jp 127.0.0.1, MAP free-binb-cmoa.akamaized.net 127.0.0.1, MAP learnnatively.com 127.0.0.1, MAP manga-kotoba.com 127.0.0.1, MAP * 127.0.0.1',
        ],
    });
    let page;
    try {
        page = await browser.newPage();
        page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
        page.on('console', m => {
            const t = m.text();
            if (/\[bwdd\/cmoa\].*(failed|error)|run failed/i.test(t)) console.log('[console]', t.slice(0, 240));
        });

        await page.goto('https://www.cmoa.jp:' + app.port + '/bib/speedreader/?cid=' + CID + '&u0=1&bwddDebug=1', { waitUntil: 'domcontentloaded' });
        const src = fs.readFileSync(US, 'utf8');
        const patched = src.replace("'http://127.0.0.1:62642'", "'http://127.0.0.1:" + bridge.port + "'");
        if (patched === src) throw new Error('bridge URL substitution failed');
        await page.addScriptTag({ content: patched });

        // The viewer renames document.title to its own label, exactly as the real
        // SpeedBinb viewer does.
        await page.evaluate(label => { document.title = label; }, VIEWER_LABEL);
        // Force the live condition explicitly and deterministically: the
        // contents server and a page token are already known (on the real page
        // the viewer has fetched images long before the panel appears), while
        // the volume title is still unknown. That combination is what used to
        // suppress the content-info request, and with it SubTitle.
        await page.evaluate(async port => {
            for (let i = 0; i < 100 && !window.__bwddCmoa; i++) await new Promise(r => setTimeout(r, 50));
            if (!window.__bwddCmoa) throw new Error('no debug handle');
            window.__bwddCmoa.contentsServer = 'https://free-binb-cmoa.akamaized.net:' + port + '/sbc';
            window.__bwddCmoa.token = 'TOKEN-PERF';
        }, app.port);

        await page.waitForFunction(
            () => window.__bwddCmoa && window.__bwddCmoa.ready && window.__bwddCmoa.pages.length > 0,
            { timeout: 20000 }
        );
        const detected = await page.evaluate(() => ({
            id: window.__bwddSite && window.__bwddSite.id,
            host: location.hostname,
            docTitle: document.title,
            sawServer: !!window.__bwddCmoa && !!window.__bwddCmoa.contentsServer,
            sawToken: !!window.__bwddCmoa && !!window.__bwddCmoa.token,
            title: window.__bwddCmoa && window.__bwddCmoa.title,
        }));
        check('the page really is the store hostname and selects the CMOA adapter',
            detected.host === 'www.cmoa.jp' && detected.id === 'cmoa',
            'host=' + detected.host + ' adapter=' + detected.id);
        check('the pre-existing server and token the live page already has are in place',
            detected.sawServer && detected.sawToken,
            'server=' + detected.sawServer + ' token=' + detected.sawToken);
        check('the viewer has renamed document.title away from the volume',
            detected.docTitle === VIEWER_LABEL, JSON.stringify(detected.docTitle));
        check('the title comes from the API SubTitle, not the scraped SEO title',
            detected.title === API_TITLE, JSON.stringify(detected.title));

        await page.click('button.bwdd-btn.ocr');
        const deadline = Date.now() + 90000;
        while (!bridge.log.finalized && Date.now() < deadline) await sleep(300);
        await sleep(800);

        const panel = await page.evaluate(() => {
            const d = document.querySelector('.bwdd-hint-box');
            const btns = Array.from(document.querySelectorAll('button'));
            const reader = btns.find(b => /mokuro|reader/i.test(b.textContent || '') && b.offsetParent !== null);
            return {
                details: d ? d.textContent.replace(/\s+/g, ' ').trim() : null,
                readerVisible: !!reader,
            };
        });

        console.log('[bridge log]', JSON.stringify({
            health: bridge.log.health, started: bridge.log.started,
            pages: bridge.log.pages.length, cover: !!bridge.log.cover,
            finalized: bridge.log.finalized, status: bridge.log.status,
        }));

        check('the run opens a bridge session with the shared archive name',
            !!bridge.log.started && bridge.log.started.title === ARCHIVE,
            'session title=' + JSON.stringify(bridge.log.started && bridge.log.started.title));

        check('every page reaches the bridge exactly once',
            bridge.log.pages.length === PAGES, bridge.log.pages.length + '/' + PAGES + ' page POSTs');

        const order = bridge.log.pages.map(p => p.pageNum);
        check('pages are streamed to the bridge in reading order',
            JSON.stringify(order) === JSON.stringify([1, 2, 3]), 'page_num=' + JSON.stringify(order));

        const names = bridge.log.pages.map(p => p.filename);
        const wantNames = Array.from({ length: PAGES }, (_, i) => 'page-' + String(i + 1).padStart(4, '0') + '.jpg');
        check('pages are named with the shared page-NNNN.jpg convention',
            JSON.stringify(names) === JSON.stringify(wantNames), JSON.stringify(names));

        check('the cover is pushed early from the first page',
            !!(bridge.log.cover && bridge.log.cover.bytes && bridge.log.cover.bytes.length > 0),
            bridge.log.cover && bridge.log.cover.bytes ? bridge.log.cover.bytes.length + ' cover bytes' : 'no cover bytes');

        check('the session is finalized after all pages are streamed',
            bridge.log.finalized === true, 'finalize called=' + bridge.log.finalized);

        // NB: the session status poll runs on a ~700ms interval and only shows
        // up on long runs; three tiny pages finish before the first tick, so the
        // meaningful signal here is that the bridge was discovered at all.
        check('the panel discovers the bridge before the run',
            bridge.log.health > 0, bridge.log.health + ' /health probes');

        const first = bridge.log.pages[0];
        if (first && first.bytes) {
            const r = await checkTilePositions(first.bytes, 0);
            check('OCR receives the DESCRAMBLED page, not the raw shuffled tiles', r.ok, r.detail);
        } else {
            check('OCR receives the DESCRAMBLED page, not the raw shuffled tiles', false, 'no page bytes recorded');
        }
        const last = bridge.log.pages[PAGES - 1];
        if (last && last.bytes) {
            const r = await checkTilePositions(last.bytes, PAGES - 1);
            check('each streamed page carries its own reassembled image', r.ok, r.detail);
        } else {
            check('each streamed page carries its own reassembled image', false, 'missing last page');
        }
        if (bridge.log.cover && bridge.log.cover.bytes) {
            const r = await checkTilePositions(bridge.log.cover.bytes, 0);
            check('the early cover is the reassembled first page', r.ok, r.detail);
        } else {
            check('the early cover is the reassembled first page', false, 'no cover bytes');
        }

        const lanes = await page.evaluate(() => {
            const L = window.__bwdd.allLanes();
            return { kinds: L.map(l => l.kind), names: L.map(l => l.name) };
        });
        check('CMOA enables the trailing-dot lane, a second origin past the 6-socket cap',
            lanes.kinds.includes('dot'),
            'lanes=' + JSON.stringify(lanes.names));
        check('CMOA uses the bridge fetch-proxy ports when the bridge is generic',
            proxyPort.seen.length > 0,
            proxyPort.seen.length + ' request(s) through the advertised port');
        check('the proxy port is told which CDN to fetch',
            proxyPort.seen.length > 0 &&
                proxyPort.seen.every(r => r.upstream === 'free-binb-cmoa.akamaized.net'),
            'upstream header=' + JSON.stringify([...new Set(proxyPort.seen.map(r => r.upstream))]));

        // A bridge that is still pinned to BookWalker's CDN advertises only that
        // host, and then a CMOA path must not be aimed at it. This is the case
        // that would otherwise fetch the wrong store's bytes.
        const hostRule = await page.evaluate(() => {
            const before = window.__bwdd.proxyCanServe('free-binb-cmoa.akamaized.net');
            window.__bwdd.setProxyUpstreams(['bw-bv-epubs.bookwalker.jp']);
            const cмоaAfter = window.__bwdd.proxyCanServe('free-binb-cmoa.akamaized.net');
            const bwAfter = window.__bwdd.proxyCanServe('bw-bv-epubs.bookwalker.jp');
            window.__bwdd.setProxyUpstreams(['*']);
            return { before, cмоaAfter, bwAfter };
        });
        check('a BookWalker-only bridge is not used for CMOA pages',
            hostRule.before === true && hostRule.cмоaAfter === false && hostRule.bwAfter === true,
            'generic=' + hostRule.before + ' cmoa-on-bw-bridge=' + hostRule.cмоaAfter +
            ' bw-on-bw-bridge=' + hostRule.bwAfter);

        check('the panel reports where the volume was stored',
            !!panel.details && /tmp\/out|stored|uploaded/i.test(panel.details),
            JSON.stringify((panel.details || '').slice(0, 120)));
        check('the reader jump button is offered after a successful OCR run',
            panel.readerVisible === true, 'reader button visible=' + panel.readerVisible);

    } finally {
        if (page) await page.close().catch(() => {});
        await browser.close().catch(() => {});
        bridge.server.close();
        app.server.close();
        proxyPort.server.close();
    }

    const failed = results.filter(r => !r.pass);
    fs.writeFileSync(path.join(__dirname, 'cmoa_ocr_result.json'), JSON.stringify({ results }, null, 2));
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
