#!/usr/bin/env node
'use strict';
/*
 * CMOA offline descramble test — the viewer-free path.
 *
 * The series worker's hidden frame is the one place a store's viewer is least
 * likely to come up fully, and that is what stopped a series run: readiness
 * wanted `getImageDescrambleCoords`, the frame's viewer did not have it, and the
 * batch refused rather than write scrambled pages.
 *
 * CMOA does not actually need the viewer. The scramble geometry is data in the
 * bibGetCntntInfo response (four tables, encoded against a `k` the client may
 * generate itself), and the page list is a document `sbcGetCntnt.php` returns.
 * This test drives exactly that: a cmoa.jp frame with NO viewer, NO SpeedBinb and
 * NO #content element, a mocked protocol API, and a stored image whose quadrants
 * are swapped. The archive must contain the *unswapped* image, which can only
 * happen if the ported descrambler ran.
 *
 * The tables are re-encoded here the way the server encodes them (same LFSR), so
 * the decode under test is the real one rather than a stubbed table.
 */
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');

const CID = '0000100004_jp_0001';
const CDN = 'https://free-binb-cmoa.akamaized.net/sbc';
const TITLE = 'オフライン テスト 1巻';
const SIZE = 400;          // 2x2 grid of 200px tiles; large enough for `applies()`
const HALF = SIZE / 2;
const PAGES = 2;

// coord `=T-C+pad-body`, piece `=T-C-pad-body`; the consistency check wants
// coord.sign '+' and piece.sign '-'. T=2 across, C=2 down, no padding.
//   coord body 'AAAABADC' -> colShift [0,0], rowShift [0,0], perm [1,0,3,2]
//   piece body 'AAAAABCD' -> identity permutation
// so kt = [1,0,3,2]: every quadrant swaps left for right.
const COORD_TABLE = '=2-2+0-AAAABADC';
const PIECE_TABLE = '=2-2-0-AAAAABCD';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Mirror of the viewer's table encoder (cmoaDecodeTable run backwards). */
function encodeTable(cid, k, value) {
    const plain = JSON.stringify(value);
    const seed = `${cid}:${k}`;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash += seed.charCodeAt(i) << (i % 16);
    hash &= 0x7fffffff;
    if (hash === 0) hash = 0x12345678;
    let state = hash;
    let out = '';
    for (let i = 0; i < plain.length; i++) {
        state = ((state >>> 1) ^ (1210056708 & -(state & 1))) >>> 0;
        out += String.fromCharCode((((plain.charCodeAt(i) - 32 - state) % 94) + 94) % 94 + 32);
    }
    return out;
}

const PAGE_SRCS = Array.from({ length: PAGES }, (_, i) => `pages/o${i + 1}.jpg`);

function ttxDocument() {
    const pages = PAGE_SRCS
        .map((src, i) => `<t-img id="L${String(i + 1).padStart(4, '0')}" src="${src}" orgwidth="${SIZE}" orgheight="${SIZE}" a="0" />`)
        .join('\n');
    // The portrait half must be dropped by the parser, or the page count doubles.
    return `<t-ttx><t-time pagedirection="rtl"></t-time>` +
        `<t-case screen.portrait><t-img src="pages/portrait1.jpg" orgwidth="${SIZE}" orgheight="${SIZE}" /></t-case>` +
        pages + '</t-ttx>';
}

/** Original page: TL red, TR green, BL blue, BR yellow. */
function quadrant(color) {
    return sharp({ create: { width: HALF, height: HALF, channels: 3, background: color } }).png().toBuffer();
}

async function originalImage() {
    const [red, green, blue, yellow] = await Promise.all([
        quadrant({ r: 220, g: 30, b: 40 }), quadrant({ r: 30, g: 200, b: 60 }),
        quadrant({ r: 40, g: 60, b: 220 }), quadrant({ r: 230, g: 210, b: 30 }),
    ]);
    return sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .composite([
            { input: red, left: 0, top: 0 }, { input: green, left: HALF, top: 0 },
            { input: blue, left: 0, top: HALF }, { input: yellow, left: HALF, top: HALF },
        ]).jpeg({ quality: 100 }).toBuffer();
}

/** Stored page: the same quadrants with left and right exchanged. */
async function storedImage() {
    const [red, green, blue, yellow] = await Promise.all([
        quadrant({ r: 220, g: 30, b: 40 }), quadrant({ r: 30, g: 200, b: 60 }),
        quadrant({ r: 40, g: 60, b: 220 }), quadrant({ r: 230, g: 210, b: 30 }),
    ]);
    return sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .composite([
            { input: green, left: 0, top: 0 }, { input: red, left: HALF, top: 0 },
            { input: yellow, left: 0, top: HALF }, { input: blue, left: HALF, top: HALF },
        ]).jpeg({ quality: 100 }).toBuffer();
}

function readStoreZip(buf) {
    const entries = [];
    let off = 0;
    while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
        const size = buf.readUInt32LE(off + 18);
        const nameLen = buf.readUInt16LE(off + 26);
        const extraLen = buf.readUInt16LE(off + 28);
        const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
        const dataStart = off + 30 + nameLen + extraLen;
        entries.push({ name, data: buf.slice(dataStart, dataStart + size) });
        off = dataStart + size;
    }
    return entries;
}

// A page whose reader never came up: no SpeedBinb, no #content, no page objects.
function viewerlessHtml() {
    return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${TITLE}</title></head>
<body>
  <div data-ptbinb="/bib/sws/bibGetCntntInfo.php?u0=1" data-ptbinb-cid="${CID}"></div>
  <script>
    // Deliberately no window.SpeedBinb and no viewer: this frame is the store's
    // own page with nothing initialised on it.
    window.__capturedZip = null;
    const __origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try {
        if (this.download) {
          const name = this.download;
          fetch(this.href).then(r => r.arrayBuffer()).then(ab => {
            const bytes = new Uint8Array(ab);
            let bin = '';
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            window.__capturedZip = { name: name, size: bytes.length, b64: btoa(bin) };
          }).catch(e => { window.__capturedZip = { name: name, error: String(e) }; });
          return;
        }
      } catch (e) {}
      return __origClick.apply(this, arguments);
    };
  </script>
</body></html>`;
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

const near = (a, b, tol) => Math.abs(a - b) <= tol;
function quadrantsOk(got, tol = 42) {
    const want = { tl: { r: 220, g: 30, b: 40 }, tr: { r: 30, g: 200, b: 60 }, bl: { r: 40, g: 60, b: 220 }, br: { r: 230, g: 210, b: 30 } };
    const bad = [];
    for (const k of ['tl', 'tr', 'bl', 'br']) {
        if (!near(got[k].r, want[k].r, tol) || !near(got[k].g, want[k].g, tol) || !near(got[k].b, want[k].b, tol)) {
            bad.push(k + ' got ' + JSON.stringify(got[k]) + ' want ' + JSON.stringify(want[k]));
        }
    }
    return { ok: bad.length === 0, detail: bad.length ? bad.join('; ') : 'all four quadrants in place' };
}

(async () => {
    const results = [];
    const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  \u2014 ' + d); };

    const original = await originalImage();
    const stored = await storedImage();
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    let page = null;
    try {
        page = await browser.newPage();
        const hits = { info: 0, list: 0, img: 0, infoCids: [], infoMissingU0: 0, listCids: [] };
        const consoleLines = [];
        page.on('console', m => { const t = m.text(); if (/\[bwdd\/cmoa\]/.test(t)) consoleLines.push(t); });
        await page.setRequestInterception(true);
        page.on('request', req => {
            const url = req.url();
            if (url.includes('/bib/sws/bibGetCntntInfo.php')) {
                hits.info++;
                const u = new URL(url);
                const cid = u.searchParams.get('cid') || CID;
                const k = u.searchParams.get('k') || '';
                hits.infoCids.push(cid);
                if (!u.searchParams.get('u0')) hits.infoMissingU0++;
                const item = {
                    ContentID: '100001677100001',
                    ContentsServer: CDN,
                    Title: TITLE, SubTitle: TITLE, p: 'TOKEN-OFFLINE',
                    ViewMode: 2, ContentDate: '99991031163056',
                    Authors: [{ Name: 'x' }],
                    stbl: encodeTable(cid, k, []),
                    ttbl: encodeTable(cid, k, []),
                    ctbl: encodeTable(cid, k, Array(8).fill(COORD_TABLE)),
                    ptbl: encodeTable(cid, k, Array(8).fill(PIECE_TABLE)),
                };
                return req.respond({
                    status: 200,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                    body: JSON.stringify({ result: 1, items: [item] }),
                });
            }
            if (url.includes('sbcGetCntnt.php')) {
                hits.list++;
                const lu = new URL(url);
                hits.listCids.push(lu.searchParams.get('cid'));
                return req.respond({
                    status: 200,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                    body: JSON.stringify({ result: 1, ImageClass: 'test', ttx: ttxDocument() }),
                });
            }
            if (url.includes('sbcGetImg.php')) {
                const u = new URL(url);
                if (u.hostname.endsWith('.')) {
                    return req.respond({ status: 403, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'no dotted host' });
                }
                hits.img++;
                return req.respond({
                    status: 200,
                    headers: { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*' },
                    body: stored,
                });
            }
            if (url.includes('/bib/speedreader/') || url.includes('/reader/sample/')) {
                return req.respond({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: viewerlessHtml() });
            }
            if (/127\.0\.0\.1:62642|learnnatively|manga-kotoba/.test(url)) return req.abort();
            return req.continue();
        });

        // The frame is on the volume's own URL but has no viewer at all, and the
        // URL spells the volume the way a series row link does: a numeric
        // content_id. bibGetCntntInfo answers that spelling with `result: -100`,
        // so the run has to translate it before it asks.
        await page.goto('https://www.cmoa.jp/reader/sample/?title_id=214822&content_id=100002148220001&bwddDebug=1',
            { waitUntil: 'domcontentloaded' });
        await page.addScriptTag({ content: fs.readFileSync(US, 'utf8') });
        await sleep(1200);

        const env = await page.evaluate(() => ({
            zip: !!document.querySelector('button.bwdd-btn.zip'),
            speedbinb: typeof window.SpeedBinb,
            content: !!document.getElementById('content'),
        }));
        check('the frame really has no viewer (no SpeedBinb, no #content)',
            env.speedbinb === 'undefined' && !env.content,
            'SpeedBinb=' + env.speedbinb + ' #content=' + env.content + ' zipButton=' + env.zip);

        await page.click('button.bwdd-btn.zip');
        let finished = true;
        try {
            await page.waitForFunction(() => !!window.__capturedZip, { timeout: 30000 });
        } catch (e) { finished = false; }

        check('a viewerless frame still downloads the volume',
            finished && hits.img >= PAGES,
            'finished=' + finished + ' images fetched=' + hits.img);
        check('the page list and the scramble tables came from the protocol, not a viewer',
            hits.info > 0 && hits.list > 0,
            'content info=' + hits.info + ' page list=' + hits.list);

        // The series row link's numeric content_id must never reach the API:
        // every call is expected to carry the `_jp_` spelling the API accepts,
        // and the u0 the viewer's own calls always include.
        const spellings = hits.infoCids.concat(hits.listCids);
        const allJp = spellings.length > 0 && spellings.every(c => /^[0-9]{10}_jp_[0-9]{4}$/.test(String(c)));
        check('a numeric content_id is translated to the cid the API accepts',
            allJp,
            'sent=' + JSON.stringify(spellings));
        check("the viewer-free requests carry u0 like the viewer's own",
            hits.info > 0 && hits.infoMissingU0 === 0,
            hits.infoMissingU0 + ' of ' + hits.info + ' content-info calls lacked u0');

        const hint = await page.evaluate(() => {
            const box = document.querySelector('.bwdd-hint-box');
            return box ? box.textContent.trim() : '';
        });
        if (!finished) console.log('   [hint] ' + hint.slice(0, 240));
        const captured = await page.evaluate(() => window.__capturedZip);
        const entries = captured && captured.b64 ? readStoreZip(Buffer.from(captured.b64, 'base64')) : [];
        check('every page reached the archive', entries.length === PAGES,
            entries.length + '/' + PAGES + ' entries' + (captured && captured.error ? ' error=' + captured.error : ''));

        if (entries.length) {
            const got = await tileCenters(entries[0].data);
            const ok = quadrantsOk(got);
            check('the stored image was reassembled from the tables alone',
                ok.ok, ok.detail + ' (size ' + got.width + 'x' + got.height + ')');
            // The stored bytes were the swapped ones, so an untouched passthrough
            // would show green top-left. Naming that makes the check meaningful.
            check('the archive is not the stored (scrambled) layout passed through',
                !near(got.tl.g, 200, 42) && near(got.tl.r, 220, 42),
                'top-left=' + JSON.stringify(got.tl) + ' (stored layout would be green)');
        } else {
            check('the stored image was reassembled from the tables alone', false, 'no entries');
            check('the archive is not the stored (scrambled) layout passed through', false, 'no entries');
        }

        console.log('\n--- summary ---');
        console.log('hits     : info=' + hits.info + ' list=' + hits.list + ' img=' + hits.img);
        console.log('console  : ' + JSON.stringify(consoleLines.slice(0, 4)));
        console.log('archive  : ' + entries.length + ' entries from ' + (captured ? captured.name : 'nothing'));
    } finally {
        if (page) await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }

    const failed = results.filter(r => !r.pass);
    fs.writeFileSync(path.join(__dirname, 'cmoa_offline_descramble_result.json'), JSON.stringify({ results }, null, 2));
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
