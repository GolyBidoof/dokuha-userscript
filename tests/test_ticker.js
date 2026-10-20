// test_ticker.js — a progress poll must keep its cadence in a hidden tab.
//
// Chromium clamps a hidden page's main-thread timers to one tick per second and,
// once the page has been hidden for five minutes, to roughly one per minute
// (intensive wake-up throttling). Every bar this script drives from network,
// worker and stream events keeps running at full speed when the tab is
// backgrounded; the Mokuro bar is the only one whose value has to be *asked
// for*, so it was the one that got starved. `setBackgroundInterval` (core/14)
// schedules that interval inside a dedicated Worker, whose timers are not
// clamped, and forwards each tick as an ordinary task.
//
// This pins the mechanism on a real hidden page rather than describing it:
//   * the plain control interval collapses (the premise, measured here),
//   * the relay holds its rate and its gaps,
//   * clearBackgroundInterval really stops ticking,
//   * a page whose CSP forbids blob: workers still ticks, through the fallback.
//
// The intensive-throttling grace period is shortened to 10 s so a 25 s hidden
// window covers both throttle stages; without the flag the same test would need
// more than five minutes of wall clock to reach the second one.
'use strict';
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const http = require('http');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const HIDDEN_WINDOW_MS = 25000;
const STOP_AT_MS = 12000;
// A hidden page's timers are clamped to one tick per second before the
// intensive stage and to far less after it, so the control has to stay well
// under 2/s for the comparison to mean anything.
const RELAY_MIN_PER_SEC = 5;

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const appSrv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><body><div id="viewer"></div></body></html>');
});
// Same page, but with a policy that permits the injected inline script and
// refuses `new Worker(blob:...)`: ebookjapan serves exactly this shape (Mokuro
// polling must still work there, just on the throttled fallback).
const cspSrv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', "script-src 'self' 'unsafe-inline'");
    res.end('<!doctype html><html><body><div id="viewer"></div></body></html>');
});

(async () => {
    const appPort = await listen(appSrv);
    const cspPort = await listen(cspSrv);
    const uscript = loadUserscript();
    const results = [];
    const check = (name, pass, detail) => {
        results.push({ name, pass });
        console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  - ' + detail : ''));
    };
    const stats = (ts) => {
        if (!ts || ts.length < 2) return { n: (ts || []).length, span: 0, perSec: 0, maxGap: null };
        const span = (ts[ts.length - 1] - ts[0]) / 1000;
        let maxGap = 0;
        for (let i = 1; i < ts.length; i++) maxGap = Math.max(maxGap, ts[i] - ts[i - 1]);
        return { n: ts.length, span: +span.toFixed(2), perSec: +(ts.length / span).toFixed(2), maxGap: Math.round(maxGap) };
    };

    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true,
        // Puppeteer launches Chrome with --disable-background-timer-throttling
        // (and the occlusion/renderer equivalents) by default, which hides the
        // exact behaviour under test. Drop them so this page is throttled the
        // way a real Tampermonkey tab is.
        ignoreDefaultArgs: [
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
        ],
        args: [
            '--no-sandbox',
            '--disable-gpu',
            '--enable-features=IntensiveWakeUpThrottling:grace_period_seconds/10',
        ],
    });

    const pageErrors = [];
    try {
        const page = await browser.newPage();
        page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)));
        await page.goto('http://127.0.0.1:' + appPort + '/?bwddDebug=1');
        await page.addScriptTag({ content: uscript });
        await new Promise(r => setTimeout(r, 300));

        const ready = await page.evaluate(() => !!(window.__bwdd && window.__bwdd.setBackgroundInterval &&
            window.__bwdd.clearBackgroundInterval && window.__bwdd.yieldToTasks));
        check('the built userscript exposes the hidden-tab ticker', ready);
        if (!ready) throw new Error('ticker hooks missing; build the userscript first');

        await page.evaluate(() => {
            const t = window.__ticks = { plain: [], relay: [], slow: [], stopped: [], stoppedMark: 0 };
            setInterval(() => t.plain.push(performance.now()), 100);
            window.__stopId = window.__bwdd.setBackgroundInterval(() => t.stopped.push(performance.now()), 100);
            window.__bwdd.setBackgroundInterval(() => t.relay.push(performance.now()), 100);
            window.__bwdd.setBackgroundInterval(() => t.slow.push(performance.now()), 700);
        });

        // A second, visible tab is what makes the first one hidden.
        const other = await browser.newPage();
        await other.goto('http://127.0.0.1:' + cspPort + '/');
        await other.bringToFront();
        const hidden = await page.evaluate(() => document.visibilityState);
        check('the run page is really hidden', hidden === 'hidden', 'visibilityState=' + hidden);

        await new Promise(r => setTimeout(r, STOP_AT_MS));
        const before = await page.evaluate(() => {
            window.__ticks.stoppedMark = window.__ticks.stopped.length;
            window.__bwdd.clearBackgroundInterval(window.__stopId);
            return { stopped: window.__ticks.stopped.length, relay: window.__ticks.relay.length };
        });

        await new Promise(r => setTimeout(r, HIDDEN_WINDOW_MS - STOP_AT_MS));
        const after = await page.evaluate(() => {
            const t = window.__ticks;
            return { plain: t.plain, relay: t.relay, slow: t.slow, stopped: t.stopped, mark: t.stoppedMark, vis: document.visibilityState };
        });

        const plain = stats(after.plain);
        const relay = stats(after.relay);
        const slow = stats(after.slow);
        console.log('      control setInterval(100ms): ' + plain.n + ' ticks, ' + plain.perSec + '/s, max gap ' + plain.maxGap + 'ms');
        console.log('      relayed interval(100ms):    ' + relay.n + ' ticks, ' + relay.perSec + '/s, max gap ' + relay.maxGap + 'ms');
        console.log('      relayed interval(700ms):    ' + slow.n + ' ticks, ' + slow.perSec + '/s, max gap ' + slow.maxGap + 'ms');

        check('the page stayed hidden for the whole window', after.vis === 'hidden');
        // The premise: a hidden page's own timers are throttled here (at least
        // the unconditional clamp to one tick per second, and the intensive
        // stage as well when it engages). If a future Chromium stops doing that,
        // this test is no longer measuring anything and should say so rather
        // than pass green.
        check('the plain control interval is throttled (premise)',
            plain.perSec < 2 && plain.maxGap > 800,
            plain.perSec + '/s, max gap ' + plain.maxGap + 'ms');
        check('the relayed 100ms interval keeps its cadence',
            relay.perSec >= RELAY_MIN_PER_SEC && relay.maxGap !== null && relay.maxGap <= 2000,
            relay.perSec + '/s, max gap ' + relay.maxGap + 'ms');
        check('the relayed 700ms interval keeps the poll cadence used by the Mokuro bar',
            slow.perSec > 0.8 && slow.perSec < 2.2 && slow.maxGap !== null && slow.maxGap <= 1500,
            slow.perSec + '/s, max gap ' + slow.maxGap + 'ms');
        check('clearBackgroundInterval stops the ticker it returned',
            after.stopped.length - after.mark <= 1,
            (after.stopped.length - after.mark) + ' ticks after 13s of clear');
        check('the live relayed ticker kept ticking while the other was stopped',
            after.relay.length - before.relay >= 20,
            (after.relay.length - before.relay) + ' ticks in the last 13s');

        const cspErrors = [];
        const cspPage = await browser.newPage();
        cspPage.on('pageerror', e => cspErrors.push(String(e).slice(0, 200)));
        await cspPage.goto('http://127.0.0.1:' + cspPort + '/?bwddDebug=1');
        await cspPage.addScriptTag({ content: uscript });
        await new Promise(r => setTimeout(r, 300));
        const cspTicks = await cspPage.evaluate(async () => {
            const times = [];
            window.__bwdd.setBackgroundInterval(() => times.push(performance.now()), 200);
            await new Promise(r => setTimeout(r, 2500));
            return times.length;
        });
        check('a page whose CSP forbids blob: workers still ticks (fallback)',
            cspTicks >= 2, cspTicks + ' ticks at 200ms over 2.5s');
        check('the fallback path raises no page error', cspErrors.length === 0, cspErrors[0] || '');
        check('the relay path raises no page error', pageErrors.length === 0, pageErrors[0] || '');
    } catch (e) {
        check('ticker test ran to completion', false, String(e && e.message || e).slice(0, 200));
    } finally {
        await browser.close();
        appSrv.close();
        cspSrv.close();
    }

    const failed = results.filter(r => !r.pass).length;
    if (failed) {
        console.log('\n' + failed + ' FAILED');
        process.exit(1);
    }
    console.log('\nALL ' + results.length + ' CHECKS PASSED');
})().catch(e => {
    console.log('FATAL ' + (e && e.stack || e));
    process.exit(1);
});
