    // One CMOA page is a scrambled JPEG tile served by sbcGetImg.php; the URL
    // carries the volume id, page path, quality and a short-lived `p` token,
    // and the CDN answers 403 for any of them wrong. The retry ladder below
    // walks quality × token, so one bad token cannot fail a whole volume.
    function cmoaBuildImageUrl(descriptor, qualityOverride, tokenOverride) {
        if (!cmoaState.contentsServer) throw new Error('CMOA contents server is not available');
        if (!cmoaState.cid) throw new Error('CMOA content ID is not available');
        if (!descriptor || !descriptor.src) throw new Error('CMOA page source URL unavailable');
        let base = cmoaState.contentsServer;
        if (!base.endsWith('/')) base += '/';
        const url = new URL('sbcGetImg.php', base);
        url.searchParams.set('cid', cmoaState.cid);
        url.searchParams.set('src', descriptor.src);
        const quality = qualityOverride != null ? qualityOverride : (cmoaState.quality || CMOA_QUALITY_ORDER[0]);
        if (quality != null) url.searchParams.set('q', String(quality));
        const token = tokenOverride != null ? tokenOverride : cmoaState.token;
        if (token) url.searchParams.set('p', token);
        if (cmoaState.viewMode != null) url.searchParams.set('vm', cmoaState.viewMode);
        if (cmoaState.dmytime) url.searchParams.set('dmytime', cmoaState.dmytime);
        if (cmoaState.u0 != null) url.searchParams.set('u0', cmoaState.u0);
        if (cmoaState.u1 != null) url.searchParams.set('u1', cmoaState.u1);
        Object.keys(cmoaState.extraParams).forEach(key => {
            const value = cmoaState.extraParams[key];
            if (value == null || value === '') return;
            const lower = key.toLowerCase();
            if (['cid', 'src', 'p', 'vm', 'q', 'dmytime', 'u0', 'u1'].includes(lower)) return;
            url.searchParams.set(key, value);
        });
        return url.toString();
    }

    function cmoaContentType(headerString) {
        if (!headerString || typeof headerString !== 'string') return null;
        for (const line of headerString.split(/\r?\n/)) {
            const i = line.indexOf(':');
            if (i === -1) continue;
            if (line.slice(0, i).trim().toLowerCase() === 'content-type') {
                return line.slice(i + 1).trim() || null;
            }
        }
        return null;
    }

    // The image CDN is cross-origin, so a plain page fetch is CORS-blocked.
    // Real parallelism comes from the shared transport lanes: the gm lane plus
    // every local fetch-proxy port the bridge advertises, each its own
    // HTTP/1.1 origin, so the 6-connections-per-origin limit stops being the
    // ceiling. Hence laneFetch() rather than GM_xmlhttpRequest (one lane).
    async function cmoaFetchViaLanes(url, signal) {
        await waitOutCooldown();
        const t0 = performance.now();
        // Opt in only when the bridge is willing to fetch this CDN: the fetch
        // proxy is not transparent - it forwards to the host named in
        // x-bwdd-upstream and refuses the rest - so a port configured for
        // another store would answer a CMOA path from the wrong CDN. A generic
        // bridge allows every port; one hardcoded to BookWalker allows none.
        const allowProxy = proxyCanServe(hostOf(url));
        const res = await laneFetch(url, 45000, { allowProxy: allowProxy, signal: signal });
        if (!res || !res.ok) {
            const e = new Error('HTTP ' + (res ? res.status : '0'));
            e.status = res ? res.status : 0;
            throw e;
        }
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        recordLane(res._lane, performance.now() - t0, bytes.byteLength);
        const type = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || 'image/jpeg';
        return { bytes, type };
    }

    // Fallback for environments with no gm lane (no GM_xmlhttpRequest exposed,
    // or no grant); a plain same-context fetch is the last resort.
    async function cmoaFetchBinary(url, signal) {
        const referer = location.href;
        const viaGM = () => new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('GM_xmlhttpRequest unavailable')); return; }
            let settled = false;
            const finish = fn => { if (!settled) { settled = true; fn(); } };
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: 45000,
                    responseType: 'arraybuffer',
                    headers: { 'Referer': referer, 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
                    onload: r => finish(() => {
                        if (r.status >= 200 && r.status < 300) {
                            const bytes = new Uint8Array(r.response || []);
                            resolve({ bytes, type: cmoaContentType(r.responseHeaders) || 'image/jpeg' });
                        } else {
                            const e = new Error('HTTP ' + r.status);
                            e.status = r.status;
                            reject(e);
                        }
                    }),
                    onerror: () => finish(() => reject(new Error('GM_xhr failed'))),
                    ontimeout: () => finish(() => reject(new Error('GM_xhr timeout'))),
                    onabort: () => finish(() => reject(new Error('GM_xhr aborted'))),
                });
            } catch (e) { finish(() => reject(e)); }
        });
        try {
            return await cmoaFetchViaLanes(url, signal);
        } catch (laneError) {
            // A real HTTP answer (403/404/...) is meaningful and repeating the
            // identical request on another lane just wastes a round trip; only a
            // transport failure (status 0 / no response) is worth another lane.
            if (laneError && laneError.status) throw laneError;
            cmoaLog('lane transport failed, falling back', safeLogText(laneError && laneError.message));
        }
        try {
            return await viaGM();
        } catch (gmError) {
            if (typeof GM_xmlhttpRequest === 'function' && !/unavailable/.test(gmError && gmError.message || '')) throw gmError;
            // The CDN URL is self-signed (cid + src + p), so it needs no
            // cookies; sending them would also make this request fail CORS
            // preflight, since a credentialed request cannot use a wildcard
            // Access-Control-Allow-Origin.
            const res = await fetchWithTimeout(url, { credentials: 'omit', referer: referer, signal: signal }, 45000);
            if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
            const buf = await res.arrayBuffer();
            return { bytes: new Uint8Array(buf), type: res.headers.get('content-type') || 'image/jpeg' };
        }
    }

    async function cmoaDecodeImage(bytes, mimeType) {
        const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        const blobType = (typeof mimeType === 'string' && mimeType !== 'application/octet-stream') ? mimeType : undefined;
        const blob = new Blob([buffer], { type: blobType });
        if (typeof createImageBitmap === 'function') {
            try {
                const bmp = await createImageBitmap(blob);
                return {
                    element: bmp, width: bmp.width, height: bmp.height,
                    cleanup: () => { try { if (bmp.close) bmp.close(); } catch (e) {} },
                };
            } catch (e) { /* fall through to an <img> decode */ }
        }
        return new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(blob);
            const img = new Image();
            img.decoding = 'async';
            img.onload = () => resolve({
                element: img,
                width: img.naturalWidth || img.width,
                height: img.naturalHeight || img.height,
                cleanup: () => { try { URL.revokeObjectURL(objectUrl); img.src = ''; } catch (e) {} },
            });
            img.onerror = e => { try { URL.revokeObjectURL(objectUrl); } catch (_) {} reject(e || new Error('image decode failed')); };
            img.src = objectUrl;
        });
    }

    // Re-encode through a canvas. This is where the correct output codec is
    // applied (and, for a lossless selection, where PNG/WebP is chosen).
    async function cmoaCanvasToBlob(canvas, mime, quality) {
        const q = typeof quality === 'number' ? quality : undefined;
        if (typeof canvas.toBlob === 'function') {
            const direct = await new Promise(resolve => canvas.toBlob(resolve, mime, q));
            if (direct) return direct;
            if (mime && mime !== 'image/png') {
                const fallback = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
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

    function cmoaExtFor(type) {
        const t = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
        if (t === 'image/png') return 'png';
        if (t === 'image/webp') return 'webp';
        if (t === 'image/jpeg' || t === 'image/jpg') return 'jpg';
        return null;
    }

    // The frame header carries the page size, and the scramble answer depends only
    // on that size, never on the pixels. Reading it here is what lets a page the
    // CDN already serves assembled skip a full JPEG decode.
    function cmoaReadJpegSize(bytes) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
        let pos = 2;
        while (pos + 9 < data.length) {
            if (data[pos] !== 0xff) { pos++; continue; }
            const marker = data[pos + 1];
            if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { pos += 2; continue; }
            const length = (data[pos + 2] << 8) | data[pos + 3];
            // SOF0-SOF15, except the four markers in that range that are not frame headers.
            const isFrame = marker >= 0xc0 && marker <= 0xcf &&
                marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isFrame) {
                const height = (data[pos + 5] << 8) | data[pos + 6];
                const width = (data[pos + 7] << 8) | data[pos + 8];
                return (width > 0 && height > 0) ? { width: width, height: height } : null;
            }
            if (length < 2) return null;
            pos += 2 + length;
        }
        return null;
    }

    function cmoaIsJpegType(type) {
        const t = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
        return t === 'image/jpeg' || t === 'image/jpg';
    }

    // Does this page need any pixels moved? A property of the geometry and the
    // volume's reader or tables, not of the decoded image, so it can be asked from
    // the frame header alone. Any refusal here only means the slow path should
    // speak for itself, so it is swallowed rather than reported.
    function cmoaNeedsNoWork(descriptor, width, height) {
        try {
            const reader = cmoaState.reader || cmoaGetReader();
            if (reader && typeof reader.getImageDescrambleCoords === 'function') {
                const plan = reader.getImageDescrambleCoords(descriptor.image || descriptor, width, height);
                return !plan || !plan.transfers;
            }
            const picked = cmoaSelectScramble(descriptor.src, cmoaState.scrambleTables);
            if (!picked) return false;
            const plan = cmoaScramblePlan(picked.coordTable, picked.pieceTable, width, height);
            return !plan || !plan.transfers;
        } catch (e) {
            return false;
        }
    }

    // The viewer's plan, flattened into plain rectangles. Keeping the
    // interpretation here (rather than in the worker) means the worker only ever
    // draws what it is handed, and the inline and worker paths cannot disagree
    // about geometry.
    function cmoaBlitPlan(plan) {
        const out = [];
        if (!plan || !Array.isArray(plan.transfers) || !plan.transfers.length) return out;
        plan.transfers.forEach(transfer => {
            if (!transfer || (typeof transfer.index === 'number' && transfer.index !== 0)) return;
            const coords = Array.isArray(transfer.coords) ? transfer.coords : [];
            coords.forEach(piece => {
                if (!piece) return;
                const w = piece.width || 0, h = piece.height || 0;
                if (w <= 0 || h <= 0) return;
                out.push({
                    sx: piece.xsrc || 0, sy: piece.ysrc || 0,
                    dx: piece.xdest || 0, dy: piece.ydest || 0,
                    w: w, h: h,
                });
            });
        });
        return out;
    }

    /**
     * Decode one page and work out its geometry.
     *
     * Returns null when the page cannot be descrambled at all, in which case the
     * caller keeps the CDN's own bytes. `bitmap` is non-null only when the decode
     * produced something that can be *moved* to a worker; the `<img>` fallback
     * path cannot, so that page stays on this thread.
     */
    // A page this run cannot descramble must never be written out: the bytes on
    // the wire are scrambled tiles, so "keeping the CDN's own bytes" produces an
    // archive of unreadable images that still looks like a success. These throw
    // with `fatal`, so the ladder reports the real reason instead of spending
    // every remaining rung and token on a page whose fetch already worked.
    function cmoaDescrambleError(index, why, cause) {
        const err = new Error('Cannot descramble page ' + (index + 1) + ': ' + why +
            '. CMOA pages are scrambled, so it is not being saved rather than saved unreadable.');
        err.fatal = true;
        if (cause) err.cause = cause;
        return err;
    }

    async function cmoaPreparePage(descriptor, payload) {
        const reader = cmoaState.reader || cmoaGetReader();
        const hasReader = !!(reader && typeof reader.getImageDescrambleCoords === 'function');
        if (!descriptor) throw cmoaDescrambleError(0, 'the page descriptor is missing');
        if (!hasReader && !cmoaState.scrambleTables) {
            console.warn('[bwdd/cmoa] nothing can descramble this frame: no reader and no scramble ' +
                'tables on ' + location.href + ' (viewer=' + !!cmoaState.viewer + ')');
            throw cmoaDescrambleError(descriptor.index,
                'neither the volume\u2019s reader nor its scramble tables are available on ' + location.href);
        }
        // A page the CDN already serves assembled is the common case. The answer
        // depends only on the geometry, so ask for it from the frame header and
        // hand the original bytes straight through: decoding and re-encoding a page
        // that does not move costs a full JPEG decode and a second generation of
        // loss for nothing. Gated on a JPEG payload *and* a JPEG image setting --
        // any other format setting means a re-encode was asked for.
        if (IMAGE_CODEC.type === 'image/jpeg' && cmoaIsJpegType(payload.type)) {
            const header = cmoaReadJpegSize(payload.bytes);
            if (header && cmoaNeedsNoWork(descriptor, header.width, header.height)) {
                cmoaReassembly.passthrough++;
                cmoaLog('page ' + (descriptor.index + 1) + ' needs no reassembly; kept as delivered');
                return { keepOriginal: true, close: function () {} };
            }
        }
        let decoded = null;
        try {
            decoded = await cmoaDecodeImage(payload.bytes, payload.type);
        } catch (e) {
            throw cmoaDescrambleError(descriptor.index, 'the image could not be decoded', e);
        }
        if (!decoded || !decoded.element || !decoded.width || !decoded.height) {
            if (decoded && decoded.cleanup) decoded.cleanup();
            throw cmoaDescrambleError(descriptor.index, 'the image decoded to nothing');
        }
        let plan = null;
        if (hasReader) {
            try {
                // The viewer's own page descriptor is what it expects, but a viewer
                // build that only exposes the parsed entry still knows the geometry,
                // and passing the entry beats refusing to try.
                plan = reader.getImageDescrambleCoords(descriptor.image || descriptor, decoded.width, decoded.height);
            } catch (e) {
                if (decoded.cleanup) decoded.cleanup();
                throw cmoaDescrambleError(descriptor.index, 'the reader refused the page geometry', e);
            }
        } else {
            // No viewer, so the geometry comes from the volume's own scramble
            // tables: the same answer the reader would have given, computed from
            // data already in hand. This is what makes a viewerless frame (a
            // series worker) a full downloader rather than a fetch-only one.
            const picked = cmoaSelectScramble(descriptor.src, cmoaState.scrambleTables);
            if (!picked) {
                if (decoded.cleanup) decoded.cleanup();
                throw cmoaDescrambleError(descriptor.index,
                    'the volume\u2019s scramble tables do not cover this page');
            }
            try {
                plan = cmoaScramblePlan(picked.coordTable, picked.pieceTable, decoded.width, decoded.height);
            } catch (e) {
                if (decoded.cleanup) decoded.cleanup();
                throw cmoaDescrambleError(descriptor.index, 'the scramble tables were rejected', e);
            }
            if (plan.kind === 'none') {
                cmoaLog('page ' + (descriptor.index + 1) + ' is served whole (no scramble tables for it)');
            }
        }
        if (!plan || !plan.transfers) {
            // A reader that answers without a plan is saying the page is whole.
            console.warn('[bwdd/cmoa] the reader returned no scramble plan for page ' +
                (descriptor.index + 1) + '; keeping the image as delivered');
        }
        return {
            element: decoded.element,
            // Only an ImageBitmap can cross the worker boundary; an HTMLImageElement
            // is not transferable, so those pages are reassembled inline.
            bitmap: (typeof ImageBitmap !== 'undefined' && decoded.element instanceof ImageBitmap)
                ? decoded.element : null,
            blits: cmoaBlitPlan(plan),
            width: (plan && plan.width > 0) ? plan.width : decoded.width,
            height: (plan && plan.height > 0) ? plan.height : decoded.height,
            close: () => { try { if (decoded.cleanup) decoded.cleanup(); } catch (e) {} },
        };
    }

    /** Reassemble on this thread. The fallback, and what the worker path must match. */
    async function cmoaBlitInline(prepared) {
        const canvas = document.createElement('canvas');
        canvas.width = prepared.width;
        canvas.height = prepared.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2D context');
        // With no plan the page is already whole; the straight copy still
        // re-encodes, so the archive extension always matches the bytes.
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (prepared.blits.length) {
            for (const b of prepared.blits) {
                try {
                    ctx.drawImage(prepared.element, b.sx, b.sy, b.w, b.h, b.dx, b.dy, b.w, b.h);
                } catch (drawError) { /* keep the remaining pieces */ }
            }
        } else {
            ctx.drawImage(prepared.element, 0, 0);
        }
        const blob = await cmoaCanvasToBlob(canvas, IMAGE_CODEC.type, IMAGE_CODEC.quality);
        if (!blob) throw new Error('canvas encode produced nothing');
        return { blob, ext: cmoaExtFor(blob.type) };
    }

    function cmoaBlitInWorker(prepared, id) {
        return cmoaPoolSubmit({
            id: id,
            bitmap: prepared.bitmap,
            blits: prepared.blits,
            width: prepared.width,
            height: prepared.height,
            codec: { type: IMAGE_CODEC.type, quality: IMAGE_CODEC.quality },
            // Moved, not copied: the bitmap is already decoded, and cloning it
            // would cost about as much as decoding it a second time.
            transfer: [prepared.bitmap],
        }).then(res => ({ blob: res.blob, ext: cmoaExtFor(res.blob.type) }));
    }

    // Reassemble one scrambled page and re-encode it to the selected codec.
    // ext is set only when the original payload was kept as-is.
    async function cmoaProcessPage(descriptor, payload, id) {
        const passthrough = () => ({
            blob: new Blob([payload.bytes], { type: payload.type }),
            ext: cmoaExtFor(payload.type),
        });
        // Bound the number of pages holding a decoded frame, before decoding any
        // of them; the browser's worker pool is otherwise not what limits memory.
        await cmoaAcquireSlot();
        let prepared = null;
        try {
            prepared = await cmoaPreparePage(descriptor, payload);
            if (!prepared) return passthrough();
            if (prepared.keepOriginal) return passthrough();
            if (cmoaPool && prepared.bitmap) {
                try {
                    const out = await cmoaBlitInWorker(prepared, id);
                    cmoaReassembly.worker++;
                    return out;
                } catch (e) {
                    // A failed transfer detaches the bitmap, so the page has to be
                    // decoded again before falling back. Rare, and the bytes are
                    // still here, so nothing has to be re-fetched.
                    cmoaReassembly.fallback++;
                    cmoaLog('worker descramble failed, reassembling inline', safeLogText(e && e.message));
                    try { prepared.close(); } catch (e2) {}
                    prepared = await cmoaPreparePage(descriptor, payload);
                    if (!prepared) return passthrough();
                    if (prepared.keepOriginal) return passthrough();
                }
            }
            const inline = await cmoaBlitInline(prepared);
            cmoaReassembly.inline++;
            return inline;
        } catch (e) {
            // Falling back to the payload here is what turned "we cannot
            // descramble this" into a silently scrambled page: the raw bytes
            // *are* the image, just unreadable. A fatal reason has to reach the
            // caller so the page is reported missing instead of wrong.
            if (e && e.fatal) throw e;
            cmoaLog('descramble pipeline failed', safeLogText(e && e.message));
            return passthrough();
        } finally {
            if (prepared) { try { prepared.close(); } catch (e) {} }
            cmoaReleaseSlot();
        }
    }

    // Walk quality × token until a page comes back. A 403 means one of the two
    // is refused: blacklist the rung, and - only when a rung this run has
    // actually seen answer is refused too - evict the token, so a stale
    // credential degrades instead of failing the volume without a rung that was
    // merely never licensed dropping a perfectly good token.
    async function cmoaFetchPage(descriptor, index, signal) {
        const preferred = cmoaState.quality || CMOA_QUALITY_ORDER[0];
        const collectQualities = () => {
            const list = [];
            const push = q => {
                if (q == null) return;
                const s = String(q);
                if (list.includes(s)) return;
                if (cmoaState.qualityBlacklist.has(s)) return;
                list.push(s);
            };
            push(preferred);
            CMOA_QUALITY_ORDER.forEach(push);
            return list;
        };
        let qualities = collectQualities();
        // An empty ladder means an *earlier* page blacklisted every rung, and a
        // 403 is also what a throttle or a stale token looks like. Start again
        // from a clean slate rather than fail this page without ever attempting
        // it - that is what produced a bare, unhelpful "Failed to download
        // page 1" with no underlying reason attached.
        if (!qualities.length) {
            cmoaState.qualityBlacklist.clear();
            qualities = collectQualities();
        }
        if (!qualities.length) qualities = [String(preferred || '1')];

        const tokens = [];
        const pushToken = t => {
            if (!t) return;
            const s = String(t);
            if (!tokens.includes(s)) tokens.push(s);
        };
        pushToken(cmoaState.lastGoodToken);
        pushToken(cmoaState.token);
        cmoaState.tokenPool.forEach(pushToken);
        if (!tokens.length) tokens.push(null);

        let lastError = null;
        for (const token of tokens) {
            // Two different things produce a 403 and they need opposite
            // responses. A rung the volume does not license (the original
            // rendition on a free or trial volume) is a rung problem, so it is
            // blacklisted. A rung this run has already seen answer is not: for
            // that one the credential is the thing that went stale, and only
            // then is evicting the token the right move.
            let trustedRefusal = false;
            for (const quality of qualities) {
                if (cmoaState.qualityBlacklist.has(String(quality))) continue;
                try {
                    const url = cmoaBuildImageUrl(descriptor, quality, token);
                    cmoaLog('fetching page', index, 'quality', quality, 'token', token);
                    const tFetch = performance.now();
                    const payload = await cmoaFetchBinary(url, signal);
                    const fetchMs = performance.now() - tFetch;
                    if (quality !== cmoaState.quality) cmoaState.quality = quality;
                    if (token) cmoaRememberToken(token, { markGood: true, force: true });
                    cmoaState.qualityBlacklist.delete(String(quality));
                    cmoaState.winningRungs.add(String(quality));
                    const tProc = performance.now();
                    const processed = await cmoaProcessPage(descriptor, payload, descriptor.index);
                    if (BWDD_DEBUG) {
                        cmoaLog('page timing', index, {
                            fetchMs: Math.round(fetchMs),
                            processMs: Math.round(performance.now() - tProc),
                            bytes: payload.bytes ? payload.bytes.length : 0,
                            quality: quality,
                        });
                    }
                    return processed;
                } catch (e) {
                    // The fetch worked and the page is already in hand, so no
                    // other rung or token can change the outcome.
                    if (e && e.fatal) throw e;
                    lastError = e || new Error('fetch failed');
                    const text = safeLogText((e && e.message) || e);
                    const status = Number(e && e.status) || 0;
                    cmoaLog('page fetch failed', index, 'quality', quality, text);
                    // 429/5xx is the CDN being busy, not this rendition being
                    // unlicensed. Blaming the rung for it blacklists a rung that
                    // is fine for every later page, so back off a touch and keep
                    // the ladder intact.
                    if (status === 429 || status === 503 || (status >= 500 && status < 600)) {
                        await new Promise(r => setTimeout(r, 120 + Math.round(Math.random() * 280)));
                        continue;
                    }
                    if (status === 403 || /(^|\D)403(\D|$)/.test(text)) {
                        if (cmoaState.winningRungs.has(String(quality))) trustedRefusal = true;
                        cmoaState.qualityBlacklist.add(String(quality));
                    }
                }
            }
            if (token && trustedRefusal) cmoaEvictToken(token);
        }
        if (lastError) throw lastError;
        throw new Error('Failed to download page ' + (index + 1) + ' \u2014 every image quality (' +
            CMOA_QUALITY_ORDER.join('/') + ') was refused for this volume.');
    }

    /**
     * Learn this volume's working quality rung without emitting a page.
     *
     * Only reached when page 1 came out of the page cache: the run still needs
     * the rung for every *other* page but has no use for those bytes. It is
     * deliberately the same ladder as cmoaFetchPage rather than a second
     * implementation of it, so a refused rung is still blacklisted and
     * cmoaState.quality still ends up on the rung that answered.
     */
    async function cmoaWarmQualityRung(descriptor) {
        try {
            const processed = await cmoaFetchPage(descriptor, 0);
            return !!(processed && processed.blob);
        } catch (e) {
            cmoaLog('rung warm failed', safeLogText(e && e.message));
            return false;
        }
    }
