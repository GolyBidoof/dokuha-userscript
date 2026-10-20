
    // Headless automation is deliberately a page-level opt-in.  Keeping the
    // check in one helper means the normal panel path never has to know about
    // it, while a Puppeteer caller can inject the flag before the script runs.
    // The realm the debug surface is published on. A @grant-ed userscript runs in
    // Tampermonkey's sandbox, where `window` is the sandbox's own object and not
    // the page's: assigning __bwdd to it leaves the page console reading
    // undefined, which is exactly how ?bwddDebug failed on ebookjapan while the
    // same code passed every in-page test. unsafeWindow (granted in the header) is
    // the page's window; fall back to `window` where it is absent, as in the CLI.
    function debugRealm() {
        try {
            return (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
        } catch (e) { return window; }
    }

    function isHeadlessPage() {
        try {
            return window.__BWDD_HEADLESS__ === true || !!window.__BWDD_CLI__;
        } catch (e) { return false; }
    }

    // Error messages from fetch failures can echo a request URL. Keep signed CDN
    // query parameters and URL credentials out of page logs even in headed mode;
    // this is deliberately independent of the CLI's queue sanitization.
    function safeLogText(value) {
        let text = String(value == null ? '' : value);
        text = text.replace(/https?:\/\/[^\s"'<>]+/gi, match => {
            try {
                const url = new URL(match);
                if (url.username || url.password) return '[redacted-url]';
                url.search = '';
                url.hash = '';
                return url.toString();
            } catch (_) {
                return '[redacted-url]';
            }
        });
        text = text.replace(
            /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|password|passwd|client-secret|client_secret)\s*([:=])\s*[^\r\n,}]*/gi,
            '$1$2[redacted]'
        );
        return text.replace(
            /\b(auth[_-]?info|policy|signature|key[-_]?pair[-_]?id|token|csrf|xsrf|api[_-]?key|apikey|password|passwd|secret|private[_-]?key|client[_-]?secret)\s*([:=])\s*("[^"]*"|[^\s,;}]+)/gi,
            '$1$2[redacted]'
        );
    }

