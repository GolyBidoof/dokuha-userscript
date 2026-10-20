
    const state = {
        cid: (new URLSearchParams(location.search)).get('cid') || '',
        fileBases: {},
        auth: null,        // {hti, cfg, bid, uuid, pfCd, Policy, Signature, Key-Pair-Id}
        baseUrl: null,     // e.g. https://bw-bv-epubs.bookwalker.jp/3_product/<cid>/1/<pid>/
        cti: null,         // title
        configBody: null,  // encrypted configuration_pack.json text
        configFromUrl: null
    };
    function bookWalkerPageName(index, source, ext) {
        const path = String(source || '').split(/[?#]/, 1)[0];
        const base = path.slice(path.lastIndexOf('/') + 1);
        const stem = fsSafePath(base.replace(/\.(?:x?html?)$/i, ''));
        // Manifest-only naming stays independent of the viewer's reading position.
        // The ordinal distinguishes multiple images from the same source file.
        const prefix = String(index).padStart(4, '0');
        // A caller that encoded the page itself passes the extension the blob
        // actually has; everyone else follows the selected codec.
        const suffix = '.' + (ext || IMAGE_CODEC.ext);
        const encoder = new TextEncoder();
        const budget = 255 - encoder.encode(prefix + ' ' + suffix).length;
        let name = '';
        let bytes = 0;
        for (const char of stem) {
            const size = encoder.encode(char).length;
            if (bytes + size > budget) break;
            name += char;
            bytes += size;
        }
        return prefix + (name ? ' ' + name : '') + suffix;
    }

    // Headless auth refreshes must correlate like one browser session. Do not
    // mint a new BID on every retry/endpoint call, but never consult browser
    // storage in this mode.
    let headlessBid = null;

    // Shared protocol/presentation constants (single source of truth).
    const AUTH_PARAM_KEYS = ['hti', 'cfg', 'bid', 'uuid', 'pfCd', 'Policy', 'Signature', 'Key-Pair-Id'];
