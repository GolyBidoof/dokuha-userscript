    // /renderer/render answers with a POSIX tar, not JSON: one bundle per
    // window, holding page_data_*.json, manifest.json, metadata.json, toc.json,
    // location_map.json and the layout/glyph files this adapter ignores. The
    // viewer parses it with a dependency-free reader of its own, and so must we
    // — there is no way to ask for the pieces individually.
    //
    // Members are sliced by offset rather than copied, so walking a 25 KB
    // bundle with ten members costs nothing.

    const KINDLE_TAR_BLOCK = 512;

    function kindleTarString(bytes) {
        let end = bytes.length;
        for (let i = 0; i < bytes.length; i++) {
            if (bytes[i] === 0) { end = i; break; }
        }
        let out = '';
        for (let i = 0; i < end; i++) out += String.fromCharCode(bytes[i]);
        return out.replace(/\0+$/, '').trim();
    }

    // Octal, space- or NUL-padded. A size field that is not a number at all
    // means this is not a tar (an HTML error page, a truncated body), and the
    // caller needs to hear about that rather than continue on a garbage offset.
    function kindleTarSize(bytes) {
        const text = kindleTarString(bytes);
        if (!text) return 0;
        const n = parseInt(text, 8);
        return Number.isFinite(n) && n >= 0 ? n : NaN;
    }

    function kindleReadTar(buffer) {
        const all = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
        const files = new Map();
        let offset = 0;
        let longName = null;

        while (offset + KINDLE_TAR_BLOCK <= all.length) {
            const header = all.subarray(offset, offset + KINDLE_TAR_BLOCK);
            // A block of NULs is the end-of-archive marker, and a tar is padded
            // out to a whole number of blocks after it.
            let blank = true;
            for (let i = 0; i < KINDLE_TAR_BLOCK; i++) { if (header[i] !== 0) { blank = false; break; } }
            if (blank) break;

            const size = kindleTarSize(header.subarray(124, 136));
            if (!Number.isFinite(size)) {
                throw new Error('the render response is not a tar (bad size field at byte ' + offset + ')');
            }
            // NUL and '0' are both plain files; the viewer's writer emits '0'.
            const raw = header[156];
            const type = (raw === 0) ? '0' : String.fromCharCode(raw);
            const bodyStart = offset + KINDLE_TAR_BLOCK;
            const bodyEnd = bodyStart + size;
            if (bodyEnd > all.length) break;

            let name = kindleTarString(header.subarray(0, 100));
            // ustar splits long paths into prefix + name; GNU writes the name in
            // a preceding 'L' member. Neither appears in the bundles seen so
            // far, but a mis-named member would look like a missing page rather
            // than a parse bug, so both are handled.
            const prefix = kindleTarString(header.subarray(345, 500));
            if (prefix) name = prefix + '/' + name;
            if (longName !== null) { name = longName; longName = null; }

            if (type === 'L') {
                longName = kindleTarString(all.subarray(bodyStart, bodyEnd));
            } else if (type === '0') {
                files.set(String(name).replace(/^\.\//, ''), all.subarray(bodyStart, bodyEnd));
            }
            // 'x'/'g' (pax metadata), '5' (directory) and anything else carry no
            // payload this adapter uses.
            offset = bodyStart + Math.ceil(size / KINDLE_TAR_BLOCK) * KINDLE_TAR_BLOCK;
        }

        if (!files.size) throw new Error('the render response is not a tar (no members)');
        return files;
    }

    function kindleTarText(files, name) {
        const bytes = files.get(name);
        if (!bytes) return null;
        try { return new TextDecoder('utf-8').decode(bytes); } catch (e) {}
        let out = '';
        for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
        return out;
    }

    function kindleTarJson(files, name) {
        const text = kindleTarText(files, name);
        if (text == null) return null;
        try { return JSON.parse(text); } catch (e) {
            kindleLog('unreadable tar member', name, safeLogText(e && e.message));
            return null;
        }
    }

    // page_data_<lo>_<hi>.json, panels_*, layout_data_*, tokens_*. The bounds in
    // the filename are window-relative, so the name is only used to find the
    // member, never to number its pages.
    function kindleTarMemberNames(files, prefix) {
        const out = [];
        for (const name of files.keys()) {
            if (name.indexOf(prefix) === 0 && /\.json$/.test(name)) out.push(name);
        }
        return out.sort();
    }
