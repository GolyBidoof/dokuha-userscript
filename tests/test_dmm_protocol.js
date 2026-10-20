#!/usr/bin/env node
'use strict';
/*
 * DMMブックス protocol checks that need no browser and no network.
 *
 * The important one is the CloudFront name translation. The auth response sets
 * cookies named `CloudFront-Policy`, `CloudFront-Signature` and
 * `CloudFront-Key-Pair-Id`, but a signed URL's query parameters are `Policy`,
 * `Signature` and `Key-Pair-Id`. Sending the cookie names as query parameters
 * is a 403 from CloudFront even though the values are valid; the second live
 * capture in bookwalker-drm/dmmmanga has exactly that failed request.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const check = (name, pass, detail) => {
    results.push({ name, pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
};
const equal = (name, got, want) => check(name,
    JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));

const code = fs.readFileSync(path.join(ROOT, 'src/sites/dmm/00-state.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(ROOT, 'src/sites/dmm/01-protocol.js'), 'utf8')
    + '\n;globalThis.__dmm = {'
    + 'parseViewerUrl: dmmParseViewerUrl,'
    + 'parseConfiguration: dmmParseConfiguration,'
    + 'pattern: dmmPattern,'
    + 'tileRects: dmmTileRects,'
    + 'cookieParams: dmmCookieParams,'
    + 'signedUrl: dmmSignedUrl,'
    + 'fanoutPlan: dmmFanoutPlan,'
    + 'workerJob: dmmWorkerJob,'
    + 'workerSource: dmmWorkerSource'
    + '};';

const sandbox = {
    console,
    URL,
    URLSearchParams,
    location: { hostname: 'book.dmm.com', href: 'https://book.dmm.com/' },
    document: { cookie: '' },
    IMAGE_CODEC: { type: 'image/jpeg', quality: 0.9 },
    BWDD_DEBUG: false,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const dmm = sandbox.__dmm;

// ---- URL forms -------------------------------------------------------------
{
    const free = dmm.parseViewerUrl('https://book.dmm.com/product/605237/b999asqex01885/free_streaming/?cid=OPAQUE&lin=0&sd=0');
    equal('a free viewer names its content', [free.seriesId, free.contentId, free.viewer],
        ['605237', 'b999asqex01885', 'free_streaming']);
    equal('a free viewer keeps cid and lin', [free.cid, free.lin], ['OPAQUE', '0']);
    const sample = dmm.parseViewerUrl('https://book.dmm.com/product/605237/b999asqex01886/tachiyomi/?cid=OPAQUE2&lin=1');
    equal('a tachiyomi viewer is a sample', sample.viewer, 'tachiyomi');
    equal('a product page is not a viewer',
        dmm.parseViewerUrl('https://book.dmm.com/product/605237/b999asqex01885/'), null);
}

// ---- cookie → signed-URL query names ---------------------------------------
{
    // The signature is percent-encoded in the cookie. A signed URL has to carry
    // the decoded `~`; a cookie header wants the `%7E` verbatim.
    sandbox.document.cookie = 'ckcy=1; CloudFront-Policy=POLICY; '
        + 'CloudFront-Signature=abc%7Edef; CloudFront-Key-Pair-Id=KEY';
    const cookies = dmm.cookieParams();
    equal('the three cookies become signed-URL query names', Object.keys(cookies).sort(),
        ['Key-Pair-Id', 'Policy', 'Signature']);
    equal('the signature is decoded for a URL', cookies.Signature, 'abc~def');
    const signed = new URL(dmm.signedUrl(
        'https://ebook04.dmm.com/bb/st_comic/b/b000/b000f/b000fhftx14982st/configuration_pack.json',
        { cookies },
    ));
    equal('the URL carries Policy, not CloudFront-Policy',
        [signed.searchParams.get('Policy'), signed.searchParams.get('CloudFront-Policy')],
        ['POLICY', null]);
    equal('the URL carries Signature and Key-Pair-Id',
        [signed.searchParams.get('Signature'), signed.searchParams.get('Key-Pair-Id')],
        ['abc~def', 'KEY']);
}

// ---- network/decode fan-out ------------------------------------------------
{
    // With no bridge the lane budget is 12 sockets, but DMM's CloudFront is
    // HTTP/2: multiplexed streams are not limited by the six-per-origin ceiling,
    // so the plan opens four streams per lane slot. The decoder stays small
    // because each slot holds a full 900×1280 canvas, and the buffer is
    // compressed bytes.
    equal('a no-bridge run widens to the h2 stream budget',
        dmm.fanoutPlan(249, 0, 12, 256, 6), { fetchWidth: 48, decodeWidth: 6 });
    equal('a 48-port bridge opens the whole socket budget',
        dmm.fanoutPlan(249, 0, 294, 256, 6), { fetchWidth: 249, decodeWidth: 6 });
    equal('the page count caps the fan-out',
        dmm.fanoutPlan(3, 0, 294, 256, 8), { fetchWidth: 3, decodeWidth: 3 });
    equal('an explicit automation cap still wins',
        dmm.fanoutPlan(249, 8, 294, 256, 6), { fetchWidth: 8, decodeWidth: 6 });
    equal('window.__bwddMaxInflight clamps the fetch side',
        dmm.fanoutPlan(249, 0, 294, 12, 6), { fetchWidth: 12, decodeWidth: 6 });
}

// ---- off-thread descramble job ---------------------------------------------
{
    const page = {
        file: 'item/xhtml/p-011.xhtml', no: 0, type: 'jpeg',
        width: 900, height: 1280, dummyWidth: 4, dummyHeight: 0,
        scrambled: true, pattern: 4,
    };
    const job = dmm.workerJob(7, new Uint8Array([1, 2, 3]), page);
    equal('a worker job carries the clean canvas size', [job.cleanWidth, job.cleanHeight], [900, 1280]);
    equal('a worker job carries the encoded JPEG size', [job.encodedWidth, job.encodedHeight], [904, 1280]);
    equal('a worker job carries every tile rectangle', job.rects.length, 300);
    equal('a worker job keeps the selected codec', [job.mime, job.quality], ['image/jpeg', 0.9]);
    equal('an already-whole page is left on the main thread',
        dmm.workerJob(8, new Uint8Array([1]), { scrambled: false, width: 900, height: 1280 }), null);
    const source = dmm.workerSource();
    check('the worker source uses OffscreenCanvas, drawImage and convertToBlob',
        /OffscreenCanvas/.test(source) && /drawImage/.test(source) && /convertToBlob/.test(source));
}

// ---- manifest shape and the 64×64 shuffle ----------------------------------
{
    const config = {
        configuration: {
            contents: [
                { file: 'item/xhtml/p-cover.xhtml', type: 'bmp' },
                { file: 'item/xhtml/p-001.xhtml', type: 'jpeg' },
                { file: 'item/xhtml/p-002.xhtml', type: 'jpeg' },
            ],
        },
        'item/xhtml/p-cover.xhtml': {
            Linear: 1,
            FileLinkInfo: { PageLinkInfoList: [{ Page: {
                No: 0, DummyWidth: 4, DummyHeight: 0, Size: { Width: 900, Height: 1280 },
            } }] },
        },
        'item/xhtml/p-001.xhtml': {
            Linear: 1,
            FileLinkInfo: { PageLinkInfoList: [{ Page: {
                No: 0, DummyWidth: 4, DummyHeight: 0, Size: { Width: 900, Height: 1280 },
            } }] },
        },
        'item/xhtml/p-002.xhtml': {
            Linear: 0,
            FileLinkInfo: { PageLinkInfoList: [{ Page: { No: 0 } }] },
        },
    };
    const pages = dmm.parseConfiguration(config);
    equal('a Linear=0 item is skipped', pages.length, 2);
    equal('a bmp item is fetched as jpeg', pages[0].type, 'jpeg');
    equal('the dummy fields mark the page shuffled', [pages[0].dummyWidth, pages[0].dummyHeight, pages[0].scrambled],
        [4, 0, true]);
    equal('the path-derived pattern is kept', pages[0].pattern, dmm.pattern('item/xhtml/p-cover.xhtml', 0));
}

{
    // The recorded 904×1280 page uses pattern 4. 14×20 full tiles plus the
    // 8×20 and 14×4 edge strips are 300 rectangles; the first three pin the
    // source/destination orientation against the browser port.
    equal('the captured page uses pattern 4', dmm.pattern('item/xhtml/p-011.xhtml', 0), 4);
    const rects = dmm.tileRects(904, 1280, 4);
    equal('the captured geometry has 300 tile rectangles', rects.length, 300);
    equal('the edge strip leads the list', rects.slice(0, 3), [
        { sx: 704, sy: 768, dx: 640, dy: 0, w: 8, h: 64 },
        { sx: 768, sy: 832, dx: 640, dy: 64, w: 8, h: 64 },
        { sx: 832, sy: 896, dx: 640, dy: 128, w: 8, h: 64 },
    ]);
}

const failed = results.filter((r) => !r.pass);
console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
process.exit(failed.length ? 1 : 0);
