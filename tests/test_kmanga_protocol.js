#!/usr/bin/env node
'use strict';
/*
 * k-manga BCP000 wire format — the recorded frames, decoded by the port.
 *
 * The fixtures are the two messages dokuha-cli kept out of a real HAR's
 * `_webSocketMessages` (volume 1 of a free-campaign title): the header reply
 * (176 pages) and one content reply (a scrambled page). They are bytes rather
 * than a rebuilt frame on purpose -- a synthetic frame would only prove this
 * decoder agrees with this encoder, and every mistake worth catching here
 * (field widths, the header reply having no chunk table, raw rather than base64
 * image bytes, the padded JPEG against the declared box) is exactly the kind a
 * round trip through our own code would hide.
 *
 * The JSONP body, the viewer URL and the scramble expectations are the literal
 * values from the CLI's own tests, so the two implementations are pinned to one
 * another rather than to a fresh guess.
 */
const fs = require('fs');
const path = require('path');
const { launch, reporter, bytesToBase64 } = require('./_kmanga');

const headerB64 = bytesToBase64(fs.readFileSync(path.join(__dirname, 'fixtures', 'kmanga-header.bcp')));
const pageB64 = bytesToBase64(fs.readFileSync(path.join(__dirname, 'fixtures', 'kmanga-page8.bcp')));

const VIEWER = 'https://comic.k-manga.jp/viewer/pc/viewer.html'
    + '?p0=BGTK_0000000000000000000000000000000_20260101000000&p1=0000000000000000000000000000001&p2=2&p3=100007'
    + '&p4=1&p8=sid0000000000000000000000&p10=2&p20=00000005-0000-4000-8000-000000000005&p21=0';

(async () => {
    const { check, finish } = reporter();
    const { browser, page, ready } = await launch();
    try {
        check('the k-manga adapter boots and publishes its protocol surface', ready, 'window.__bwddKmangaProtocol');

        const got = await page.evaluate((hb, pb, viewer) => {
            const P = window.__bwddKmangaProtocol;
            const bytes = (s) => {
                const bin = atob(s);
                const out = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
                return out;
            };
            const header = bytes(hb);
            const pageFrame = bytes(pb);
            const threw = (fn) => { try { fn(); return false; } catch (e) { return true; } };
            const out = {};

            // The greeting is the magic on its own. Reading it as "a frame with
            // no JSON" would leave the client waiting for a length field.
            out.greeting = P.parseFrame(new TextEncoder().encode('BCP000')).hello;

            const head = P.parseFrame(header);
            out.headerNotGreeting = head.hello === false;
            out.headerChunksNull = head.chunks === null;
            out.numOfScenes = head.body.numOfScenes;
            out.frame = [head.body.frameWidth, head.body.frameHeight];
            out.contentCount = head.body.contentInfos.length;
            out.first = head.body.contentInfos[0];
            out.dkLen = head.body.dk.length;
            out.dkHex = /^[0-9a-f]{96}$/.test(head.body.dk);

            const content = P.parseFrame(pageFrame);
            out.chunkCount = content.chunks.length;
            const image = content.body.scenes[0].images[0];
            out.sceneNo = content.body.scenes[0].sceneNo;
            out.scrambled = P.isScrambled(image);
            out.key = image.key;
            out.format = image.format;
            out.imageBox = [image.width, image.height];
            out.rawJpeg = content.chunks[0][0] === 0xFF && content.chunks[0][1] === 0xD8;
            const size = P.readJpegSize(content.chunks[0]);
            out.jpegSize = size ? [size.width, size.height] : null;
            out.chunkLen = content.chunks[0].length;

            // Truncation and trailing bytes must be refused rather than papered
            // over: both mean a page would be written half-formed.
            out.truncatedRefused = threw(() => P.parseFrame(header.slice(0, 4000)));
            const trailing = new Uint8Array(pageFrame.length + 1);
            trailing.set(pageFrame, 0);
            out.trailingRefused = threw(() => P.parseFrame(trailing));
            const badMagic = header.slice();
            badMagic[5] = 0x58;
            out.badMagicRefused = threw(() => P.parseFrame(badMagic));

            // The request strings are the contract with the server.
            out.reqHeader = P.buildHeaderRequest({ ticket: 'BGTK_abc_202609280600', obfuid: 'o1', profile: '64kb_QVGA_h' });
            out.reqData = P.buildDataRequest({ ticket: 'T', obfuid: 'O', name: '7', decryptKey: 'DK' });
            out.reqDataNoKey = P.buildDataRequest({ ticket: 'T', obfuid: 'O', name: '7' });

            // The table of contents: chapters carry a page, flag rows do not.
            const index = P.parseIndexJsonp('cb([["\u8a71\u540d","\u958b\u59cb\u30da\u30fc\u30b8\u6570"],["\u8868\u7d19","1"],["\u76ee\u6b21","7"],["\u5965\u4ed8","175"],["rtl",""],["sc",""],["mr",""],["ml",""],[null]]);');
            out.chapters = index.chapters;
            out.flags = index.flags;
            out.notJsonpRefused = threw(() => P.parseIndexJsonp('not a jsonp call'));

            const session = P.parseViewerUrl(viewer);
            out.ticket = session.ticket;
            out.obfuid = session.obfuid;
            out.bookId = session.bookId;
            out.sid = session.sid;
            out.accessUuid = session.accessUuid;

            // The grid: the cell constant comes from the declared size, the grid
            // from the JPEG, and each cell yields its inner cell-2 square.
            out.geometry = P.scrambleGeometry({ declaredWidth: 846, declaredHeight: 1200, sourceWidth: 864, sourceHeight: 1248 });
            out.geometry2 = P.scrambleGeometry({ declaredWidth: 300, declaredHeight: 400, sourceWidth: 320, sourceHeight: 448 });
            out.geometry3 = P.scrambleGeometry({ declaredWidth: 200, declaredHeight: 250, sourceWidth: 256, sourceHeight: 320 });
            out.badGeometryRefused = threw(() => P.scrambleGeometry({ declaredWidth: 846, declaredHeight: 1200, sourceWidth: 850, sourceHeight: 1248 }));

            // The permutation is a bijection whose prefix is pinned to the value
            // the capture's own seed produces; a wrong LCG constant would still
            // be a bijection.
            const order = P.scrambleOrder({ gridX: 9, gridY: 13, key: 59861 });
            out.orderLen = order.length;
            out.orderUnique = new Set(order).size;
            out.orderPrefix = Array.from(order.slice(0, 10));
            const other = P.scrambleOrder({ gridX: 9, gridY: 13, key: 59862 });
            out.orderDiffers = order[0] !== other[0] || order[5] !== other[5];
            return out;
        }, headerB64, pageB64, VIEWER);

        const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected),
            'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));

        check('the greeting parses as a greeting', got.greeting === true, String(got.greeting));
        check('the header frame is not a greeting', got.headerNotGreeting === true, String(got.headerNotGreeting));
        check('the header frame carries no chunk table', got.headerChunksNull === true, String(got.headerChunksNull));
        eq('it declares 176 scenes', got.numOfScenes, 176);
        eq('it declares the page box', got.frame, [846, 1200]);
        eq('it lists one content entry per page', got.contentCount, 176);
        eq('the first page is scene 1', got.first, { name: '0', size: 322524, startSceneNo: 1, endSceneNo: 1 });
        eq('the decrypt key is a 48-byte hex string', got.dkLen, 96);
        check('the decrypt key is hex', got.dkHex === true, String(got.dkHex));

        eq('the page frame carries exactly one chunk', got.chunkCount, 1);
        eq('the scene is the one asked for', got.sceneNo, 8);
        check('the image is scrambled', got.scrambled === true, String(got.scrambled));
        eq('its scramble key is the capture\u2019s', got.key, 59861);
        eq('it is a JPEG', got.format, 'jpeg');
        eq('its declared box is the QVGA profile', got.imageBox, [846, 1200]);
        check('the chunk is raw JPEG, not base64 of it', got.rawJpeg === true, String(got.rawJpeg));
        eq('the JPEG is wider than the declared box', got.jpegSize, [864, 1248]);
        eq('the chunk table accounts for every byte', got.chunkLen, 185871);

        check('a truncated JSON body is refused', got.truncatedRefused === true, String(got.truncatedRefused));
        check('trailing bytes after the chunks are refused', got.trailingRefused === true, String(got.trailingRefused));
        check('a wrong magic is refused', got.badMagicRefused === true, String(got.badMagicRefused));

        eq('the header request is spelled the way the viewer spells it', got.reqHeader,
            'REQUEST HEADER\nt=BGTK_abc_202609280600&fn=64kb_QVGA_h&o=o1');
        eq('the data request carries the decrypt key last', got.reqData, 'REQUEST DATA\nt=T&fn=7&o=O&dk=DK');
        eq('a data request without a key omits the parameter', got.reqDataNoKey, 'REQUEST DATA\nt=T&fn=7&o=O');

        eq('only the chapters are chapters', got.chapters, [
            { name: '\u8868\u7d19', page: 1 },
            { name: '\u76ee\u6b21', page: 7 },
            { name: '\u5965\u4ed8', page: 175 },
        ]);
        eq('the layout flags are kept as flags', got.flags, ['rtl', 'sc', 'mr', 'ml']);
        check('a reply that is not JSONP is refused', got.notJsonpRefused === true, String(got.notJsonpRefused));

        eq('the ticket comes from p0', got.ticket, 'BGTK_0000000000000000000000000000000_20260101000000');
        eq('the obfuid comes from p1', got.obfuid, '0000000000000000000000000000001');
        eq('the book id comes from p3', got.bookId, '100007');
        eq('the session id comes from p8', got.sid, 'sid0000000000000000000000');
        eq('the access uuid comes from p20', got.accessUuid, '00000005-0000-4000-8000-000000000005');

        eq('the QVGA profile is a 96px grid', got.geometry, { cell: 96, block: 94, gridX: 9, gridY: 13 });
        eq('a mid-size page doubles the 32px cell', got.geometry2, { cell: 64, block: 62, gridX: 5, gridY: 7 });
        eq('a small page keeps 32px', got.geometry3, { cell: 32, block: 30, gridX: 8, gridY: 10 });
        check('a page that is not a whole number of cells is refused rather than guessed at',
            got.badGeometryRefused === true, String(got.badGeometryRefused));

        eq('one draw per block', got.orderLen, 117);
        eq('every block is used exactly once', got.orderUnique, 117);
        eq('the capture\u2019s seed draws the capture\u2019s order', got.orderPrefix, [77, 64, 47, 99, 62, 116, 50, 85, 55, 48]);
        check('a different key draws a different order', got.orderDiffers === true, String(got.orderDiffers));
    } finally {
        await browser.close().catch(() => {});
    }
    finish();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
