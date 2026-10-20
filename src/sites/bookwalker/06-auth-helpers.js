    function isPublicBootstrapPage() {
        try { return !!(window.__BWDD_CLI__ && window.__BWDD_CLI__.publicBootstrap); } catch (_) { return false; }
    }
    function isPublicFreeBootstrapPage() {
        try { return !!(window.__BWDD_CLI__ && window.__BWDD_CLI__.publicBootstrap &&
            window.__BWDD_CLI__.publicBootstrap.route === 'free'); } catch (_) { return false; }
    }
    function getU1() {
        if (isHeadlessPage() && !isPublicBootstrapPage()) return '';
        const m = document.cookie.match(/(?:^|;\s*)u1=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : '';
    }
    function generatedBid() {
        // The native viewer mints this value client-side and persists it under
        // localStorage['NFBR.Global/BrowserId']; the observed shape is
        // <epoch-ms><8 digits>NFBR and the server accepts a self-minted one
        // (verified against /trial-page/c with status 200). When the viewer
        // engine has not run yet, mint the same shape instead of refusing.
        if (!headlessBid) {
            headlessBid = (state.auth && state.auth.bid) ||
                (Date.now() + '' + Math.floor(Math.random() * 1e8) + 'NFBR');
        }
        return headlessBid;
    }
    function getBID() {
        if (isHeadlessPage() && !isPublicBootstrapPage()) return generatedBid();
        try { const v = localStorage.getItem('NFBR.Global/BrowserId'); if (v) return v; } catch (e) {}
        if (state.auth && state.auth.bid) return state.auth.bid;
        return generatedBid();
    }
    function authQuery(auth) {
        const p = new URLSearchParams();
        for (const k of AUTH_PARAM_KEYS) {
            if (auth[k] !== undefined && auth[k] !== null) p.set(k, auth[k]);
        }
        return p.toString();
    }

