    // A property of the archiver rather than of either store's reader, so the
    // core owns it.
    const JPEG_QUALITY = 0.92;
    //   localStorage.bwddImageFormat  = 'jpeg' | 'webp' | 'lossless' | 'png'
    //   localStorage.bwddImageQuality = 0.85      (0-1, lossy formats only)
    // The CDN already hands us a lossy JPEG, so re-encoding is a second
    // generation. Measured on a 1600x2400 manga page (bytes / encode ms):
    // jpeg 0.92 0.94 MB / 14 (default), jpeg 0.85 0.79 / 13, webp 0.92 0.75 / 180,
    // webp lossless 0.18 / 47 (bit-exact), png 0.69 / 15. On photo pages lossless
    // costs far more (webp lossless 3.4 MB / 592 ms), so it stays a choice rather
    // than a default. image/jxl and image/avif are not encodable here:
    // convertToBlob silently returns PNG for both.
    function resolveImageCodec() {
        let fmt = 'jpeg', quality = JPEG_QUALITY;
        try {
            const f = String((window.__bwddImageFormat != null
                ? window.__bwddImageFormat
                : (!isHeadlessPage() ? localStorage.getItem('bwddImageFormat') : '')) || '').toLowerCase();
            if (f === 'jpeg' || f === 'jpg' || f === 'webp' || f === 'png' || f === 'lossless') {
                fmt = (f === 'jpg') ? 'jpeg' : f;
            }
            const raw = window.__bwddImageQuality != null
                ? window.__bwddImageQuality
                : (!isHeadlessPage() ? localStorage.getItem('bwddImageQuality') : null);
            const qv = parseFloat(raw);
            if (isFinite(qv) && qv > 0 && qv <= 1) quality = qv;
        } catch (e) { /* opaque origin, or storage disabled, keep the defaults */ }
        // 'lossless' is WebP at quality 1, which is bit-exact; browsers without a
        // WebP encoder fall back to PNG, which is lossless too. Either way the
        // lossless setting really is lossless.
        if (fmt === 'lossless') return { fmt, type: 'image/webp', quality: 1, ext: 'webp', lossless: true };
        if (fmt === 'webp') return { fmt, type: 'image/webp', quality, ext: 'webp', lossless: false };
        if (fmt === 'png') return { fmt, type: 'image/png', quality, ext: 'png', lossless: true };
        return { fmt: 'jpeg', type: 'image/jpeg', quality, ext: 'jpg', lossless: false };
    }
    // The extension the encoded blob itself declares. A canvas may quietly hand
    // back PNG when asked for a type it cannot produce, so naming an archive
    // entry after the selected codec alone would label those bytes as WebP.
    function imageExtForMime(type) {
        const t = typeof type === 'string' ? type.split(';')[0].trim().toLowerCase() : '';
        if (t === 'image/png') return 'png';
        if (t === 'image/webp') return 'webp';
        if (t === 'image/jpeg' || t === 'image/jpg') return 'jpg';
        return '';
    }
    // Mutable: the panel changes it, and the next download must pick it up without
    // a page reload, so nothing may cache this at load time.
    let IMAGE_CODEC = resolveImageCodec();
    function refreshImageCodec() {
        IMAGE_CODEC = resolveImageCodec();
        return IMAGE_CODEC;
    }
