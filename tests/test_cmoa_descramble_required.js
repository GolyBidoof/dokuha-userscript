#!/usr/bin/env node
'use strict';
/*
 * CMOA "you cannot descramble this" test.
 *
 * The report this pins down: a series run produced whole volumes
 * that were not descrambled at all. The cause was a silent fallback - when a
 * page could not be descrambled the pipeline handed the CDN's own bytes to the
 * archiver, and the CDN's bytes are the scrambled tiles. Readiness did not ask
 * for the reader either (only cid, contents server and a page list), so a viewer
 * that had a page list but no getImageDescrambleCoords() counted as ready and
 * the run "succeeded" into an archive of unreadable images.
 *
 * Two runs of the same fake volume:
 *   - with the reader    -> a ZIP, as before;
 *   - without the reader -> no archive at all, and an error that names the
 *                           missing descramble reader and the page it was on.
 * The second run must not even fetch the images: refusing before the sweep is
 * the point, because fetching them can only end in writing scrambled bytes.
 */
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');

const CID = '0000249510_jp_0001';
const CDN = 'https://free-binb-cmoa.akamaized.net/sbc';
const TITLE = '\u30c6\u30b9\u30c8\u30de\u30f3\u30ac 1\u5dfb';
const SIZE = 64;
const PAGES = 2;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function pageHtml(pageSrcs, withReader) {
    const pages = pageSrcs.map((src, i) =>
        `{ id: ${JSON.stringify('p' + (i + 1))}, image: { id: ${JSON.stringify('p' + (i + 1))}, src: ${JSON.stringify(src)}, orgwidth: ${SIZE}, orgheight: ${SIZE}, pagespread: 0 } }`
    ).join(',\n      ');
    // Without the reader the viewer still answers `content.page` and
    // `bibliography`, which is exactly the half-initialised shape that used to
    // pass readiness.
    const readerBody = withReader
        ? `{
    requestUrl: location.origin + '/bib/sws/bibGetCntntInfo.php?cid=' + encodeURIComponent(${JSON.stringify(CID)}) + '&dmytime=1&k=K&u0=1',
    getImageDescrambleCoords: function (image, w, h) {
      const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
      return { width: w, height: h, transfers: [{ index: 0, coords: [
        { xsrc: hw, ysrc: 0,  xdest: 0,  ydest: 0,  width: hw, height: hh },
        { xsrc: 0,  ysrc: 0,  xdest: hw, ydest: 0,  width: hw, height: hh },
        { xsrc: hw, ysrc: hh, xdest: 0,  ydest: hh, width: hw, height: hh },
        { xsrc: 0,  ysrc: hh, xdest: hw, ydest: hh, width: hw, height: hh }
      ] }] };
    }
  }`
        : `{ requestUrl: location.origin + '/bib/sws/bibGetCntntInfo.php?cid=' + encodeURIComponent(${JSON.stringify(CID)}) + '&dmytime=1&k=K&u0=1' }`;
    return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${TITLE}</title></head>
<body>
  <div data-ptbinb="/bib/sws/bibGetCntntInfo.php?u0=1" data-ptbinb-cid="${CID}"></div>
  <div id="content"></div>
  <script>
    window.__PAGES = [ ${pages} ];
    window.__fakeViewer = {
      content: { page: window.__PAGES, bibliography: { title: document.title, author: '', publisher: '', description: '' } },
      get reader() { return ${readerBody}; }
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
  </script>
</body></html>`;
}

async function runVolume(browser, withReader) {
    const pageSrcs = Array.from({ length: PAGES }, (_, i) => `pages/page${i + 1}.jpg`);
    const image = await sharp({
        create: { width: SIZE, height: SIZE, channels: 3, background: { r: 200, g: 60, b: 90 } },
    }).jpeg().toBuffer();

    const page = await browser.newPage();
    const notes = [];
    page.on('console', m => { const t = m.text(); if (/\[bwdd/.test(t)) notes.push(t); });
    await page.setRequestInterception(true);

    let cdnHits = 0;
    const html = pageHtml(pageSrcs, withReader);
    const contentInfo = JSON.stringify({
        result: 1,
        items: [{
            ContentID: '100002495100001', ContentsServer: CDN, Title: TITLE, SubTitle: TITLE,
            p: 'TOKEN-ONE', ViewMode: 2, ContentDate: '99991031163056', Authors: [{ Name: 'x' }],
        }],
    });
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
            cdnHits++;
            return req.respond({
                status: 200,
                headers: { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*' },
                body: image,
            });
        }
        if (/127\.0\.0\.1:62642|learnnatively|manga-kotoba/.test(url)) return req.abort();
        return req.continue();
    });

    await page.goto('https://www.cmoa.jp/bib/speedreader/?cid=' + CID + '&u0=1&bwddDebug=1', { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: fs.readFileSync(US, 'utf8') });
    await sleep(1200);

    const haveZip = await page.evaluate(() => !!document.querySelector('button.bwdd-btn.zip'));
    await page.click('button.bwdd-btn.zip');

    const outcome = await page.waitForFunction(() => {
        if (window.__capturedZip) return 'zip';
        const box = document.querySelector('.bwdd-hint-box');
        const text = box ? box.textContent : '';
        if (/run failed|not ready|descramble/i.test(text)) return text;
        return null;
    }, { timeout: 30000 }).then(h => h.jsonValue()).catch(() => null);

    const zip = await page.evaluate(() => window.__capturedZip);
    const hint = await page.evaluate(() => {
        const box = document.querySelector('.bwdd-hint-box');
        return box ? box.textContent.trim() : '';
    });
    await page.close();
    return { haveZip, outcome, zip, hint, cdnHits, notes };
}

(async () => {
    const results = [];
    const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  \u2014 ' + d); };

    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    try {
        const ok = await runVolume(browser, true);
        check('with a descramble reader the volume still downloads',
            ok.haveZip && !!(ok.zip && ok.zip.b64),
            'zip=' + !!(ok.zip && ok.zip.b64) + ' cdnHits=' + ok.cdnHits);

        const bad = await runVolume(browser, false);
        check('a viewer without the descramble reader produces no archive at all',
            !bad.zip,
            bad.zip ? 'a ZIP was produced anyway: ' + bad.zip.name : 'no archive written');
        check('the failure names the missing descramble reader',
            /descramble reader/i.test(bad.hint) || /descramble reader/i.test(String(bad.outcome)),
            JSON.stringify((bad.hint || String(bad.outcome || '')).slice(0, 200)));
        check('the failure names the page the worker was actually on',
            /speedreader/.test(bad.hint),
            JSON.stringify(bad.hint.slice(0, 160)));
        check('nothing is fetched when the volume cannot be descrambled',
            bad.cdnHits === 0,
            bad.cdnHits + ' CDN image request(s) before refusing');
        check('the refusal is visible without debug logging',
            bad.notes.some(l => /descramble|not ready|run failed/i.test(l)),
            bad.notes.length + ' [bwdd] line(s), e.g. ' + JSON.stringify(bad.notes.slice(0, 1)));

        console.log('\n--- summary ---');
        console.log('control  : zip=' + !!(ok.zip && ok.zip.b64) + ' cdnHits=' + ok.cdnHits);
        console.log('no reader: zip=' + !!bad.zip + ' cdnHits=' + bad.cdnHits);
        console.log('hint     : ' + bad.hint.slice(0, 200));
    } finally {
        await browser.close().catch(() => {});
    }

    const failed = results.filter(r => !r.pass);
    fs.writeFileSync(path.join(__dirname, 'cmoa_descramble_required_result.json'), JSON.stringify({ results }, null, 2));
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
