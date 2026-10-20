// test_acceptance_oracle.js — the oracle the live acceptance runs rest on.
//
// The store acceptance tests are opt-in and never run in CI's default suite, so
// without this file the thing that decides whether a live run passed would
// itself be unverified. This checks the two halves exactly:
//
//   * the store-ZIP parser reads what `src/core/41-zip.js` writes and rejects
//     what it must not silently accept;
//   * the cross-implementation comparison separates agreeing pages from a
//     scrambled page, and does so on artwork that is deliberately hostile —
//     the periodic page that defeated the discarded seam heuristic, kept as a
//     regression guard so it is not reintroduced (see the header of
//     tests/acceptance/lib/oracle.js).
'use strict';
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const {
    parseStoreZip, imageInfo, fingerprint, compareFingerprints, pageNumber, comparePageSets,
} = require('./acceptance/lib/oracle.js');

const SIZE = 900;
const results = [];
const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };

// A minimal STORE-method ZIP writer, matching src/core/41-zip.js.
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function storeZip(entries) {
    const parts = [];
    for (const [name, data] of entries) {
        const nameB = Buffer.from(name, 'utf8');
        const h = Buffer.alloc(30 + nameB.length);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0x0800, 6);
        h.writeUInt16LE(0, 8);            // method 0 = store, exactly as the builder
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(0, 12);
        h.writeUInt32LE(crc32(data), 14);
        h.writeUInt32LE(data.length, 18);
        h.writeUInt32LE(data.length, 22);
        h.writeUInt16LE(nameB.length, 26);
        h.writeUInt16LE(0, 28);
        nameB.copy(h, 30);
        parts.push(h, data);
    }
    return Buffer.concat(parts);
}

// Synthetic pages. The clean page carries strong periodic structure on purpose:
// for (x % 137 < 3 || y % 211 < 3) draws panel borders, i.e. exactly the comb a
// seam detector mistakes for a scramble.
function makePage(w, h, seed) {
    const px = Buffer.alloc(w * h);
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let v = 245 - 30 * Math.sin(x / 90) * Math.cos(y / 70);
        if (x % 137 < 3 || y % 211 < 3) v = 30;
        if (rnd() < 0.06) v = 40 + rnd() * 80;
        px[y * w + x] = Math.max(0, Math.min(255, v));
    }
    return px;
}
function scramble(px, w, h, tw, th, seed) {
    const out = Buffer.alloc(w * h);
    const cols = Math.ceil(w / tw), rows = Math.ceil(h / th);
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const order = [...Array(cols * rows).keys()].sort(() => rnd() - 0.5);
    order.forEach((src, dst) => {
        const sx = (src % cols) * tw, sy = Math.floor(src / cols) * th;
        const dx = (dst % cols) * tw, dy = Math.floor(dst / cols) * th;
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
            const ax = sx + x, ay = sy + y, bx = dx + x, by = dy + y;
            if (ax < w && ay < h && bx < w && by < h) out[by * w + bx] = px[ay * w + ax];
        }
    });
    return out;
}
const jpeg = (px, w, h) =>
    sharp(px, { raw: { width: w, height: h, channels: 1 } }).jpeg({ quality: 88 }).toBuffer();

(async () => {
    const entries = [
        ['001.jpg', await jpeg(makePage(200, 300, 1), 200, 300)],
        ['002.jpg', await jpeg(makePage(200, 300, 2), 200, 300)],
        ['003.jpg', await jpeg(makePage(200, 300, 3), 200, 300)],
    ];
    const zip = storeZip(entries);
    const parsed = parseStoreZip(zip);
    check('the store ZIP parses', parsed.length === 3, `${parsed.length} entries`);
    check('entry order and names survive',
        parsed.map(e => e.path).join(',') === '001.jpg,002.jpg,003.jpg', parsed.map(e => e.path).join(','));
    check('entry bytes are exact',
        parsed.every((e, i) => e.data.equals(entries[i][1])), 'every entry matches byte for byte');
    check('the recorded CRC matches the payload',
        parsed.every((e, i) => e.crc === crc32(entries[i][1])), 'crc32 agrees');

    const deflated = Buffer.from(zip);
    deflated.writeUInt16LE(8, 8); // claim deflate on the first entry
    let err = null;
    try { parseStoreZip(deflated); } catch (e) { err = e.message; }
    check('a non-store entry is rejected, not silently misread',
        !!err && /compression method 8/.test(err), err || 'no error raised');

    err = null;
    try { parseStoreZip(zip.subarray(0, zip.length - 40)); } catch (e) { err = e.message; }
    check('a truncated archive is rejected', !!err && /overruns/.test(err), err || 'no error raised');

    check('page numbers are read out of ordinary page filenames',
        pageNumber('007.jpg') === 7 && pageNumber('page-0012.png') === 12 && pageNumber('cover') === null,
        `007.jpg->${pageNumber('007.jpg')} page-0012.png->${pageNumber('page-0012.png')} cover->${pageNumber('cover')}`);

    const info = await imageInfo(entries[0][1]);
    check('a page decodes to real image metadata',
        info.format === 'jpeg' && info.width === 200 && info.height === 300,
        `${info.format} ${info.width}x${info.height}`);

    const W = SIZE, H = SIZE;
    const clean = makePage(W, H, 11);
    const clean2 = makePage(W, H, 12);
    const scrambled = scramble(clean, W, H, 128, 128, 7);

    const same = compareFingerprints(await fingerprint(await jpeg(clean, W, H)),
                                     await fingerprint(await jpeg(clean, W, H)));
    check('identical pages compare as identical', same.psnr === 99, `PSNR ${same.psnr}`);

    const diffContent = compareFingerprints(await fingerprint(await jpeg(clean, W, H)),
                                            await fingerprint(await jpeg(clean2, W, H)));
    check('two different clean pages still look like the same kind of page',
        diffContent.psnr > 25, `PSNR ${diffContent.psnr} (same layout, different ink)`);

    const scram = compareFingerprints(await fingerprint(await jpeg(clean, W, H)),
                                      await fingerprint(await jpeg(scrambled, W, H)));
    check('a scrambled page collapses the comparison',
        scram.psnr < 25, `PSNR ${scram.psnr} — threshold is 25`);

    // The adversarial case, stated as the guard it is: this clean page's own
    // periodic artwork must NOT be reported as a mismatch against itself.
    const periodic = await comparePageSets(
        [{ path: '001.jpg', data: await jpeg(clean, W, H) }],
        [{ path: '001.jpg', data: await jpeg(clean, W, H) }]);
    check('periodic manga artwork is not mistaken for a scramble',
        periodic.ok === true && !!periodic.worst && periodic.worst.psnr >= 25,
        `PSNR ${periodic.worst && periodic.worst.psnr} on a page with 137px panel gutters`);

    const mixed = await comparePageSets(
        [{ path: '001.jpg', data: await jpeg(clean, W, H) }, { path: '002.jpg', data: await jpeg(clean, W, H) }],
        [{ path: '001.jpg', data: await jpeg(clean, W, H) }, { path: '002.jpg', data: await jpeg(scrambled, W, H) }]);
    check('one scrambled page among clean ones fails the set',
        mixed.ok === false && mixed.agreed === 1 && mixed.worst.page === 2,
        `agreed ${mixed.agreed}/${mixed.compared}, worst page ${mixed.worst && mixed.worst.page} at PSNR ${mixed.worst && mixed.worst.psnr}`);

    // Pages distinct enough that a wrong pairing scores far below the
    // threshold; otherwise a mis-alignment could "agree" by accident.
    function makeDistinct(w, h, seed) {
        const px = Buffer.alloc(w * h);
        let s = seed * 7919 + 13;
        const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        const bx = 40 + (seed % 4) * 180, by = 30 + (seed % 3) * 200;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            let v = (x * (seed + 1) + y * (seed + 3)) % 255;
            if (x > bx && x < bx + 260 && y > by && y < by + 320) v = 18 + (seed * 9) % 40;
            if (rnd() < 0.10) v = rnd() * 60;
            px[y * w + x] = Math.max(0, Math.min(255, v | 0));
        }
        return px;
    }
    const DW = 600, DH = 600;
    const content = [];
    for (let s = 0; s < 4; s++) content.push(await jpeg(makeDistinct(DW, DH, s), DW, DH));
    const forward = content.map((data, i) => ({ name: String(i + 1).padStart(3, '0') + '.jpg', data }));
    const backward = content.slice().reverse().map((data, i) => ({ name: String(i + 1).padStart(3, '0') + '.jpg', data }));

    const cross = await comparePageSets(forward, backward);
    check('a reversed page order is recognised rather than read as a mismatch',
        cross.ok === true && cross.reversed === true && cross.compared === 4,
        `ok=${cross.ok} order=${cross.order} agreed ${cross.agreed}/${cross.compared} at offset ${cross.offset}`);

    const scrambledPage2 = await jpeg(scramble(makeDistinct(DW, DH, 2), DW, DH, 128, 128, 5), DW, DH);
    const brokenBackward = backward.map((e, i) => (i === 1 ? { ...e, data: scrambledPage2 } : e));
    const broken = await comparePageSets(forward, brokenBackward);
    check('reversal does not rescue a scrambled page',
        broken.ok === false && broken.agreed === 3,
        `agreed ${broken.agreed}/${broken.compared}, worst page ${broken.worst && broken.worst.page} at ${broken.worst && broken.worst.psnr} dB`);

    // Nothing corresponds, in either direction: this must not pass just because
    // the reversal transform lets every rank pair up with something.
    const unrelated = await comparePageSets(
        [{ path: '001.jpg', data: await jpeg(makeDistinct(DW, DH, 11), DW, DH) }, { path: '002.jpg', data: await jpeg(makeDistinct(DW, DH, 12), DW, DH) }],
        [{ path: '001.jpg', data: await jpeg(makeDistinct(DW, DH, 21), DW, DH) }, { path: '002.jpg', data: await jpeg(makeDistinct(DW, DH, 22), DW, DH) }]);
    check('unrelated page sets do not pass',
        unrelated.ok === false && unrelated.agreed === 0,
        `agreed ${unrelated.agreed}/${unrelated.compared}, worst ${unrelated.worst && unrelated.worst.psnr} dB`);

    const failed = results.filter(r => !r.pass);
    fs.writeFileSync(path.join(__dirname, 'acceptance_oracle_result.json'), JSON.stringify({ results }, null, 2));
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
