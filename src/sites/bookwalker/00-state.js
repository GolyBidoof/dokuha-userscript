
    const state = {
        cid: (new URLSearchParams(location.search)).get('cid') || '',
        fileBases: {},
        auth: null,        // {hti, cfg, bid, uuid, pfCd, Policy, Signature, Key-Pair-Id}
        baseUrl: null,     // e.g. https://bw-bv-epubs.bookwalker.jp/3_product/<cid>/1/<pid>/
        cti: null,         // title
        configBody: null,  // encrypted configuration_pack.json text
        configFromUrl: null
    };
    // Headless auth refreshes must correlate like one browser session. Do not
    // mint a new BID on every retry/endpoint call, but never consult browser
    // storage in this mode.
    let headlessBid = null;

    // Shared protocol/presentation constants (single source of truth).
    const AUTH_PARAM_KEYS = ['hti', 'cfg', 'bid', 'uuid', 'pfCd', 'Policy', 'Signature', 'Key-Pair-Id'];
