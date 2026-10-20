
    // Chromium clamps main-thread timers in a hidden tab to one tick per second
    // and, once the page has been hidden for five minutes, to roughly one per
    // minute (intensive wake-up throttling, Chrome 88+). Everything a run
    // *does* is driven by fetch completions, worker messages and the finalize
    // stream, none of which a hidden page clamps, but every value that has to
    // be *asked for* is polled with a timer. That is the shape of the problem
    // this file fixes: with the tab in the background the fetch and descramble
    // bars raced to 100% while the Mokuro bar, fed only by its /status poll, was
    // starved and crept forward (or froze for a minute at a time) even though
    // the run itself was not slowed down.
    //
    // A dedicated Worker's own timers are not clamped, and a message it posts
    // back is delivered to this thread as an ordinary task, so the interval is
    // scheduled there and each tick arrives on time. tests/test_ticker.js
    // measures it on a real hidden page: a 100 ms main-thread interval is cut to
    // well under one tick per second with gaps of ten seconds and up, while the
    // same interval through this relay keeps its full rate with sub-second gaps.
    //
    // Two properties matter to the callers. The handle is made by the same
    // setInterval/clearInterval idiom they already use, and it degrades instead
    // of throwing: a page CSP that forbids blob: workers (ebookjapan's does)
    // refuses the worker with an `error` event rather than an exception, so the
    // relay is only trusted once it has answered, and a plain interval covers
    // the gap until then and takes over for good if it never arrives.
    const TICKER_HELLO_MS = 1500;
    const tickerSource = [
        'const timers = new Map();',
        'onmessage = function (e) {',
        '    const d = e.data || {};',
        '    if (d.op === "start") {',
        '        const previous = timers.get(d.id);',
        '        if (previous !== undefined) clearInterval(previous);',
        '        timers.set(d.id, setInterval(function () { postMessage(d.id); }, d.ms));',
        '    } else if (d.op === "stop") {',
        '        const t = timers.get(d.id);',
        '        if (t !== undefined) clearInterval(t);',
        '        timers.delete(d.id);',
        '    }',
        '};',
        'postMessage("ready");',
    ].join('\n');

    const tickers = new Map();
    let tickerRelay = null;          // Worker while one is being tried, null before, false when unusable
    let tickerRelayReady = false;
    let tickerHelloTimer = null;
    let tickerSeq = 0;

    function tickerRun(rec) {
        if (rec.stopped) return;
        try { rec.fn(); } catch (e) {}
    }
    // The stopgap interval: used until the relay has proved it ticks, and
    // permanently on a page that cannot start one.
    function tickerFallback(rec) {
        if (rec.stopped || rec.fallbackId !== null) return;
        rec.fallbackId = setInterval(() => tickerRun(rec), rec.ms);
    }
    function tickerRelayFailed() {
        if (tickerHelloTimer) { clearTimeout(tickerHelloTimer); tickerHelloTimer = null; }
        if (tickerRelay) { try { tickerRelay.terminate(); } catch (e) {} }
        tickerRelay = false;
        tickerRelayReady = false;
        for (const rec of tickers.values()) tickerFallback(rec);
    }
    function ensureTickerRelay() {
        if (tickerRelay !== null) return tickerRelay;
        if (typeof Worker !== 'function' || typeof Blob !== 'function' ||
            typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
            tickerRelay = false;
            return false;
        }
        let worker = null;
        try {
            const url = URL.createObjectURL(new Blob([tickerSource], { type: 'text/javascript' }));
            try { worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
        } catch (e) {
            tickerRelay = false;
            return false;
        }
        worker.onmessage = (ev) => {
            if (typeof ev.data === 'string') {
                if (ev.data !== 'ready') return;
                tickerRelayReady = true;
                if (tickerHelloTimer) { clearTimeout(tickerHelloTimer); tickerHelloTimer = null; }
                // The relay is authoritative from here: drop the stopgaps.
                for (const rec of tickers.values()) {
                    if (rec.fallbackId !== null) { clearInterval(rec.fallbackId); rec.fallbackId = null; }
                }
                return;
            }
            const rec = tickers.get(ev.data);
            if (rec) tickerRun(rec);
        };
        // Fires for a refused blob worker (the CSP case) and for a worker that
        // dies later; either way the tickers move to the stopgap interval.
        worker.onerror = () => tickerRelayFailed();
        tickerRelay = worker;
        // A refused blob worker reports `error` asynchronously; the hello timer
        // is the backstop for an environment that never reports anything.
        tickerHelloTimer = setTimeout(() => { if (!tickerRelayReady) tickerRelayFailed(); }, TICKER_HELLO_MS);
        return worker;
    }
    function setBackgroundInterval(fn, ms) {
        if (typeof fn !== 'function') throw new TypeError('setBackgroundInterval needs a function');
        const delay = Math.max(16, Number(ms) || 0);
        const id = ++tickerSeq;
        const rec = { id, fn, ms: delay, fallbackId: null, stopped: false };
        tickers.set(id, rec);
        const relay = ensureTickerRelay();
        if (relay) {
            try { relay.postMessage({ op: 'start', id, ms: delay }); }
            catch (e) { tickerRelayFailed(); }
        }
        // Started up front rather than after the hello timeout so a page that
        // blocks the worker still polls at its old rate; the relay's "ready"
        // clears it long before its first fire in every case but a slow page.
        if (!tickerRelayReady) tickerFallback(rec);
        return id;
    }
    function clearBackgroundInterval(id) {
        const rec = tickers.get(id);
        if (!rec) return;
        rec.stopped = true;
        tickers.delete(id);
        if (rec.fallbackId !== null) { clearInterval(rec.fallbackId); rec.fallbackId = null; }
        // Sent even before the relay has answered: the worker's own script may
        // not have run yet, in which case the stop message is simply queued
        // behind the start it has to cancel.
        if (tickerRelay) {
            try { tickerRelay.postMessage({ op: 'stop', id }); } catch (e) {}
        }
    }
    // Promise twin of setBackgroundInterval for a one-shot wait (the bridge
    // start and idle gates poll in a loop and must keep their cadence too, or a
    // backgrounded run can report "the bridge is not running" about a bridge it
    // never actually asked twice).
    function backgroundDelay(ms) {
        return new Promise(resolve => {
            const id = setBackgroundInterval(() => { clearBackgroundInterval(id); resolve(); }, ms);
        });
    }
    // A macrotask yield that survives a hidden tab. setTimeout(0) is clamped to
    // a full second there (a minute under intensive throttling), so a 300-page
    // zip paid a second of dead time every 16 pages. A message task is
    // delivered immediately either way. The channel is per page and shared by
    // every waiter, which stays FIFO because each wait posts its own message.
    let taskYieldPorts = null;
    function yieldToTasks() {
        if (typeof MessageChannel !== 'function') return new Promise(r => setTimeout(r, 0));
        if (!taskYieldPorts) {
            const ports = { channel: new MessageChannel(), waiters: [] };
            taskYieldPorts = ports;
            ports.channel.port1.onmessage = () => {
                const next = ports.waiters.shift();
                if (next) next();
            };
        }
        return new Promise(resolve => {
            taskYieldPorts.waiters.push(resolve);
            taskYieldPorts.channel.port2.postMessage(0);
        });
    }
