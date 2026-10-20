    // dokuha-cli's descrambleJpeg used sharp to decode to raw RGB, copied the
    // inner (cell-2) square of every cell into its destination rectangle and
    // re-encoded with sharp. The browser has no raw pixel copy that cheap, but a
    // canvas drawImage of the same source rectangle to the same destination
    // rectangle is the identical operation, so the port keeps the CLI's loop
    // verbatim and lets drawImage do the blit.
    //
    // The CLI's refusal to descramble a page it cannot be sure of is kept: a
    // non-JPEG, an unreadable JPEG header or a composite scene throws instead of
    // producing a wrong page. Bytes that are never written are recoverable; a
    // silently scrambled page looks like a success.
    async function kmangaDecodeImage(bytes, mimeType) {
        const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const blobType = (typeof mimeType === 'string' && mimeType !== 'application/octet-stream') ? mimeType : undefined;
        const blob = new Blob([buffer], { type: blobType });
        if (typeof createImageBitmap === 'function') {
            try {
                const bitmap = await createImageBitmap(blob);
                return {
                    element: bitmap, width: bitmap.width, height: bitmap.height,
                    cleanup: function () { try { if (bitmap.close) bitmap.close(); } catch (e) {} },
                };
            } catch (e) {  }
        }
        return new Promise(function (resolve, reject) {
            const objectUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.decoding = 'async';
            img.onload = function () {
                resolve({
                    element: img,
                    width: img.naturalWidth || img.width,
                    height: img.naturalHeight || img.height,
                    cleanup: function () { try { URL.revokeObjectURL(objectUrl); img.src = ''; } catch (e) {} },
                });
            };
            img.onerror = function (e) { try { URL.revokeObjectURL(objectUrl); } catch (_) {} reject(e || new Error('image decode failed')); };
            img.src = objectUrl;
        });
    }

    // Re-encode through a canvas, in the codec the user selected. The direct
    // toBlob path is preferred; the data: URL path is the fallback for a canvas
    // implementation without it.
    async function kmangaCanvasToBlob(canvas, mime, quality) {
        const q = typeof quality === 'number' ? quality : undefined;
        if (typeof canvas.toBlob === 'function') {
            const direct = await new Promise(function (resolve) { canvas.toBlob(resolve, mime, q); });
            if (direct) return direct;
            if (mime && mime !== 'image/png') {
                const fallback = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
                if (fallback) return fallback;
            }
        }
        const dataUrl = canvas.toDataURL(mime || 'image/png');
        const comma = dataUrl.indexOf(',');
        const binary = atob(comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return new Blob([out], { type: mime || 'image/png' });
    }

    function kmangaExtFor(type) {
        const t = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
        if (t === 'image/png') return 'png';
        if (t === 'image/webp') return 'webp';
        if (t === 'image/jpeg' || t === 'image/jpg') return 'jpg';
        return null;
    }

    // Un-shuffle one scrambled page. `image` is the frame's own descriptor:
    // { key, width, height }, where width/height are the *declared* page box and
    // the JPEG on the wire is padded up to the cell grid.
    async function kmangaDescrambleJpeg(jpeg, image) {
        const decoded = await kmangaDecodeImage(jpeg, 'image/jpeg');
        try {
            const geometry = kmangaScrambleGeometry({
                declaredWidth: Number(image.declaredWidth),
                declaredHeight: Number(image.declaredHeight),
                sourceWidth: decoded.width,
                sourceHeight: decoded.height,
            });
            const block = geometry.block;
            const gridX = geometry.gridX;
            const order = kmangaScrambleOrder({ gridX: gridX, gridY: geometry.gridY, key: image.key });

            const outWidth = gridX * block;
            const outHeight = geometry.gridY * block;
            // drawImage clips at the canvas edge, which is exactly the CLI's
            // extract(0, 0, min(declared, out)) - so one canvas is enough.
            const width = Math.min(Number(image.declaredWidth), outWidth);
            const height = Math.min(Number(image.declaredHeight), outHeight);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('k-manga descramble needs a 2D canvas context');

            for (let t = 0; t < order.length; t++) {
                const from = order[t];
                const sourceX = (from % gridX) * geometry.cell + 1;
                const sourceY = Math.floor(from / gridX) * geometry.cell + 1;
                const targetX = (t % gridX) * block;
                const targetY = Math.floor(t / gridX) * block;
                ctx.drawImage(decoded.element, sourceX, sourceY, block, block, targetX, targetY, block, block);
            }
            const blob = await kmangaCanvasToBlob(canvas, IMAGE_CODEC.type, IMAGE_CODEC.quality);
            if (!blob) throw new Error('k-manga descramble produced no image');
            return { blob: blob, ext: kmangaExtFor(blob.type) };
        } finally {
            try { decoded.cleanup(); } catch (e) {}
        }
    }

    async function kmangaPageBlob(frame, entry) {
        const scenes = frame.body && frame.body.scenes;
        if (!Array.isArray(scenes) || !scenes.length) {
            throw new Error('k-manga page ' + entry.name + ' carried no scene');
        }
        const scene = scenes[0];
        const images = scene.images || [];
        if ((scene.sceneImagePartition || 1) > 1 || images.length > 1) {
            throw new Error('k-manga page ' + entry.name + ' is a composite scene (partition '
                + scene.sceneImagePartition + ', ' + images.length + ' image(s)), which is not supported');
        }
        const image = images[0];
        if (!image || !frame.chunks || !frame.chunks.length) {
            throw new Error('k-manga page ' + entry.name + ' carried no image data');
        }
        if (image.format !== 'jpeg') {
            throw new Error('k-manga page ' + entry.name + ' is ' + image.format + ', which is not implemented');
        }
        const jpeg = frame.chunks[0];
        if (!kmangaReadJpegSize(jpeg)) throw new Error('k-manga page ' + entry.name + ' is not a readable JPEG');
        // The viewer skips the whole shuffle at key 0, and re-encoding a page it
        // already serves whole would only add a generation of loss.
        if (!kmangaIsScrambled(image)) {
            return { blob: new Blob([jpeg], { type: 'image/jpeg' }), ext: 'jpg' };
        }
        return kmangaDescrambleJpeg(jpeg, {
            key: Number(image.key),
            declaredWidth: Number(image.width),
            declaredHeight: Number(image.height),
        });
    }
