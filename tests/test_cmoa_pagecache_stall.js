#!/usr/bin/env node
'use strict';
/*
 * CMOA page-cache stall test.
 *
 * The real-world shape this covers: the download bar races to N-4 of N pages,
 * sits there, then completes, and the ZIP never arrives until the page is
 * reloaded - at which point the run re-reads everything from the page cache and
 * finishes instantly. The cause is the cache read that sits in front of every
 * fetch: `getCachedPage` awaited IndexedDB with no deadline and settled only on
 * the read's own success/error, so a store wedged behind a write burst (or a
 * transaction that aborts, which fires neither) parked the page forever. The
 * page never issued a request; the hedge watchdog still settled it, which is why
 * the bars completed while `Promise.all(workers)` never returned and the ZIP was
 * never built. A reload "fixed" it only because a warm cache answers instantly.
 *
 * This test removes IndexedDB entirely: `indexedDB.open` returns a request whose
 * callbacks never fire, so `openPageDB()` never settles. Every page must still
 * fetch, settle and reach the archive.
 *   - before the fix the run never reaches the ZIP (each page waits forever);
 *   - after it, the first cache read gives up and the run finishes normally.
 */
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');

const CID = '0000249510_jp_0001';
const CDN = 'https://free-binb-cmoa.akamaized.net/sbc';
const TITLE = '\u7121\u6599\u30fb\u8a66\u3057\u8aad\u307f\u30da\u30fc\u30b8 \u30c6\u30b9\u30c8 1\u5dfb';
const SIZE = 64;
const PAGES = 12;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pageImage(i) {
    return sharp({
        create: { width: SIZE, height: SIZE, channels: 3, background: { r: (i * 9) % 200 + 20, g: 60, b: 140 } },
    }).jpeg({ quality: 90 }).toBuffer();
}

const VIEWER_SETUP = `
window.__imageHits = [];
// The wedge: an open request that will never call back. openPageDB must not
// let a page - or the run - wait on it forever.
indexedDB.open = function () {
  return { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: null, error: null };
};
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
  content: { page: window.__PAGES, bibliography: { title: document.title, author: '', publisher: '', description: '' } },
  get reader() { return window.__fakeReader; }
};
window.SpeedBinb = { getInstance: function (id) {
  if (id !== 'content') throw new Error('Element not found: ' + id);
  return window.__fakeViewer;
} };
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
`;

function pageHtml(pageSrcs) {
    const pages = pageSrcs.map((src, i) =>
        `{ id: ${JSON.stringify('p' + (i + 1))}, image: { id: ${JSON.stringify('p' + (i + 1))}, src: ${JSON.stringify(src)}, orgwidth: ${SIZE}, orgheight: ${SIZE}, pagespread: 0 } }`
    ).join(',\n      ');
    return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${TITLE}</title></head>
<body>
  <div data-ptbinb="/bib/sws/bibGetCntntInfo.php?u0=1" data-ptbinb-cid="${CID}"></div>
  <div id="content"></div>
  <script>
    window.__PAGES = [ ${pages} ];
    ${VIEWER_SETUP}
  </script>
</body></html>`;
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

(async () => {
    const results = [];
    const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  \u2014 ' + d); };

    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    let page = null;
    try {
        const pageSrcs = Array.from({ length: PAGES }, (_, i) => `pages/page${i + 1}.jpg`);
        const images = new Map();
        for (let i = 0; i < PAGES; i++) images.set(pageSrcs[i], await pageImage(i));

        page = await browser.newPage();
        await page.setRequestInterception(true);

        const html = pageHtml(pageSrcs);
        const contentInfo = JSON.stringify({
            result: 1,
            items: [{
                ContentID: '100002495100001', ContentsServer: CDN, Title: TITLE, SubTitle: TITLE,
                p: 'TOKEN-ONE', ViewMode: 2, ContentDate: '99991031163056', Authors: [{ Name: 'x' }],
            }],
        });
        const hits = new Map();

        page.on('request', req => {
            const url = req.url();
            if (url.includes('/bib/sws/bibGetCntntInfo.php')) {
                return req.respond({
                    status: 200,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                    body: contentInfo,
                });
            }
            if (url.includes('/bib/speedreader/')) {
                return req.respond({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html });
            }
            if (url.includes('sbcGetImg.php')) {
                const u = new URL(url);
                if (u.hostname.endsWith('.')) {
                    return req.respond({ status: 403, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'no dotted host' });
                }
                const src = u.searchParams.get('src');
                hits.set(src, (hits.get(src) || 0) + 1);
                const body = images.get(src);
                if (!body) return req.respond({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'no page' });
                return req.respond({ status: 200, headers: { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*' }, body });
            }
            if (/127\.0\.0\.1:62642|learnnatively|manga-kotoba/.test(url)) return req.abort();
            return req.continue();
        });

        await page.goto('https://www.cmoa.jp/bib/speedreader/?cid=' + CID + '&u0=1&bwddDebug=1', { waitUntil: 'domcontentloaded' });
        await page.addScriptTag({ content: fs.readFileSync(US, 'utf8') });
        await sleep(1200);

        const ready = await page.evaluate(() => ({
            zip: !!document.querySelector('button.bwdd-btn.zip'),
            wedge: typeof indexedDB.open === 'function',
        }));
        check('the synthetic volume is ready to download', ready.zip, 'zip button=' + ready.zip);

        const t0 = Date.now();
        await page.click('button.bwdd-btn.zip');
        let finished = true;
        try {
            await page.waitForFunction(() => !!window.__capturedZip, { timeout: 20000 });
        } catch (e) {
            finished = false;
        }
        const elapsed = Date.now() - t0;

        check('a wedged page-cache read does not hold the run',
            finished && elapsed < 15000,
            'finished=' + finished + ' in ' + elapsed + 'ms (before the fix every page waits on the open forever)');

        const captured = await page.evaluate(() => window.__capturedZip);
        check('the archive was produced', !!(captured && captured.b64), captured ? captured.name : 'no capture');
        const entries = captured && captured.b64 ? readStoreZip(Buffer.from(captured.b64, 'base64')) : [];
        check('every page is in the archive exactly once',
            entries.length === PAGES && new Set(entries.map(e => e.name)).size === PAGES,
            entries.length + '/' + PAGES + ' entries, ' + new Set(entries.map(e => e.name)).size + ' unique');
        check('every page was fetched despite the dead cache',
            hits.size === PAGES && [...hits.values()].every(n => n >= 1),
            hits.size + '/' + PAGES + ' pages requested');

        console.log('\n--- summary ---');
        console.log('run            : ' + elapsed + 'ms for ' + PAGES + ' pages with a dead page cache');
        console.log('pages fetched  : ' + hits.size);
    } finally {
        if (page) await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }

    const failed = results.filter(r => !r.pass);
    fs.writeFileSync(path.join(__dirname, 'cmoa_pagecache_stall_result.json'), JSON.stringify({ results }, null, 2));
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
