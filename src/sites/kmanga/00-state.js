    // k-manga serves a free/trial viewer at comic.k-manga.jp/viewer/pc/viewer.html.
    // Pages never travel over HTTP: the viewer opens a WebSocket to
    // ws.viewer.k-manga.jp and asks for each page by name, and every reply is a
    // BCP000 frame whose single chunk is a raw, block-scrambled JPEG. The page
    // list and the per-ticket decrypt key both come from the first frame the
    // socket sends after a header request.
    //
    // This is a browser port of the Node CLI dokuha-cli
    // (src/download/kmanga-protocol.js, kmanga-ws.js, kmanga.js). The framing,
    // the grid geometry, the LCG permutation and the JPEG walk are the same
    // arithmetic; the transport is not. The CLI hand-rolled the RFC6455
    // handshake over node:net/node:tls and set its own Origin header; the
    // browser's WebSocket performs that handshake itself, sets Origin to this
    // page's origin (https://comic.k-manga.jp, exactly the value the CLI sent)
    // and hands us message payloads to feed to kmangaParseFrame.
    //
    const KM_ORIGIN = 'https://comic.k-manga.jp';
    const KM_READ_TIMEOUT_MS = 30000;
    // The store paces a single connection rather than the requests on it, so a
    // long volume spreads its pages over a few sockets; four is where the CLI's
    // measured curve flattened (468 ms/page on one, 192 ms on four).
    const KM_MAX_SOCKETS = 4;
    const KM_PAGES_PER_SOCKET = 32;
    const KM_DEFAULT_DEPTH = 8;
    const KM_MAX_DEPTH = 32;
    const KM_PROCESS_LIMIT = 4;
    const KM_MAX_ATTEMPTS = 6;

    const kmangaState = {
        running: false,
        bookId: null,
        volume: null,
        title: null,
        rawTitle: null,
        session: null,
        // The /viewer-launcher/ URL a title page's offer points at. The viewer
        // itself is one redirect behind it, so the browser follows it once.
        launcher: null,
        total: 0,
        resolution: '',
        ready: false,
        error: null,
    };

    function kmangaLog() {
        if (!BWDD_DEBUG) return;
        try { console.log.apply(console, ['[bwdd/kmanga]'].concat([].slice.call(arguments))); } catch (e) {}
    }
