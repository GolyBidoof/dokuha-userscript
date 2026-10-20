    // Derived from the installed metadata, not a hardcoded copy: a pinned literal
    // silently goes stale across releases, so the panel reports an old version no
    // matter which build is actually running.
    const BWDD_VERSION = (() => {
        try {
            const v = (typeof GM_info !== 'undefined') && GM_info.script && GM_info.script.version;
            if (v) return v;
        } catch (e) { /* not in a userscript manager (e.g. injected in a test) */ }
        return '3.0.1';   // the single source of truth: build.mjs substitutes this into @version
    })();
    // Debug-only: internals on window.* are exposed only when the page URL
    // carries ?bwddDebug=1, so page scripts cannot reach mutable script state by
    // default. It lives in the shared core because the core itself logs through
    // it.
    const BWDD_DEBUG = (() => {
        try { return new URLSearchParams(location.search).has('bwddDebug'); } catch (e) { return false; }
    })();
    const BWDD_AUTHOR = 'GolyBidoof';
    const BWDD_SCRIPT_NAME = 'dokuha-userscript';
    const BWDD_REPO_URL = 'https://github.com/GolyBidoof/dokuha-userscript';
