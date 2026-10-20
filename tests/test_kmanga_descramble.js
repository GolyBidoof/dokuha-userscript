#!/usr/bin/env node
'use strict';
/*
 * Un-shuffling a real k-manga page, on a canvas.
 *
 * The oracle is not "does it decode" -- a wrongly un-shuffled page decodes
 * perfectly, it is just a mosaic of unrelated fragments. It is the seam energy:
 * the scramble moves 94px blocks around a 96px grid, so a page that is still
 * shuffled has a sharp discontinuity every 94 pixels and a page that has been
 * put back does not. dokuha-cli measured ~1.1x of the interior gradient for the
 * right key and ~5x for a key off by one on this same fixture; the rolling
 * thresholds below pin the same separation through the canvas, where the page
 * is re-encoded rather than copied raw.
 *
 * The refusals matter as much as the shuffle: a non-JPEG, an unreadable JPEG
 * header or a composite scene must throw instead of producing a wrong page.
 */
const fs = require('fs');
const path = require('path');
const { launch, reporter, bytesToBase64 } = require('./_kmanga');

const pageB64 = bytesToBase64(fs.readFileSync(path.join(__dirname, 'fixtures', 'kmanga-page8.bcp')));

(async () => {
    const { check, finish } = reporter();
    const { browser, page, ready } = await launch();
    try {
        check('the k-manga adapter boots and publishes its protocol surface', ready, 'window.__bwddKmangaProtocol');

        const got = await page.evaluate(async (pb) => {
            const P = window.__bwddKmangaProtocol;
            const bytes = (s) => {
                const bin = atob(s);
                const out = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
                return out;
            };
            const frame = P.parseFrame(bytes(pb));
            const image = frame.body.scenes[0].images[0];
            const jpeg = frame.chunks[0];

            async function seamRatio(blob, step) {
                const bitmap = await createImageBitmap(blob);
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(bitmap, 0, 0);
                const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                let seam = 0, seamCount = 0, inner = 0, innerCount = 0;
                for (let y = 0; y < canvas.height; y++) {
                    for (let x = 1; x < canvas.width; x++) {
                        const a = (y * canvas.width + x) * 4;
                        const b = (y * canvas.width + x - 1) * 4;
                        const delta = Math.abs(d[a] - d[b]) + Math.abs(d[a + 1] - d[b + 1]) + Math.abs(d[a + 2] - d[b + 2]);
                        if (x % step === 0) { seam += delta; seamCount++; } else { inner += delta; innerCount++; }
                    }
                }
                if (bitmap.close) bitmap.close();
                return (seam / seamCount) / (inner / innerCount);
            }

            const out = {};
            const descriptor = { key: image.key, declaredWidth: image.width, declaredHeight: image.height };
            const fixed = await P.descrambleJpeg(jpeg, descriptor);
            const wrong = await P.descrambleJpeg(jpeg, {
                key: image.key + 1, declaredWidth: image.width, declaredHeight: image.height,
            });

            out.fixedType = fixed.blob.type;
            out.wrongType = wrong.blob.type;
            const fixedBitmap = await createImageBitmap(fixed.blob);
            out.fixedSize = [fixedBitmap.width, fixedBitmap.height];
            fixedBitmap.close();
            out.correctRatio = await seamRatio(fixed.blob, 94);
            out.wrongRatio = await seamRatio(wrong.blob, 94);

            const pageBlob = await P.pageBlob(frame, { name: image.name || '0' });
            out.pageBlobType = pageBlob.blob.type;
            out.pageBlobExt = pageBlob.ext;

            const threw = async (fn) => { try { await fn(); return ''; } catch (e) { return String(e.message); } };
            out.compositeRefused = await threw(() => P.pageBlob({
                body: { scenes: [{ sceneNo: 1, sceneImagePartition: 2, images: [{ format: 'jpeg' }, { format: 'jpeg' }] }] },
                chunks: [jpeg],
            }, { name: 'composite' }));
            out.formatRefused = await threw(() => P.pageBlob({
                body: { scenes: [{ sceneNo: 1, sceneImagePartition: 1, images: [{ format: 'png', key: 0, width: 2, height: 2 }] }] },
                chunks: [jpeg],
            }, { name: 'png' }));
            out.notJpegRefused = await threw(() => P.pageBlob({
                body: { scenes: [{ sceneNo: 1, sceneImagePartition: 1, images: [{ format: 'jpeg', key: 1, width: 2, height: 2 }] }] },
                chunks: [new Uint8Array([1, 2, 3, 4])],
            }, { name: 'garbage' }));

            // An unscrambled page is served whole: the viewer skips the shuffle
            // at key 0, and re-encoding it would only add a generation of loss.
            const plain = await P.pageBlob({
                body: { scenes: [{ sceneNo: 1, sceneImagePartition: 1, images: [{ format: 'jpeg', key: 0, width: image.width, height: image.height }] }] },
                chunks: [jpeg],
            }, { name: 'plain' });
            out.plainType = plain.blob.type;
            out.plainExt = plain.ext;
            const plainBytes = new Uint8Array(await plain.blob.arrayBuffer());
            out.plainUntouched = plainBytes.length === jpeg.length && plainBytes[0] === jpeg[0] && plainBytes[1] === jpeg[1];
            const wire = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
            out.wireSize = [wire.width, wire.height];
            wire.close();

            // The same key-0 page with WebP selected: the passthrough is only
            // free while JPEG is chosen, so the selected codec has to be applied
            // here too or the picker is a no-op for every whole page.
            window.__bwddUI.setImageFormat('webp');
            const plainWebp = await P.pageBlob({
                body: { scenes: [{ sceneNo: 1, sceneImagePartition: 1, images: [{ format: 'jpeg', key: 0, width: image.width, height: image.height }] }] },
                chunks: [jpeg],
            }, { name: 'plain-webp' });
            out.plainWebpType = plainWebp.blob.type;
            out.plainWebpExt = plainWebp.ext;
            const plainWebpBitmap = await createImageBitmap(plainWebp.blob);
            out.plainWebpSize = [plainWebpBitmap.width, plainWebpBitmap.height];
            plainWebpBitmap.close();
            const plainWebpBytes = new Uint8Array(await plainWebp.blob.arrayBuffer());
            out.plainWebpUntouched = plainWebpBytes.length === jpeg.length
                && plainWebpBytes[0] === jpeg[0] && plainWebpBytes[1] === jpeg[1];
            window.__bwddUI.setImageFormat('jpeg');

            return out;
        }, pageB64);

        check('the rebuilt page is a JPEG', got.fixedType === 'image/jpeg', got.fixedType);
        check('it is the declared page box, not the padded grid',
            JSON.stringify(got.fixedSize) === JSON.stringify([846, 1200]), JSON.stringify(got.fixedSize));
        check('the seams are gone with the right key', got.correctRatio < 2.0,
            'seam ratio ' + got.correctRatio.toFixed(2));
        check('they are still there with the wrong key', got.wrongRatio > 3.0,
            'seam ratio ' + got.wrongRatio.toFixed(2));
        check('so the key actually decides the page', got.wrongRatio / got.correctRatio > 2.0,
            (got.wrongRatio / got.correctRatio).toFixed(2) + 'x apart');

        check('a parsed reply produces a JPEG page', got.pageBlobType === 'image/jpeg', got.pageBlobType);
        check('and a matching archive extension', got.pageBlobExt === 'jpg', String(got.pageBlobExt));
        check('a composite scene is refused rather than half-written',
            /composite scene/.test(got.compositeRefused), got.compositeRefused);
        check('a non-JPEG image setting is named rather than guessed at',
            /not implemented/.test(got.formatRefused), got.formatRefused);
        check('an unreadable JPEG is refused', /not a readable JPEG/.test(got.notJpegRefused), got.notJpegRefused);
        check('an unscrambled page is passed through untouched', got.plainUntouched === true,
            got.plainType + '/' + got.plainExt);
        check('and keeps the jpg extension', got.plainExt === 'jpg', String(got.plainExt));
        check('with WebP selected a whole page is re-encoded to WebP',
            got.plainWebpType === 'image/webp' && got.plainWebpExt === 'webp',
            got.plainWebpType + '/' + got.plainWebpExt);
        check('and it is no longer the delivered JPEG', got.plainWebpUntouched === false,
            'bytes differ from the wire image');
        check('the re-encoded whole page keeps the wire page box',
            JSON.stringify(got.plainWebpSize) === JSON.stringify(got.wireSize),
            JSON.stringify(got.plainWebpSize) + ' vs wire ' + JSON.stringify(got.wireSize));
    } finally {
        await browser.close().catch(() => {});
    }
    finish();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
