'use strict';
/*
 * Drive the built userscript inside headless Chrome against a live store.
 *
 * INJECTION TIMING IS LOAD-BEARING. The script goes in at document-start, ahead
 * of the viewer's own scripts, and the run does not begin until the viewer has
 * settled. Both halves are needed, and CMOA is the case that proves it:
 *
 *   `bibGetCntntInfo.php` answers `result: -100` with no `p` token unless the
 *   request carries a `k` parameter, which only the viewer's own call has. The
 *   script's self-minted fallback URL omits `k`
 *   (src/sites/cmoa/00-state.js `cmoaContentInfoUrl`), so a run that falls back
 *   gets no token, builds image URLs without `p`, and is answered 403 for every
 *   page. Measured on the same free volume:
 *
 *     inject after load                 -> 0/191 pages, 191 errors
 *     document-start, start immediately -> flaky: 191/191 once, 0/191 the next
 *     document-start + settle           -> 191/191, zero errors, reproducible
 *
 *   So a late-injecting harness reports a downloader failure that is really its
 *   own artefact. `settleMs` waits for the viewer to finish its own handshake,
 *   which is also when a real user would press the button.
 *
 * `window.__BWDD_HEADLESS__` makes the script install `window.__bwddAutomation`
 * and skip its panel — the entry point `bookwalker-native-cli` uses.
 *
 * THE ARCHIVE IS NOT SHIPPED TO NODE. `finishZip()` hands the archive to a blob
 * URL and clicks an anchor; there is no download directory in headless Chrome,
 * so `URL.createObjectURL` is wrapped to catch it. A free volume is ~60 MB,
 * which is wasteful to base64 through CDP, so the archive is parsed and each
 * page reduced to a 64x64 grey fingerprint *inside the page* and only the
 * fingerprints come back. `readCapturedZip` remains for when the bytes
 * themselves are wanted.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const FP = 64; // fingerprint edge, in pixels

// Runs before any page script.
const BOOT = `(() => {
  window.__BWDD_HEADLESS__ = true;
  window.__bwddZips = [];
  const orig = URL.createObjectURL;
  URL.createObjectURL = function (blob) {
    try { if (blob && typeof blob.size === 'number') window.__bwddZips.push(blob); } catch (e) {}
    return orig.call(this, blob);
  };
})();`;

const FIND_ZIP = `async () => {
  const zips = (window.__bwddZips || []).slice().reverse();
  for (const blob of zips) {
    if (!blob || typeof blob.slice !== 'function') continue;
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return blob;
  }
  return null;
}`;

/** Read the captured archive out of the page as a Buffer (kept for --keep-archive). */
async function readCapturedZip(page) {
    const b64 = await page.evaluate(async (findSrc) => {
        const blob = await eval(`(${findSrc})`)();
        if (!blob) return null;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        return btoa(s);
    }, FIND_ZIP);
    return b64 ? Buffer.from(b64, 'base64') : null;
}

/**
 * In-page: parse the archive and fingerprint every page.
 *
 * The ZIP is the userscript's own STORE-method writer, so entries are sliced
 * directly. Each page is decoded with createImageBitmap (which fails loudly on a
 * page that is not a real image) and reduced to a fixed greyscale grid, which is
 * all the cross-implementation comparison needs.
 */
async function extractArchive(page, fpSize = FP) {
    return page.evaluate(async (findSrc, size) => {
        const blob = await eval(`(${findSrc})`)();
        if (!blob) return { captured: false, entries: [] };
        const buf = new Uint8Array(await blob.arrayBuffer());
        const dv = new DataView(buf.buffer);
        const entries = [];
        let i = 0;
        while (i + 30 <= buf.length) {
            const sig = dv.getUint32(i, true);
            if (sig !== 0x04034b50) break;
            const method = dv.getUint16(i + 8, true);
            const size = dv.getUint32(i + 18, true);
            const nl = dv.getUint16(i + 26, true), el = dv.getUint16(i + 28, true);
            const name = new TextDecoder().decode(buf.subarray(i + 30, i + 30 + nl));
            const start = i + 30 + nl + el;
            if (method !== 0) throw new Error(name + ': compression method ' + method + ', expected 0 (store)');
            if (start + size > buf.length) throw new Error(name + ': entry overruns the archive');
            entries.push({ name, size, bytes: buf.subarray(start, start + size) });
            i = start + size;
        }

        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const out = [];
        for (const e of entries) {
            const ab = e.bytes.slice().buffer;
            const bmp = await createImageBitmap(new Blob([ab]));
            const width = bmp.width, height = bmp.height;
            ctx.clearRect(0, 0, size, size);
            ctx.drawImage(bmp, 0, 0, size, size);
            if (bmp.close) bmp.close();
            const px = ctx.getImageData(0, 0, size, size).data;
            const grey = new Uint8Array(size * size);
            for (let p = 0, g = 0; p < px.length; p += 4, g++) {
                grey[g] = (px[p] * 299 + px[p + 1] * 587 + px[p + 2] * 114) / 1000 | 0;
            }
            let bin = '';
            for (let b = 0; b < grey.length; b++) bin += String.fromCharCode(grey[b]);
            out.push({ name: e.name, size: e.size, width, height, fp: btoa(bin) });
        }
        return { captured: true, total: entries.length, entries: out };
    }, FIND_ZIP, fpSize);
}

/**
 * Run one store target through the userscript.
 *
 * `scriptPath` is the built .user.js. Returns the automation result plus the
 * fingerprint of every page. Never throws for a store-side failure — the caller
 * decides whether an error is a finding or noise.
 */
async function downloadWithUserscript(opts) {
    const { browser, scriptPath, url, timeoutMs = 600000, settleMs = 7000, log = () => {} } = opts;
    const src = fs.readFileSync(scriptPath, 'utf8');
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', e => consoleErrors.push(String(e && e.message || e).slice(0, 300)));

    try {
        await page.setViewport({ width: 1280, height: 900 });
        await page.evaluateOnNewDocument(BOOT);
        await page.evaluateOnNewDocument(src);
        log(`  loading ${url}`);
        // A store is allowed to be slow, and a pending request on the landing
        // page can hold `domcontentloaded` open past the timeout without meaning
        // the page is unusable. Carry on and let the automation wait decide.
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => {
            log(`  navigation did not settle (${String(e && e.message || e).slice(0, 90)}); continuing`);
        });

        // `window.__bwddSite` cannot be used as the ready signal: 90-boot.js only
        // exposes it when BWDD_DEBUG is on and the page is not headless, and
        // headless is how the automation API gets installed at all.
        const installed = await page.waitForFunction(
            () => typeof window.__bwddAutomation === 'object' && window.__bwddAutomation !== null,
            { timeout: 20000 },
        ).then(() => true).catch(() => false);

        if (!installed) {
            // Some pages need a real DOM before the adapter can boot.
            log('  not installed at document-start, retrying after load');
            await page.addScriptTag({ content: src }).catch(() => {});
            const late = await page.waitForFunction(
                () => typeof window.__bwddAutomation === 'object' && window.__bwddAutomation !== null,
                { timeout: 15000 },
            ).then(() => true).catch(() => false);
            if (!late) {
                const diag = await page.evaluate(() => ({
                    headless: window.__BWDD_HEADLESS__ === true,
                    automation: typeof window.__bwddAutomation,
                    globals: Object.keys(window).filter(k => /bwdd|BWDD/i.test(k)),
                    title: document.title, href: location.href, readyState: document.readyState,
                })).catch(() => null);
                return { site: null, pages: null, consoleErrors, result: { ok: false, error: 'userscript did not install', diag } };
            }
        }

        // Let the viewer finish its own handshake before pressing the button.
        if (settleMs > 0) await new Promise(r => setTimeout(r, settleMs));

        const site = await page.evaluate(() => ({
            version: window.__bwddAutomation.version,
            href: location.href,
            title: document.title,
        }));

        const outcome = await Promise.race([
            page.evaluate(async () => {
                try {
                    return { ok: true, value: await window.__bwddAutomation.start({ mode: 'zip' }) };
                } catch (e) {
                    return { ok: false, error: String(e && e.message || e) };
                }
            }),
            new Promise(r => setTimeout(() => r({ ok: false, error: `automation timeout after ${timeoutMs}ms` }), timeoutMs)),
        ]);

        let pages = null;
        if (outcome.ok) {
            try {
                pages = await extractArchive(page);
            } catch (e) {
                pages = { captured: false, error: String(e && e.message || e).slice(0, 300), entries: [] };
            }
        }
        return { site, result: outcome, pages, consoleErrors };
    } catch (e) {
        return { site: null, pages: null, consoleErrors, result: { ok: false, error: String(e && e.message || e) } };
    } finally {
        await page.close().catch(() => {});
    }
}

async function launch(opts) {
    return puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        headless: true,
        // A store's viewer can block its main thread long enough that the
        // default CDP timeout fires mid-evaluate. Report a store failure rather
        // than killing the run.
        protocolTimeout: 300000,
        args: ['--no-sandbox', '--disable-dev-shm-usage', ...((opts && opts.args) || [])],
    });
}

module.exports = { launch, downloadWithUserscript, readCapturedZip, extractArchive, BOOT, FP };
