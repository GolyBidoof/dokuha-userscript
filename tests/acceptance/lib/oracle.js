'use strict';
/*
 * The acceptance oracle: what "the download worked and the pages are
 * descrambled" is allowed to mean when the target came from a live store.
 *
 * A live run has no known-correct bytes to compare against the way the
 * hermetic tests do — `test_descramble_equivalence.js` can compare against a
 * reference because it generated the tile plan itself. A live target cannot
 * supply that. Two signals are used instead, and neither needs a reference:
 *
 *  1. Structure (exact). `parseStoreZip` reads the archive the userscript
 *     writes and `imageInfo` decodes each page, so a broken fetch, a truncated
 *     page or an empty archive fails hard.
 *
 *  2. Two-implementation agreement (strong). The userscript descrambles in a
 *     browser canvas and the headless CLI descrambles in Node; they are
 *     independent implementations of the same store protocol. Comparing their
 *     *pixels* page by page — `fingerprint` and `compareFingerprints` — proves
 *     the pages were put back in the right order. Two separate descramblers
 *     agreeing on content cannot both be silently shuffling tiles, while a
 *     scrambled page on either side collapses the agreement.
 *
 * WHY NOT A SEAM DETECTOR: the obvious single-image heuristic is to look for
 * the periodic seam a tile permutation leaves behind. It was implemented,
 * measured, and discarded — on a synthetic manga page with ordinary panel
 * borders it scored a *clean* page at ratio 15.0 against a scrambled page at
 * 4.1, i.e. it ranked artwork as more scrambled than the real scramble.
 * Manga is full of legitimate periodic structure (panel gutters, screentones,
 * page furniture), so that signal is not separable. `tests/test_acceptance_oracle.js`
 * keeps that counter-example so nobody reintroduces it.
 */

const sharp = require('sharp');

/**
 * Read the entries out of the ZIP the userscript writes.
 *
 * `src/core/41-zip.js` stores every page with compression method 0 (it pushes
 * `localHeader(...), ent.blob` with no deflate), so entries can be sliced out
 * of the buffer directly and no unzip dependency is needed. A method other
 * than 0 means the builder changed and this parser must change with it.
 */
function parseStoreZip(buf) {
    const entries = [];
    let i = 0;
    while (i + 30 <= buf.length) {
        const sig = buf.readUInt32LE(i);
        if (sig === 0x02014b50 || sig === 0x06054b50) break; // central directory / EOCD
        if (sig !== 0x04034b50) throw new Error(`not a ZIP local header at ${i} (0x${sig.toString(16)})`);
        const method = buf.readUInt16LE(i + 8);
        const size = buf.readUInt32LE(i + 18);
        const nameLen = buf.readUInt16LE(i + 26);
        const extraLen = buf.readUInt16LE(i + 28);
        const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
        const start = i + 30 + nameLen + extraLen;
        if (method !== 0) throw new Error(`${name}: compression method ${method}, expected 0 (store)`);
        if (start + size > buf.length) throw new Error(`${name}: entry overruns the buffer`);
        entries.push({ path: name, data: buf.subarray(start, start + size), crc: buf.readUInt32LE(i + 14) });
        i = start + size;
    }
    return entries;
}

/** Decode a page far enough to know it is a real image. */
async function imageInfo(buf) {
    const md = await sharp(buf).metadata();
    return { format: md.format, width: md.width, height: md.height, bytes: buf.length };
}

/**
 * A fixed-size greyscale fingerprint of a page.
 *
 * Deliberately small and squashed: the point is to compare *content* across two
 * encoders that will never produce identical bytes. Resizing to a fixed grid
 * also discards per-encoder noise while keeping the large-scale structure that a
 * tile permutation destroys.
 */
async function fingerprint(buf, size = 64) {
    const { data, info } = await sharp(buf)
        .greyscale()
        .resize(size, size, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
}

/**
 * PSNR between two fingerprints, in dB, with 99 meaning identical.
 *
 * PSNR is the same measure the hermetic codec test uses to call two images
 * "the same modulo encoding", so the threshold has a precedent in this repo.
 * Two correct descrambles land in the high 20s and above; a scrambled page
 * against a clean one lands far below 15.
 */
function compareFingerprints(a, b) {
    if (a.width !== b.width || a.height !== b.height) {
        throw new Error(`fingerprints differ in shape: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
    }
    let se = 0, sae = 0, n = 0;
    for (let i = 0; i < a.data.length; i++) {
        const d = a.data[i] - b.data[i];
        se += d * d;
        sae += Math.abs(d);
        n++;
    }
    const mse = se / n;
    return {
        psnr: mse === 0 ? 99 : +(10 * Math.log10((255 * 255) / mse)).toFixed(2),
        meanAbsDiff: +(sae / n).toFixed(3),
        samples: n,
    };
}

/**
 * Pull the page number out of a page filename, so two implementations can be
 * aligned even when they pad or prefix differently. Returns null when the name
 * carries no number, which the caller reports rather than guessing.
 */
function pageNumber(name) {
    const m = String(name).match(/(\d+)(?=\.[a-z0-9]+$)/i);
    return m ? Number(m[1]) : null;
}

async function comparePageSets(left, right, opts) {
    const L = [], R = [];
    for (const e of left) L.push({ name: e.path || e.name || '', fp: await fingerprint(e.data) });
    for (const e of right) R.push({ name: e.path || e.name || '', fp: await fingerprint(e.data) });
    return compareFingerprintSets(L, R, opts);
}

/**
 * Compare two page sets that already carry fingerprints.
 *
 * This is the form the live run uses: the userscript's pages are fingerprinted
 * inside the browser (shipping a ~60 MB archive to Node just to downscale it
 * would be wasteful), while the CLI's are fingerprinted here from the files it
 * wrote.
 *
 * ALIGNMENT. The two implementations do not necessarily put the same image at
 * the same page number. Two differences were measured on real CMOA output:
 *
 *   * the userscript's headless run drops the cover (`normalizeRunOptions` sets
 *     `skipCover` whenever the run is headless) while the CLI keeps it, so the
 *     sets can be offset by one;
 *   * one side may order pages the other way round. Manga is right-to-left, and
 *     a 211-page run matched at exactly 5 pages clustered around page 109 — the
 *     signature of two sequences running in opposite directions, not of a
 *     descrambling fault.
 *
 * So the comparison searches both a shift and a reversal, and reports which one
 * it used. A genuine descrambling fault agrees under no transform, and the
 * coverage floor below stops a transform from "passing" on a handful of pages.
 */
function compareFingerprintSets(left, right, opts) {
    const minPsnr = (opts && opts.minPsnr) || 25;
    const search = (opts && opts.offsets) || [-2, -1, 0, 1, 2];
    const minCoverage = (opts && opts.minCoverage) || 0.9;
    const byNumber = (entries) => {
        const map = new Map();
        for (const e of entries) {
            const n = pageNumber(e.name || e.path || '');
            if (n !== null) map.set(n, e);
        }
        return map;
    };
    const L = byNumber(left), R = byNumber(right);
    const lSorted = [...L.keys()].sort((a, b) => a - b);
    const rSorted = [...R.keys()].sort((a, b) => a - b);

    const at = (reversed, offset) => {
        const pages = [];
        for (let i = 0; i < lSorted.length; i++) {
            const ln = lSorted[i];
            let rn;
            if (!reversed) {
                rn = ln + offset;
            } else {
                // Rank pairing from the far end, so gaps in either numbering
                // do not break the reversal.
                const j = rSorted.length - 1 - i + offset;
                if (j < 0 || j >= rSorted.length) continue;
                rn = rSorted[j];
            }
            const other = R.get(rn);
            if (!other) continue;
            pages.push({ page: ln, comparedAgainst: rn, ...compareFingerprints(L.get(ln).fp, other.fp) });
        }
        const agreed = pages.filter(p => p.psnr >= minPsnr).length;
        const mean = pages.length ? pages.reduce((a, p) => a + p.psnr, 0) / pages.length : 0;
        return { reversed, offset, pages, agreed, mean };
    };

    const results = [];
    for (const reversed of [false, true]) {
        for (const offset of search) {
            const r = at(reversed, offset);
            if (r.pages.length) results.push(r);
        }
    }

    // An offset must compare essentially the whole set. Without this, a one-page
    // coincidence passes as agreement: in the hermetic test a scrambled page 2
    // "agreed" by aligning left page 2 against clean right page 1 and ignoring
    // everything else. Coverage is what stops the search from hiding a fault.
    const floor = Math.ceil(Math.min(L.size, R.size) * minCoverage);
    const eligible = results.filter(r => r.pages.length >= floor);
    // Most agreeing pages wins; the mean breaks ties between equal counts.
    const best = (eligible.length ? eligible : results).sort((a, b) => (b.agreed - a.agreed) || (b.mean - a.mean))[0] || null;
    if (!best) {
        return {
            compared: 0, agreed: 0, minPsnr, offset: null, reversed: null, offsetSearched: search,
            coverageFloor: floor, leftPages: L.size, rightPages: R.size, worst: null, pages: [], ok: false,
            note: 'the two sets share no page numbers under any transform',
        };
    }
    const underCovered = best.pages.length < floor;
    const worst = best.pages.reduce((w, p) => (p.psnr < w.psnr ? p : w));
    return {
        compared: best.pages.length,
        agreed: best.agreed,
        minPsnr,
        offset: best.offset,
        reversed: best.reversed,
        order: best.reversed ? 'reversed' : 'same-order',
        coverageFloor: floor,
        meanPsnr: +best.mean.toFixed(2),
        leftPages: L.size,
        rightPages: R.size,
        worst,
        pages: best.pages,
        ok: best.pages.length > 0 && best.agreed === best.pages.length,
        note: underCovered
            ? `best transform only compared ${best.pages.length} of ${floor} required pages`
            : undefined,
    };
}

module.exports = {
    parseStoreZip, imageInfo, fingerprint, compareFingerprints, pageNumber,
    comparePageSets, compareFingerprintSets,
};
