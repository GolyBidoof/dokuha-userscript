// test_kindle_adapter.js — the Kindle protocol adapter, offline.
//
// The suite must never touch Amazon, so this stands up a synthetic
// read.amazon.co.jp/manga/<ASIN> page and a synthetic render service, then
// drives the adapter's real window walk, page ordering and page cipher against
// them:
//
//   * /renderer/render answers with a genuine ustar built here, in the same
//     member shape the viewer's own service uses (pax headers included);
//   * the CDN serves one page as raw JPEG bytes, one as base64 that the
//     manifest does NOT flag, and two as AES-GCM payloads framed exactly like
//     Amazon's — encrypted here with the same token-derived key.
//
// So this proves the adapter IMPLEMENTS the framing, the key offset, the
// additionalData, the reading order and the end-of-book rule. That those are
// the real parameters is a separate claim, and it is
// kindle-free-manga/verify_kindle_protocol.mjs that settles it: that script
// brute-forces all 60 key offsets against a real captured payload and finds
// exactly one that authenticates Amazon's own GCM tag. Neither test is
// sufficient alone; together they pin the protocol down at both ends.
//
// Two scenarios run, because the live service has two behaviours:
//
//   A  a service that accepts any window and answers short  -> the walk learns
//      the real window size from the short answer;
//   B  a service that answers 400 to a window it dislikes   -> the walk halves
//      its window until one is accepted, then continues. This is the behaviour
//      measured live: numPage=24 is refused on a real volume while the viewer's
//      own numPage=2 succeeds.
'use strict';
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const { webcrypto } = require('crypto');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
// This test is about the Kindle module, so it defaults to the Kindle-only
// artifact rather than the combined one: a store module that another editor is
// mid-change on cannot then fail the Kindle suite. The combined artifact's
// dispatch is what test_site_dispatch.js and test_split_builds.js cover.
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'kindle-only.user.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ASIN = 'B0TESTKNDL';
const REVISION = 'aaaa1111';
const PLAIN_HOST = 'https://d1wni8hbjtvcd0.cloudfront.net';
const CIPHER_HOST = 'https://d2qpunf64f4a6d.cloudfront.net';
const CIPHER_HOST_HOST = CIPHER_HOST.replace(/^https?:\/\//, '');
const PLAIN_HOST_HOST = PLAIN_HOST.replace(/^https?:\/\//, '');

// The key is token.substring(expiresAt % 60, +40), and the additionalData is
// its first 9 characters. 1234 % 60 === 34, so an implementation that took the
// first 40 characters of the token instead would derive a different key and
// fail the GCM tag — the offset is genuinely exercised, not accidentally 0.
const EXPIRES_AT = 1234;
const KEY_OFFSET = EXPIRES_AT % 60;
const TOKEN = Array.from({ length: 260 },
    (_, i) => String.fromCharCode(33 + ((i * 7 + Math.floor(i / 3)) % 90))).join('');
const KEY = TOKEN.substring(KEY_OFFSET, KEY_OFFSET + 40);

// One real 8x8 JPEG, base64. Each page gets a JPEG COM segment appended right
// after SOI carrying its own tag, so a decoded page can be traced back to the
// resource it came from while staying a valid JPEG.
const SEED = Buffer.from(
    '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQA' +
    'AAABAAAACKADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmA' +
    'CZjs+EJ+/8AAEQgACAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQE' +
    'AAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldY' +
    'WVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk' +
    '5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMR' +
    'BAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdo' +
    'aWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz' +
    '9PX29/j5+v/bAEMABAQEBAQEBgQEBgkGBgYJDAkJCQkMDwwMDAwMDxIPDw8PDw8SEhISEhISEhUVFRUVFRkZGRkZHBwcHBwcHBwc' +
    'HP/bAEMBBAUFBwcHDAcHDB0UEBQdHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHf/dAAQA' +
    'Af/aAAwDAQACEQMRAD8APgxplr4a0C58R30MkltpVpLeSrEAXZIEMjBAxUFiFOMkDPcV1X/DVPws/wCgPrn/AH4tv/kmqfg//kln' +
    'in/sB3//AKTSV8I0Af/Z', 'base64');

function u16(n) { return Buffer.from([(n >> 8) & 0xff, n & 0xff]); }
function jpegFor(tag) {
    const comment = Buffer.from(tag, 'latin1');
    const seg = Buffer.concat([Buffer.from([0xFF, 0xFE]), u16(comment.length + 2), comment]);
    return Buffer.concat([SEED.subarray(0, 2), seg, SEED.subarray(2)]);
}
function b64(buf) { return Buffer.from(buf).toString('base64'); }

// The three page payload shapes the service really produces.
const PLAIN = jpegFor('PAGE0');                       // raw JPEG bytes
const B64_ONLY = Buffer.from(b64(jpegFor('PAGE1')));  // base64, manifest says plain
const CIPHER_SRC = { P2: jpegFor('PAGE2'), P3: jpegFor('PAGE3') };

async function encryptFramed(jpeg, keyMaterial) {
    const subtle = webcrypto.subtle;
    const enc = new TextEncoder();
    const salt = webcrypto.getRandomValues(new Uint8Array(16));
    const iv = webcrypto.getRandomValues(new Uint8Array(16));
    const base = await subtle.importKey('raw', enc.encode(keyMaterial), { name: 'PBKDF2' }, false,
        ['deriveBits', 'deriveKey']);
    const key = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-256' },
        base, { name: 'AES-GCM', length: 128 }, false, ['encrypt']);
    const ct = await subtle.encrypt({
        name: 'AES-GCM', iv, additionalData: enc.encode(keyMaterial.slice(0, 9)), tagLength: 128,
    }, key, jpeg);
    // The wire form: three base64 pieces concatenated, so the two 16-byte
    // headers each carry their own "==" padding at offsets 22 and 46.
    return Buffer.from(b64(salt) + b64(iv) + b64(new Uint8Array(ct)), 'latin1');
}

function tarEntry(name, body, type) {
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.write('        ', 148, 'ascii');
    header[156] = type.charCodeAt(0);
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    const pad = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
    return Buffer.concat([header, body, pad]);
}
function tar(members) {
    const parts = members.map(m => tarEntry(m.name, Buffer.isBuffer(m.body) ? m.body : Buffer.from(m.body, 'utf8'), m.type || '0'));
    parts.push(Buffer.alloc(1024, 0));
    return Buffer.concat(parts);
}

// The synthetic book: four page images over four views, two windows.
//
//   window 0 (skip=0)  views 0,1 -> rsrcTEST0, rsrcTEST1   cdn.isEncrypted=false
//   window 1 (skip=2)  views 2,3 -> rsrcTEST2, rsrcTEST3   cdn.isEncrypted=true
//
// metadata.lastPositionId is 22, so view 3 (endPositionId 28) is the last page
// the reader would draw. The walk must stop after window 1 and never ask for
// window 2 — that is the rule this fixture exists to pin.
const LOCATIONS = { locations: [0, 0, 3, 6, 10] };           // -> 4 page images
const METADATA = {
    bookTitle: 'テスト漫画 3巻 (デジタル版テストコミックス)', lang: 'ja', authors: ['テスト作者'],
    firstPositionId: 0, lastPositionId: 22, coverPosistion: 0,
    writingMode: 'horizontal_tb', direction: 'rtl', progressionDirection: 'rtl',
};
const TOC = [{ label: '表紙', tocPositionId: 1 }, { label: '１話', tocPositionId: 5 }];

function page(sectionId, endPositionId, ref) {
    return {
        type: 'page', pageIndex: sectionId - 826, sectionId, width: 1333, height: 1270,
        startPosition: '1007;0', endPosition: '1007;0',
        startPositionId: 1, endPositionId, wordsInPage: 0,
        fillColor: '#000000ff', inkColor: '#acacacff',
        children: [{
            type: 'image', transform: [0.661458, 0, 0, 0.661458, 220.015625, 0],
            elementId: 1007, rect: { top: 0, left: 0, bottom: 1920, right: 1350 },
            clipPath: { top: 0, left: 220.015625, bottom: 1270, right: 1112.984375 },
            imageReference: 'resource/' + ref, wrapperContainerId: 0,
        }],
    };
}
// Where the signature lives is a per-volume accident, and the two shapes are
// exact opposites:
//   'resource' — cdn.authParameter null, each cdnResources[].authParameter signed
//                (capture 1)
//   'cdn'      — cdn.authParameter carries one policy for the whole
//                ".../fullbook/*" prefix, and EVERY cdnResources[].authParameter
//                is the literal junk string below (capture 2, and the bug that
//                shipped: it produced "...?null&renderingOrigin=KRS" -> 403)
const SIGNED = 'Policy=dGVzdA__&Signature=test~sig&Key-Pair-Id=TESTKEY&renderingOrigin=KRS';
// Real policies from the captures. The prefix form authorizes the whole
// ".../fullbook/*" prefix and is the only form the encrypted host accepts the
// session token on; the exact form names ONE object and REJECTS the token (403),
// which is what every sample and plain-host URL uses.
function policyB64(resource) {
    return Buffer.from(JSON.stringify({
        Statement: [{ Resource: resource, Condition: { DateLessThan: { 'AWS:EpochTime': 9999999999 } } }],
    })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const PREFIX_AUTH = 'Policy=' + policyB64('https://' + CIPHER_HOST_HOST + '/FULLBOOKPATH/*') +
    '&Signature=test~sig&Key-Pair-Id=TESTKEY&renderingOrigin=KRS';
const EXACT_AUTH = 'Policy=' + policyB64('https://' + PLAIN_HOST_HOST + '/EXACTPATH/resource/rsrcTEST0') +
    '&Signature=test~sig&Key-Pair-Id=TESTKEY&renderingOrigin=KRS';
const JUNK_AUTH = 'null&renderingOrigin=KRS';
// Scenario switch read by manifestFor, so it lives at module scope.
let EXACT_POLICIES = false;
function manifestFor(host, isEncrypted, refs, authAtCdn) {
    return {
        cdn: {
            expirationDate: Date.now() + 60000, baseUrl: host + '/' + ASIN + '/' + REVISION + '/fullbook',
            authParameter: authAtCdn ? SIGNED : null, isEncrypted: isEncrypted,
        },
        cdnResources: refs.map(r => ({
            url: 'resource/' + r, size: 0, type: 'IMAGE_PNG',
            authParameter: authAtCdn ? JUNK_AUTH : (EXACT_POLICIES ? EXACT_AUTH : SIGNED),
        })),
        revision: REVISION, bookFormat: 'YJBINARY_HD_MONOLITHIC', bookType: 'FixedFormat',
        manifestComplete: true,
    };
}
function tarForSkip(skip, withPages, authAtCdn, lieAboutEncryption) {
    const common = [
        // A pax header member, exactly as the real bundles carry: the reader
        // must skip it rather than treat it as the page data.
        { name: 'PaxHeaders.0/page_data_0_1.json', body: '0 length=0\n', type: 'x' },
        { name: 'glyphs.json', body: '[]' },
        { name: 'layout.json', body: '[]' },
        { name: 'toc.json', body: JSON.stringify(TOC) },
        { name: 'metadata.json', body: JSON.stringify(METADATA) },
        { name: 'location_map.json', body: JSON.stringify(LOCATIONS) },
    ];
    if (withPages === false) {
        // What the service returns when it cannot place startingPosition: a
        // well-formed bundle with metadata but no pages. The bundle's own client
        // throws "No pages returned ... startingPosition: N" on this.
        return tar(common.concat([
            { name: 'manifest.json', body: JSON.stringify(manifestFor(PLAIN_HOST, false, [])) },
        ]));
    }
    if (skip === 0) {
        return tar(common.concat([
            { name: 'page_data_0_1.json', body: JSON.stringify([
                page(826, 7, 'rsrcTEST0'), page(827, 14, 'rsrcTEST1')]) },
            { name: 'manifest.json', body: JSON.stringify(manifestFor(PLAIN_HOST, false, ['rsrcTEST0', 'rsrcTEST1'], authAtCdn)) },
        ]));
    }
    if (skip === 2) {
        return tar(common.concat([
            { name: 'page_data_0_1.json', body: JSON.stringify([
                page(828, 21, 'rsrcTEST2'), page(829, 28, 'rsrcTEST3')]) },
            { name: 'manifest.json', body: JSON.stringify(manifestFor(CIPHER_HOST, !lieAboutEncryption, ['rsrcTEST2', 'rsrcTEST3'], authAtCdn)) },
        ]));
    }
    return null;   // end of book
}

(async () => {
    const src = loadUserscript({ file: US });
    const results = [];
    const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };

    const framed2 = await encryptFramed(CIPHER_SRC.P2, KEY);
    const framed3 = await encryptFramed(CIPHER_SRC.P3, KEY);

    // Every render call the adapter makes, so the walk can be checked rather
    // than just its output. Successful calls and refusals are kept apart: the
    // window ladder's whole job is to turn the second list into the first.
    const renderCalls = [];
    const renderRefusals = [];
    const resourceCalls = [];
    // Scenario switch: the largest numPage this service will accept. Infinity
    // is the permissive service, 2 is the one measured live.
    let NUM_PAGE_LIMIT = Infinity;
    // Scenario switch: whether this volume can place startingPosition=1. When
    // false the service answers with a page-less bundle, which is its real
    // failure mode for an anchor it cannot map.
    let START_ANCHOR_WORKS = true;
    let AUTH_AT_CDN = false;
    let LIE_ABOUT_ENCRYPTION = false;
    // Scenario switch: per-resource (exact) policies, which must NOT be sent the
    // reading-session token. Every sample URL and plain-host URL is this shape.
    let BOOK_IS_SAMPLE = false;
    let TOKEN_REQUIRES = null;
    let REQUIRE_SESSION_TOKEN = false;
    const resourceRefusals = [];

    function bookInfoFor(isSample) {
        return {
            asin: ASIN, contentGuid: REVISION, title: METADATA.bookTitle,
            seriesAsin: 'B0TESTSERIES', bookContentType: 'managedManga', isSample: isSample,
            isVerticalScroll: false,
            bookAccessMethod: isSample ? 'SAMPLE' : 'PURCHASE',
            isASR: false, isAdult: false,
            karamelToken: { token: TOKEN, expiresAt: EXPIRES_AT },
            cdnPrefetchInfo: JSON.stringify({
                cdn: manifestFor(PLAIN_HOST, false, []).cdn, resources: [],
            }),
        };
    }
    function pageHtmlFor(isSample) {
        return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>${METADATA.bookTitle}</title></head><body>
<div id="reader"></div>
<script type="application/json" id="bookInfo">${JSON.stringify(bookInfoFor(isSample))}</script>
</body></html>`;
    }

    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true,
        args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    try {
        async function openKindlePage() {
            const PAGE_HTML = pageHtmlFor(BOOK_IS_SAMPLE);
            const page = await browser.newPage();
            page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
            await page.setRequestInterception(true);
            page.on('request', req => {
                const u = req.url();
                const cors = {
                    'access-control-allow-origin': 'https://read.amazon.co.jp',
                    'access-control-expose-headers': 'x-krs-image-version',
                };
                if (req.resourceType() === 'document' || req.isNavigationRequest()) {
                    return req.respond({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: PAGE_HTML });
                }
                if (u.includes('/renderer/render')) {
                    const params = new URL(u).searchParams;
                    const skip = Number(params.get('skipPageCount'));
                    const numPage = Number(params.get('numPage'));
                    const start = params.get('startingPosition');
                    const contentType = params.get('contentType');
                    if (TOKEN_REQUIRES && contentType !== TOKEN_REQUIRES) {
                        // The real refusal, verbatim: the rendering token is
                        // minted for one content type and every other parameter
                        // is irrelevant to it.
                        renderRefusals.push({ skip, numPage, start, contentType, status: 400 });
                        return req.respond({
                            status: 400, headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ message: 'Rendering token is not matching the request.' }),
                        });
                    }
                    if (numPage > NUM_PAGE_LIMIT) {
                        renderRefusals.push({ skip, numPage, start, contentType, status: 400 });
                        return req.respond({ status: 400, headers: { 'Content-Type': 'text/html' }, body: 'Bad Request' });
                    }
                    renderCalls.push({ skip, numPage, start, contentType });
                    const anchored = start !== null && !START_ANCHOR_WORKS;
                    const body = anchored ? tarForSkip(skip, false, AUTH_AT_CDN, LIE_ABOUT_ENCRYPTION)
                        : tarForSkip(skip, true, AUTH_AT_CDN, LIE_ABOUT_ENCRYPTION);
                    if (!body) return req.respond({ status: 200, headers: { 'Content-Type': 'application/x-tar' }, body: '' });
                    return req.respond({ status: 200, headers: { 'Content-Type': 'application/x-tar' }, body });
                }
                const m = u.match(/\/resource\/(rsrcTEST\d)/);
                if (m) {
                    // The real CDN only serves a resource whose query carries a
                    // signature. Anything else is a 403 — which is exactly how
                    // the "?null&renderingOrigin=KRS" bug surfaced.
                    if (!/[?&]Signature=/.test(u)) {
                        resourceRefusals.push({ ref: m[1], url: u });
                        return req.respond({ status: 403, headers: { 'Content-Type': 'text/html' }, body: 'Forbidden' });
                    }
                    // The encrypted distribution demands the reading-session
                    // token as well, and answers 502 (NOT 403) when a valid
                    // signature arrives without it. Reproduced faithfully here,
                    // because 502 sends you looking for a CDN throttle.
                    // An exact-resource policy rejects the session token outright:
                    // 403 on a perfectly valid signature, which is what made all
                    // 109 sample fetches fail while the viewer's token-less ones
                    // succeeded.
                    if (EXACT_POLICIES && /[?&]token=/.test(u)) {
                        resourceRefusals.push({ ref: m[1], url: u, status: 403 });
                        return req.respond({ status: 403, headers: { 'Content-Type': 'text/html' }, body: 'Forbidden' });
                    }
                    if (REQUIRE_SESSION_TOKEN && !/[?&]token=/.test(u)) {
                        resourceRefusals.push({ ref: m[1], url: u, status: 502 });
                        return req.respond({ status: 502, headers: { 'Content-Type': 'text/html' }, body: 'Bad Gateway' });
                    }
                    resourceCalls.push(m[1]);
                    if (m[1] === 'rsrcTEST0') {
                        return req.respond({ status: 200, headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, cors), body: PLAIN });
                    }
                    if (m[1] === 'rsrcTEST1') {
                        return req.respond({ status: 200, headers: Object.assign({ 'Content-Type': 'text/plain' }, cors), body: B64_ONLY });
                    }
                    const framed = m[1] === 'rsrcTEST2' ? framed2 : framed3;
                    return req.respond({ status: 200, headers: Object.assign({ 'Content-Type': 'text/plain', 'x-krs-image-version': '1.0' }, cors), body: framed });
                }
                if (/127\.0\.0\.1:62642|learnnatively|manga-kotoba|amazon-adsystem|fls-fe/.test(u)) return req.abort();
                return req.continue();
            });

            await page.goto('https://read.amazon.co.jp/manga/' + ASIN + '?bwddDebug=1', { waitUntil: 'domcontentloaded' });
            await page.addScriptTag({ content: src });
            await sleep(900);
            return page;
        }

        const page = await openKindlePage();

        const boot = await page.evaluate(() => {
            const site = window.__bwddSite || {};
            const b = window.__bwdd || {};
            return {
                id: site.id, label: site.label, title: site.panelTitle,
                cid: site.getCid(),
                book: site.getBook(),
                hasTar: typeof b.kindleReadTar === 'function',
                hasState: !!b.kindleState,
            };
        });
        check('the Kindle adapter owns the page', boot.id === 'kindle', 'id=' + boot.id);
        check('the panel is branded for Kindle', boot.title === 'Kindle Native Downloader', boot.title);
        check('the page cache id is the ASIN', boot.cid === ASIN, 'cid=' + boot.cid);
        check('the debug surface exposes the Kindle internals', boot.hasTar && boot.hasState,
            'readTar=' + boot.hasTar + ' state=' + boot.hasState);
        // splitSeriesVolume() is core's, shared with the other three stores; the
        // doubled space is its existing splice of "…漫画 3巻 (…)". Pinned here
        // so a change to the shared splitter shows up as a Kindle test failure
        // rather than as a silently renamed archive.
        check('the series and volume are split out of the embedded title',
            boot.book && boot.book.series === 'テスト漫画  (デジタル版テストコミックス)' && boot.book.volNum === 3,
            JSON.stringify(boot.book));

        const walked = await page.evaluate(async () => {
            const b = window.__bwdd;
            await b.kindleEnsureProbe(false);
            await b.kindleWalkWindows();
            const s = b.kindleState;
            return {
                pageWindowCount: s.pages.size,
                resourceCount: s.resources.size,
                expectedPages: s.expectedPages,
                lastPositionId: s.lastPositionId,
                resolution: s.imageResolution,
                atEnd: b.kindleAtEnd(),
                walkDone: s.walkDone,
                nextSkip: s.nextSkip,
                windowBatch: s.windowBatch,
                preview: window.__bwddSite.getPreview(),
                refs: b.kindleBuildPageList().map(d => d.ref),
            };
        });
        check('every render window is folded into the page map',
            walked.pageWindowCount === 4, 'windows=' + walked.pageWindowCount);
        check('the manifest resources are collected across windows',
            walked.resourceCount === 4, 'resources=' + walked.resourceCount);
        check('the page count comes from location_map.locations.length - 1',
            walked.expectedPages === 4, 'expectedPages=' + walked.expectedPages);
        check('the native page size is read off the page rect, not guessed',
            walked.resolution === '1350 × 1920', 'resolution=' + walked.resolution);
        check('the walk stops on metadata.lastPositionId, as the viewer does',
            walked.walkDone === true && walked.atEnd === true && walked.nextSkip === 4,
            'done=' + walked.walkDone + ' atEnd=' + walked.atEnd + ' nextSkip=' + walked.nextSkip);
        check('page order follows page_data children, not the rsrc name',
            walked.refs.join(',') === 'resource/rsrcTEST0,resource/rsrcTEST1,resource/rsrcTEST2,resource/rsrcTEST3',
            walked.refs.join(','));
        check('the panel preview reports the page count', !!walked.preview && walked.preview.pages === 4,
            JSON.stringify(walked.preview));

        check('the render walk stops at the last page (no window past the end)',
            renderCalls.length === 2 && renderCalls[0].skip === 0 && renderCalls[1].skip === 2,
            JSON.stringify(renderCalls));
        check('a short window teaches the adapter the service window ceiling',
            renderCalls[0].numPage > 2 && renderCalls[1].numPage === 2 && walked.windowBatch === 2,
            'numPage=' + renderCalls.map(c => c.numPage).join(',') + ' windowBatch=' + walked.windowBatch);

        const fetched = await page.evaluate(async () => {
            const b = window.__bwdd;
            const decodeTag = bytes => {
                for (let i = 0; i + 3 < bytes.length; i++) {
                    if (bytes[i] === 0xFF && bytes[i + 1] === 0xFE) {
                        const len = (bytes[i + 2] << 8) | bytes[i + 3];
                        let s = '';
                        for (let j = i + 4; j < i + 2 + len; j++) s += String.fromCharCode(bytes[j]);
                        return s;
                    }
                }
                return '';
            };
            const out = [];
            const list = b.kindleBuildPageList();
            for (const d of list) {
                const blob = await b.kindleFetchPage(d);
                const bytes = new Uint8Array(await blob.arrayBuffer());
                out.push({
                    index: d.index, ref: d.ref, type: blob.type, size: bytes.length,
                    isJpeg: bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF,
                    tag: decodeTag(bytes),
                    encrypted: d.resource.isEncrypted,
                });
            }
            return out;
        });
        check('every page decodes to a JPEG blob',
            fetched.length === 4 && fetched.every(p => p.isJpeg && p.type === 'image/jpeg'),
            fetched.map(p => p.ref + ':' + p.isJpeg).join(' '));
        check('a raw byte-served page is passed through unchanged',
            fetched[0].tag === 'PAGE0' && fetched[0].encrypted === false,
            fetched[0].ref + ' tag=' + fetched[0].tag);
        check('a base64 body the manifest did not flag is still decoded',
            fetched[1].tag === 'PAGE1' && fetched[1].encrypted === false,
            fetched[1].ref + ' tag=' + fetched[1].tag);
        check('an AES-GCM page is decrypted with the token-derived key',
            fetched[2].tag === 'PAGE2' && fetched[2].encrypted === true,
            fetched[2].ref + ' tag=' + fetched[2].tag);
        check('the second encrypted page decrypts too (framing is not positional)',
            fetched[3].tag === 'PAGE3' && fetched[3].encrypted === true,
            fetched[3].ref + ' tag=' + fetched[3].tag);
        check('the decrypted pages are the size of the original JPEG',
            fetched[2].size === CIPHER_SRC.P2.length && fetched[3].size === CIPHER_SRC.P3.length,
            fetched[2].size + '/' + fetched[3].size + ' expected ' + CIPHER_SRC.P2.length + '/' + CIPHER_SRC.P3.length);

        const keyCheck = await page.evaluate(() => {
            const b = window.__bwdd;
            return { good: b.kindleKeyMaterial(), wrong: b.kindleState.token.substring(0, 40) };
        });
        check('the cipher key is cut at expiresAt % 60, not from the token head',
            keyCheck.good === KEY && keyCheck.wrong !== KEY,
            'offset=' + KEY_OFFSET + ' key=' + JSON.stringify(keyCheck.good.slice(0, 8) + '…'));

        // A payload encrypted under a different key must be refused, not
        // silently turned into garbage: that is what the GCM tag buys, and it is
        // why a wrong key offset cannot quietly produce a corrupt archive.
        const wrongKeyFramed = await encryptFramed(CIPHER_SRC.P2, TOKEN.substring(0, 40));
        const refused = await page.evaluate(async body => {
            const b = window.__bwdd;
            try {
                await b.kindleDecryptImage(body, b.kindleKeyMaterial());
                return 'accepted';
            } catch (e) { return 'refused'; }
        }, wrongKeyFramed.toString('latin1'));
        check('a payload encrypted under the wrong key is refused by the GCM tag',
            refused === 'refused' && TOKEN.substring(0, 40) !== KEY, 'result=' + refused);

        await page.close();

        //
        // This is the behaviour measured live, and the one that made the first
        // shipped probe fail with nothing but "HTTP 400" on the panel.
        renderCalls.length = 0;
        renderRefusals.length = 0;
        resourceCalls.length = 0;
        NUM_PAGE_LIMIT = 2;

        const pageB = await openKindlePage();
        const bWalk = await pageB.evaluate(async () => {
            const b = window.__bwdd;
            await b.kindleEnsureProbe(false);
            await b.kindleWalkWindows();
            const s = b.kindleState;
            const list = b.kindleBuildPageList();
            const pages = [];
            for (const d of list) {
                const blob = await b.kindleFetchPage(d);
                const bytes = new Uint8Array(await blob.arrayBuffer());
                pages.push(bytes[0] === 0xFF && bytes[1] === 0xD8);
            }
            return {
                pageWindowCount: s.pages.size, walkDone: s.walkDone, atEnd: b.kindleAtEnd(),
                windowBatch: s.windowBatch, positions: list.length,
                allJpeg: pages.length > 0 && pages.every(Boolean),
            };
        });
        check('a 400 window is retried smaller instead of failing the run',
            renderRefusals.length > 0 && bWalk.walkDone === true,
            'refused=' + renderRefusals.map(r => r.numPage).join(',') + ' done=' + bWalk.walkDone);
        check('the shrink ladder walks down to the window size the viewer itself uses',
            Math.min.apply(null, renderRefusals.map(r => r.numPage).concat([99])) > 2 &&
            bWalk.windowBatch === 2 && renderCalls.some(c => c.numPage === 2),
            'refused=' + renderRefusals.map(r => r.numPage).join(',') + ' accepted=' +
            renderCalls.map(c => c.numPage).join(',') + ' windowBatch=' + bWalk.windowBatch);
        check('the whole book still arrives after the ladder settles',
            bWalk.pageWindowCount === 4 && bWalk.positions === 4 && bWalk.allJpeg === true && bWalk.atEnd === true,
            'windows=' + bWalk.pageWindowCount + ' pages=' + bWalk.positions + ' jpeg=' + bWalk.allJpeg);
        check('every render request after the ladder uses the accepted size',
            renderCalls.every(c => c.numPage <= 2),
            'accepted=' + renderCalls.map(c => c.numPage).join(','));
        await pageB.close();

        //
        // startingPosition is the reader's own startReadingPosition, which is
        // per volume and not readable from the served page (the two captures
        // used 1 and 18). Its failure mode is not a 400: it is a 200 carrying
        // metadata and no pages. An empty window must therefore be treated as a
        // bad anchor and retried, not as "this book has no pages".
        renderCalls.length = 0;
        renderRefusals.length = 0;
        resourceCalls.length = 0;
        NUM_PAGE_LIMIT = Infinity;
        START_ANCHOR_WORKS = false;

        const pageC = await openKindlePage();
        const cWalk = await pageC.evaluate(async () => {
            const b = window.__bwdd;
            await b.kindleEnsureProbe(false);
            await b.kindleWalkWindows();
            const s = b.kindleState;
            const list = b.kindleBuildPageList();
            return {
                startMode: s.startMode, expectedPages: s.expectedPages,
                pageWindowCount: s.pages.size, positions: list.length,
                walkDone: s.walkDone, atEnd: b.kindleAtEnd(),
            };
        });
        const anchoredCalls = renderCalls.filter(c => c.start !== null).length;
        const unanchoredCalls = renderCalls.filter(c => c.start === null).length;
        check('an anchor the service cannot place is retried, not reported as an empty book',
            cWalk.startMode === 'default' && anchoredCalls >= 1 && unanchoredCalls >= 1,
            'startMode=' + cWalk.startMode + ' anchored=' + anchoredCalls + ' unanchored=' + unanchoredCalls);
        check('the retry recovers the whole book',
            cWalk.pageWindowCount === 4 && cWalk.positions === 4 && cWalk.walkDone === true && cWalk.atEnd === true,
            'windows=' + cWalk.pageWindowCount + ' pages=' + cWalk.positions + ' done=' + cWalk.walkDone);
        check('the adopted anchor is used for the rest of the walk',
            renderCalls.slice(1).every(c => c.start === null),
            'starts=' + renderCalls.map(c => c.start === null ? 'none' : c.start).join(','));
        await pageC.close();

        //
        // Capture 2's shape: manifest.cdn.authParameter carries one policy for
        // the whole ".../fullbook/*" prefix, and every cdnResources[].authParameter
        // is the literal junk string "null&renderingOrigin=KRS". Reading the junk
        // field on faith produced "...?null&renderingOrigin=KRS" and a 403 on
        // every page but the handful already cached — the shipped bug.
        renderCalls.length = 0;
        renderRefusals.length = 0;
        resourceCalls.length = 0;
        resourceRefusals.length = 0;
        NUM_PAGE_LIMIT = Infinity;
        START_ANCHOR_WORKS = true;
        AUTH_AT_CDN = true;

        const pageD = await openKindlePage();
        const dWalk = await pageD.evaluate(async () => {
            const b = window.__bwdd;
            await b.kindleEnsureProbe(false);
            await b.kindleWalkWindows();
            const list = b.kindleBuildPageList();
            const tags = [];
            for (const d of list) {
                const blob = await b.kindleFetchPage(d);
                const bytes = new Uint8Array(await blob.arrayBuffer());
                tags.push(bytes[0] === 0xFF && bytes[1] === 0xD8);
            }
            const sources = {};
            for (const r of b.kindleState.resources.values()) {
                sources[r.authSource] = (sources[r.authSource] || 0) + 1;
            }
            return {
                positions: list.length, allJpeg: tags.length > 0 && tags.every(Boolean),
                sources: sources,
                authPickRejectsJunk: b.kindlePickAuth('null&renderingOrigin=KRS', null) === null,
                authPickTakesCdn: b.kindlePickAuth('null&renderingOrigin=KRS',
                    'Policy=x&Signature=y&Key-Pair-Id=z&renderingOrigin=KRS') !== null,
            };
        });
        check('a junk per-resource auth parameter is not mistaken for a signature',
            dWalk.authPickRejectsJunk === true, 'kindlePickAuth(junk, null) must be null');
        check('the CDN-level signature is used when the resource field is junk',
            dWalk.authPickTakesCdn === true && dWalk.sources.cdn === 4,
            'auth sources: ' + JSON.stringify(dWalk.sources));
        check('every page fetches with the prefix-wide signature (no 403)',
            resourceRefusals.length === 0 && dWalk.positions === 4 && dWalk.allJpeg === true,
            'refused=' + resourceRefusals.length + ' pages=' + dWalk.positions +
            (resourceRefusals.length ? ' e.g. ' + resourceRefusals[0].url.slice(-60) : ''));
        await pageD.close();

        //
        // The flag describes the manifest's host, so it can be wrong about a body
        // that arrived anyway. Trusting it was the second half of the same
        // failure: in the third capture 210 pages fetched and only 10 were saved,
        // because pages whose bytes did not match the flag threw instead of being
        // decoded. The decoder must sniff.
        renderCalls.length = 0;
        renderRefusals.length = 0;
        resourceCalls.length = 0;
        resourceRefusals.length = 0;
        AUTH_AT_CDN = false;
        LIE_ABOUT_ENCRYPTION = true;

        const pageE = await openKindlePage();
        const eWalk = await pageE.evaluate(async () => {
            const b = window.__bwdd;
            await b.kindleEnsureProbe(false);
            await b.kindleWalkWindows();
            const list = b.kindleBuildPageList();
            const tags = [];
            for (const d of list) {
                const blob = await b.kindleFetchPage(d);
                const bytes = new Uint8Array(await blob.arrayBuffer());
                tags.push(bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF);
            }
            return { positions: list.length, jpeg: tags.filter(Boolean).length };
        });
        check('a body that contradicts isEncrypted is still decoded, not dropped',
            eWalk.positions === 4 && eWalk.jpeg === 4,
            'pages=' + eWalk.positions + ' decoded=' + eWalk.jpeg + ' (manifest claimed plain, bytes were AES-GCM)');
        await pageE.close();

        //
        // The rendering token is minted for ONE content type: the reader bundle
        // computes `isSample ? "Sample" : "FullBook"`. Sending FullBook for a
        // sample volume earns
        // 400 {"message":"Rendering token is not matching the request."} on every
        // request — a different failure entirely from the page-count refusal, and
        // the one that made a sample volume undownloadable.
        renderCalls.length = 0;
        renderRefusals.length = 0;
        resourceCalls.length = 0;
        resourceRefusals.length = 0;
        AUTH_AT_CDN = false;
        LIE_ABOUT_ENCRYPTION = false;
        BOOK_IS_SAMPLE = true;
        TOKEN_REQUIRES = 'Sample';

        const pageF = await openKindlePage();
        const fWalk = await pageF.evaluate(async () => {
            const b = window.__bwdd;
            await b.kindleEnsureProbe(false);
            await b.kindleWalkWindows();
            return { positions: b.kindleBuildPageList().length, contentType: b.kindleState.contentType };
        });
        check('a sample volume sends contentType=Sample',
            fWalk.contentType === 'Sample' &&
            renderCalls.length > 0 && renderCalls.every(c => c.contentType === 'Sample'),
            'state=' + fWalk.contentType + ' sent=' +
            JSON.stringify([...new Set(renderCalls.map(c => c.contentType))]));
        check('a sample volume downloads without a token refusal',
            renderRefusals.length === 0 && fWalk.positions === 4,
            'refused=' + renderRefusals.length + ' pages=' + fWalk.positions);
        await pageF.close();

        //
        // Deriving the content type from bookInfo is right for every capture, but
        // it must not be a dead end: the service names the mismatch explicitly, so
        // it is worth exactly one correction.
        renderCalls.length = 0;
        renderRefusals.length = 0;
        resourceCalls.length = 0;
        resourceRefusals.length = 0;
        BOOK_IS_SAMPLE = false;      // so the adapter starts on FullBook
        TOKEN_REQUIRES = 'Sample';   // and the service will only accept Sample

        const pageG = await openKindlePage();
        const gWalk = await pageG.evaluate(async () => {
            const b = window.__bwdd;
            await b.kindleEnsureProbe(false);
            await b.kindleWalkWindows();
            return {
                positions: b.kindleBuildPageList().length,
                contentType: b.kindleState.contentType,
                fixed: b.kindleState.contentTypeFixed,
            };
        });
        check('a rendering-token mismatch is corrected instead of failing the run',
            gWalk.fixed === true && gWalk.contentType === 'Sample' && gWalk.positions === 4,
            'contentType=' + gWalk.contentType + ' pages=' + gWalk.positions);
        check('and the correction is what the service then accepts',
            renderRefusals.length >= 1 &&
            renderRefusals.every(r => r.contentType === 'FullBook') &&
            renderCalls.length > 0 && renderCalls.every(c => c.contentType === 'Sample'),
            'refused as ' + JSON.stringify([...new Set(renderRefusals.map(r => r.contentType))]) +
            ', accepted as ' + JSON.stringify([...new Set(renderCalls.map(c => c.contentType))]));
        await pageG.close();

        //
        // The two distributions want opposite requests, and getting it backwards
        // in either direction costs every page: a prefix policy 502s without the
        // token, an exact-resource policy 403s with it. Every sample URL and every
        // plain-host URL is the exact form, so this is what made a whole sample
        // fail while the viewer's own token-less requests succeeded.
        const policyPage = await openKindlePage();
        const policyProbe = await policyPage.evaluate((prefixAuth, exactAuth) => {
            const b = window.__bwdd;
            const mk = (auth, url) => b.kindleResourceUrl({
                url: url, authParameter: auth, baseUrl: 'https://host.test',
            });
            const unreadableAuth = 'Policy=dGVzdA__&Signature=x&Key-Pair-Id=y';
            return {
                prefixIsPrefix: b.kindleAuthPolicyIsPrefix(prefixAuth),
                exactIsPrefix: b.kindleAuthPolicyIsPrefix(exactAuth),
                unreadable: b.kindleAuthPolicyIsPrefix(unreadableAuth),
                prefixUrl: mk(prefixAuth, 'resource/a'),
                exactUrl: mk(exactAuth, 'resource/a'),
                unreadableUrl: mk(unreadableAuth, 'resource/a'),
            };
        }, PREFIX_AUTH, EXACT_AUTH);
        check('a prefix policy is recognised from the policy itself',
            policyProbe.prefixIsPrefix === true && policyProbe.exactIsPrefix === false,
            'prefix=' + policyProbe.prefixIsPrefix + ' exact=' + policyProbe.exactIsPrefix +
            ' unreadable=' + policyProbe.unreadable);
        check('a prefix policy carries the reading-session token',
            /[?&]token=/.test(policyProbe.prefixUrl) && /[?&]expiration=/.test(policyProbe.prefixUrl),
            policyProbe.prefixUrl.slice(-70));
        check('an exact-resource policy carries NO session token',
            !/[?&]token=/.test(policyProbe.exactUrl) && !/[?&]expiration=/.test(policyProbe.exactUrl),
            policyProbe.exactUrl.slice(-70));
        check('an unreadable policy still gets the token (the full-book case)',
            policyProbe.unreadable === null && /[?&]token=/.test(policyProbe.unreadableUrl),
            'unreadable=' + policyProbe.unreadable);
        await policyPage.close();

        // A sample's `total` is the FULL book's page count while only the sample's
        // pages were walked, so the old `missing === total` test let an entirely
        // failed run report success. Nothing saved is the rule.
        const outcomeProbe = await openKindlePage();
        const outcomes = await outcomeProbe.evaluate(() => {
            const f = window.__bwdd.kindleRunOutcome;
            return {
                savedSome: f(3, 5),      // partial success is still a download
                allFailedSample: f(0, 5), // sample: 5 walked, 210 expected
                nothingWalked: f(0, 0),
            };
        });
        check('a run with no saved pages is never reported as a download',
            outcomes.savedSome === 'ok' && outcomes.allFailedSample === 'all-failed' &&
            outcomes.nothingWalked === 'nothing',
            JSON.stringify(outcomes));
        await outcomeProbe.close();

        renderCalls.length = 0;
        renderRefusals.length = 0;
        resourceCalls.length = 0;
        resourceRefusals.length = 0;
        BOOK_IS_SAMPLE = false;
        TOKEN_REQUIRES = null;
        REQUIRE_SESSION_TOKEN = false;
        EXACT_POLICIES = true;
        const pageI = await openKindlePage();
        const iWalk = await pageI.evaluate(async () => {
            const b = window.__bwdd;
            await b.kindleEnsureProbe(false);
            await b.kindleWalkWindows();
            let jpeg = 0;
            for (const d of b.kindleBuildPageList()) {
                const blob = await b.kindleFetchPage(d);
                const bytes = new Uint8Array(await blob.arrayBuffer());
                if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) jpeg++;
            }
            return { jpeg: jpeg, total: b.kindleBuildPageList().length };
        });
        check('an exact-policy volume downloads every page',
            iWalk.jpeg === 4 && iWalk.total === 4 && resourceRefusals.length === 0,
            'decoded=' + iWalk.jpeg + '/' + iWalk.total + ' refused=' + resourceRefusals.length);
        await pageI.close();
        EXACT_POLICIES = false;


        //
        // A valid signature is not enough there: without token/expiration it
        // answers 502 — which is what made 313 of 349 page fetches fail while
        // the viewer's own requests to the same host succeeded, and left only
        // the plain-host pages (10 of 174) in the archive.
        renderCalls.length = 0;
        renderRefusals.length = 0;
        resourceCalls.length = 0;
        resourceRefusals.length = 0;
        BOOK_IS_SAMPLE = false;
        TOKEN_REQUIRES = null;
        REQUIRE_SESSION_TOKEN = true;

        const pageH = await openKindlePage();
        const hWalk = await pageH.evaluate(async () => {
            const b = window.__bwdd;
            await b.kindleEnsureProbe(false);
            await b.kindleWalkWindows();
            const urls = b.kindleBuildPageList().map(d => d.url);
            let jpeg = 0;
            for (const d of b.kindleBuildPageList()) {
                const blob = await b.kindleFetchPage(d);
                const bytes = new Uint8Array(await blob.arrayBuffer());
                if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) jpeg++;
            }
            return { jpeg: jpeg, total: urls.length, urls: urls };
        });
        check('every CDN URL carries the reading-session token',
            hWalk.total > 0 && hWalk.urls.every(u => /[?&]token=/.test(u) && /[?&]expiration=/.test(u)),
            'pages=' + hWalk.total + ' without token=' +
            hWalk.urls.filter(u => !/[?&]token=/.test(u)).length);
        check('a host that refuses a token-less URL still yields every page',
            hWalk.jpeg === hWalk.total && hWalk.total === 4 && resourceRefusals.length === 0,
            'decoded=' + hWalk.jpeg + '/' + hWalk.total + ' refused=' + resourceRefusals.length);
        await pageH.close();
        REQUIRE_SESSION_TOKEN = false;

    } finally {
        await browser.close().catch(() => {});
    }

    const failed = results.filter(r => !r.pass);
    fs.writeFileSync(path.join(__dirname, 'kindle_adapter_result.json'),
        JSON.stringify({ results, renderCalls, renderRefusals, resourceRefusals, resourceCalls }, null, 2));
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
