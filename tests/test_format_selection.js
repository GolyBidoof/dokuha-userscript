#!/usr/bin/env node
'use strict';
/*
 * The panel's image-format picker has to reach the bytes, not just the label.
 *
 * The BookWalker trial/plaintext path serves JPEG from the CDN, so the chosen
 * format can only exist if this path re-encodes. It used to hand the delivered
 * bytes straight to the archive whenever the page was already at its declared
 * size (the normal case), which made the picker a no-op for every trial volume
 * and named the JPEG after the selected codec.
 *
 * Runs the real fragments in a vm with a canvas stub: no browser, no network.
 * The archive is read back and checked byte-wise, so an entry whose extension
 * disagrees with its contents fails here.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const sharp = require('sharp');
const { readZip } = require('./acceptance/lib/zipread.js');

const root = path.resolve(__dirname, '..');
const fragment = file => fs.readFileSync(path.join(root, 'src', file), 'utf8');
const results = [];
function check(name, pass, detail) {
    results.push(pass);
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' \u2014 ' + detail);
}

const JPEG_W = 8, JPEG_H = 8;
const isJpeg = b => b.length > 2 && b[0] === 0xff && b[1] === 0xd8;
const isWebp = b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
const isPng = b => b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG';

function bytesFor(mime) {
    if (mime === 'image/webp') return Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 test', 'latin1');
    if (mime === 'image/png') return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    return contextJpeg;
}

let contextJpeg = null;

function makeEnv(storage) {
    const flags = { bitmapW: JPEG_W, bitmapH: JPEG_H, forceType: '' };
    const encodes = [];
    const env = { storage, flags, encodes, zip: null };
    const ctx = {
        URLSearchParams, TextEncoder, Blob, console,
        window: {},
        localStorage: {
            getItem: key => (key === 'bwddImageFormat' ? storage.fmt
                : key === 'bwddImageQuality' ? storage.q : null),
            setItem: (key, value) => {
                if (key === 'bwddImageFormat') storage.fmt = String(value);
                if (key === 'bwddImageQuality') storage.q = String(value);
            },
        },
        location: { search: '?cid=book-1' },
        isHeadlessPage: () => false,
        createImageBitmap: async () => ({
            width: flags.bitmapW, height: flags.bitmapH, close() {},
        }),
        document: {
            body: { appendChild() {} },
            createElement(tag) {
                if (tag !== 'canvas') return { click() {}, remove() {} };
                const canvas = {
                    width: 0, height: 0,
                    getContext: () => ({ drawImage() {} }),
                    toBlob(cb, type, quality) {
                        encodes.push({ type, quality, width: canvas.width, height: canvas.height });
                        const mime = flags.forceType || type || 'image/jpeg';
                        cb(new Blob([bytesFor(mime)], { type: mime }));
                    },
                };
                return canvas;
            },
        },
        performance: { now: () => 0 },
        cdnFetch: async () => ({ ok: true, blob: async () => new Blob([contextJpeg], { type: 'image/jpeg' }) }),
        authQuery: () => '', makeUploadBarUpdater: () => () => {},
        setBar() {}, reportRunProgress() {}, setRunDetails() {},
        ensureBridgeRunning: async () => true, waitForBridgeIdle: async () => true,
        mokuroStartSession: async () => ({ session_id: 'test', safe_title: 'test' }),
        safeLogText: String,
        bridgeSessionPath: (id, route) => id + route,
        mokuroBridgePost: async () => ({ ok: true, json: async () => ({}) }),
        URL: {
            createObjectURL: (value) => { env.zip = value; return 'blob:test'; },
            revokeObjectURL() {},
        },
        setTimeout: (fn) => { if (fn) fn(); return 0; },
    };
    vm.createContext(ctx);
    vm.runInContext(
        fragment('core/12-imagecodec.js') +
        fragment('sites/bookwalker/00-state.js') +
        fragment('core/40-naming.js') +
        fragment('core/41-zip.js') +
        fragment('core/31-mokuro.js') +
        fragment('sites/bookwalker/21-trial-zip.js') +
        '\nglobalThis.api = { resolveImageCodec, refreshImageCodec, get imageCodec() { return IMAGE_CODEC; }, downloadTrialZip };',
        ctx,
    );
    env.ctx = ctx;
    return env;
}

async function runTrial(opts) {
    const env = makeEnv({ fmt: opts.fmt || 'jpeg', q: opts.q || '0.92' });
    if (opts.bitmap) { env.flags.bitmapW = opts.bitmap[0]; env.flags.bitmapH = opts.bitmap[1]; }
    if (opts.forceType) env.flags.forceType = opts.forceType;
    env.ctx.api.refreshImageCodec();

    const fid = 'OEBPS/text/p-0001.xhtml';
    const list = opts.size ? [{ Page: { Size: { Width: opts.size[0], Height: opts.size[1] } } }] : [];
    const config = { [fid]: { FileLinkInfo: { PageCount: 1, PageLinkInfoList: list } } };
    const bar = () => ({ wrap: { style: {} }, fill: { style: {} }, labRate: {} });
    const ui = { barDownload: bar(), barDescramble: bar(), barMokuro: bar(), barUpload: bar() };
    const ok = await env.ctx.api.downloadTrialZip(ui, config, [{ file: fid }],
        'test', {}, 'zip', { textContent: '' }, 'test');
    if (!env.zip) throw new Error('no archive was produced (run ok=' + ok + ')');
    const entries = readZip(Buffer.from(await env.zip.arrayBuffer()));
    return { ok, entries, encodes: env.encodes };
}

(async () => {
    contextJpeg = await sharp({
        create: { width: JPEG_W, height: JPEG_H, channels: 3, background: { r: 200, g: 30, b: 40 } },
    }).jpeg({ quality: 95 }).toBuffer();

    const size = [JPEG_W, JPEG_H];

    // The default must stay a bit-exact passthrough: the CDN already serves the
    // final JPEG, so a JPEG selection with nothing to crop may not re-encode.
    {
        const out = await runTrial({ fmt: 'jpeg', size });
        const e = out.entries[0] || { name: '(none)', data: Buffer.alloc(0) };
        check('jpeg keeps the delivered bytes untouched',
            out.ok && out.encodes.length === 0 && e.data.equals(contextJpeg),
            'encodes=' + out.encodes.length + ' bytes=' + e.data.length + '/' + contextJpeg.length);
        check('and the entry is named .jpg', e.name === '0001 p-0001.jpg', e.name);
    }

    // WebP selected: the bytes, the type and the extension all have to follow.
    {
        const out = await runTrial({ fmt: 'webp', size });
        const e = out.entries[0] || { name: '(none)', data: Buffer.alloc(0) };
        check('webp re-encodes a page that needed no crop',
            out.ok && out.encodes.length === 1 && out.encodes[0].type === 'image/webp',
            JSON.stringify(out.encodes));
        check('webp entry holds real WebP bytes', isWebp(e.data), e.data.subarray(0, 12).toString('hex'));
        check('webp entry is named .webp', e.name === '0001 p-0001.webp', e.name);
        check('webp honours the stored quality', out.encodes[0] && out.encodes[0].quality === 0.92,
            String(out.encodes[0] && out.encodes[0].quality));
    }

    // PNG and Lossless are the other two settings; each must encode its own type.
    {
        const out = await runTrial({ fmt: 'png', size });
        const e = out.entries[0] || { name: '(none)', data: Buffer.alloc(0) };
        check('png encodes PNG bytes and names them .png',
            out.encodes[0] && out.encodes[0].type === 'image/png' && isPng(e.data) && e.name.endsWith('.png'),
            e.name + ' ' + JSON.stringify(out.encodes));
    }
    {
        const out = await runTrial({ fmt: 'lossless', size });
        const e = out.entries[0] || { name: '(none)', data: Buffer.alloc(0) };
        check('lossless is WebP at quality 1',
            out.encodes[0] && out.encodes[0].type === 'image/webp' && out.encodes[0].quality === 1 && e.name.endsWith('.webp'),
            e.name + ' ' + JSON.stringify(out.encodes));
    }

    // The crop still has to happen, and the output has to be the declared box.
    {
        const out = await runTrial({ fmt: 'webp', size: [4, 6] });
        const e = out.entries[0] || { name: '(none)', data: Buffer.alloc(0) };
        check('a page larger than its declared box is cropped to it',
            out.encodes[0] && out.encodes[0].width === 4 && out.encodes[0].height === 6,
            JSON.stringify(out.encodes));
        check('and the cropped page is still WebP', isWebp(e.data) && e.name.endsWith('.webp'), e.name);
    }

    // No declared size: there is nothing to crop, but the format still applies.
    {
        const out = await runTrial({ fmt: 'png', size: null });
        const e = out.entries[0] || { name: '(none)', data: Buffer.alloc(0) };
        check('a page with no declared size is still converted',
            out.ok && out.encodes.length === 1 && isPng(e.data) && e.name.endsWith('.png'),
            e.name + ' encodes=' + out.encodes.length);
    }

    // A browser without a WebP encoder silently returns PNG. The entry must then
    // be named after the bytes, not after the setting that could not be applied.
    {
        const out = await runTrial({ fmt: 'webp', size, forceType: 'image/png' });
        const e = out.entries[0] || { name: '(none)', data: Buffer.alloc(0) };
        check('a silent encoder fallback is labelled by its real type',
            isPng(e.data) && e.name.endsWith('.png'),
            e.name + ' ' + e.data.subarray(0, 8).toString('hex'));
    }

    const failed = results.filter(pass => !pass).length;
    console.log(failed ? '\n' + failed + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error('FATAL', error); process.exitCode = 1; });
