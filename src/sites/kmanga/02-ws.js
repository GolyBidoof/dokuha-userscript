    // dokuha-cli's kmanga-ws.js cannot be ported as-is: it imports node:net,
    // node:tls and node:crypto, opens a raw TCP/TLS socket and performs the
    // RFC6455 handshake, masking and unmasking, fragmentation and ping/pong by
    // hand. The browser's native WebSocket does all of that, so this file keeps
    // only the queue the pipeline actually consumes.
    //
    // Two CLI options have no browser equivalent and are deliberately absent:
    //
    //   * `Origin` - the CLI sent Origin: https://comic.k-manga.jp because the
    //     viewer page's own origin is comic.k-manga.jp, and the store expects
    //     it. Browsers refuse to let script set Origin; the browser sets it to
    //     this page's origin, which on a k-manga page is that same value, so the
    //     server should see exactly what the CLI sent. That is an assumption
    //     that only a live connection can confirm.
    //   * `User-Agent` - likewise a forbidden header; the browser sends its own.
    //
    // Cookies are not sent by script either: the browser attaches the cookie jar
    // for ws.viewer.k-manga.jp itself, which is why the CLI's manual jar is gone.
    function kmangaSocketFromWebSocket(ws, timeoutMs) {
        const queue = [];
        const waiters = [];
        let closed = false;
        let closeReason = null;

        function deliver(message) {
            const waiter = waiters.shift();
            if (waiter) { clearTimeout(waiter.timer); waiter.resolve(message); }
            else queue.push(message);
        }
        function shutdown(reason) {
            closed = true;
            closeReason = closeReason || reason;
            while (waiters.length) {
                const waiter = waiters.shift();
                clearTimeout(waiter.timer);
                waiter.reject(new Error(closeReason));
            }
        }

        ws.binaryType = 'arraybuffer';
        ws.onmessage = function (event) {
            const data = event && event.data;
            let payload;
            if (data instanceof ArrayBuffer) payload = new Uint8Array(data);
            else if (data && data.buffer instanceof ArrayBuffer) payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            else if (typeof data === 'string') payload = new TextEncoder().encode(data);
            else return;
            deliver({ opcode: 2, payload: payload });
        };
        ws.onerror = function () { shutdown('k-manga viewer socket errored'); };
        ws.onclose = function (event) {
            shutdown('k-manga viewer socket closed' + (event && event.code ? ' (' + event.code + ')' : ''));
        };

        return {
            send: function (text) {
                if (closed) throw new Error(closeReason || 'k-manga viewer socket is closed');
                ws.send(text);
            },
            // The next whole binary message, i.e. one BCP000 frame. The pipeline
            // matches it to a request by its scene number rather than by arrival
            // order, so a queue rather than a correlation id is enough.
            next: function (readTimeoutMs) {
                if (queue.length) return Promise.resolve(queue.shift());
                if (closed) return Promise.reject(new Error(closeReason || 'k-manga viewer socket is closed'));
                const ms = readTimeoutMs || timeoutMs || KM_READ_TIMEOUT_MS;
                return new Promise(function (resolve, reject) {
                    const waiter = { resolve: resolve, reject: reject, timer: null };
                    waiter.timer = setTimeout(function () {
                        const index = waiters.indexOf(waiter);
                        if (index >= 0) waiters.splice(index, 1);
                        reject(new Error('k-manga WebSocket read timed out after ' + ms + ' ms'));
                    }, ms);
                    waiters.push(waiter);
                });
            },
            close: function () {
                if (closed) return;
                closed = true;
                try { ws.close(); } catch (e) {}
            },
            get closed() { return closed; },
        };
    }

    function kmangaConnectSocket(url, options) {
        options = options || {};
        const handshakeMs = options.timeoutMs || 20000;
        return new Promise(function (resolve, reject) {
            let ws;
            try { ws = new WebSocket(url); } catch (e) { reject(new Error('k-manga WebSocket could not be opened: ' + ((e && e.message) || e))); return; }
            let settled = false;
            const timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                try { ws.close(); } catch (e) {}
                reject(new Error('k-manga WebSocket to ' + url + ' timed out after ' + handshakeMs + ' ms'));
            }, handshakeMs);
            ws.onopen = function () {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                // Replace the handshake handlers with the message queue. This is
                // why the greeting read below is a separate await: the queue must
                // own onmessage before the first frame can arrive.
                resolve(kmangaSocketFromWebSocket(ws, KM_READ_TIMEOUT_MS));
            };
            ws.onerror = function () {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error('k-manga WebSocket to ' + url + ' failed to open'));
            };
            ws.onclose = function () {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error('k-manga WebSocket to ' + url + ' closed before it opened'));
            };
        });
    }
