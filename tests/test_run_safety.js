// test_run_safety.js — the two fixes that gated the 2.0.0 tag.
//
// 1. The shared run harness must hold the panel's run lock for the whole run.
//    Only BookWalker used to take it (22-run.js:16), so CMOA and ebookjapan
//    could start a second run over the same book while the first was fetching.
//    The harness already released it in cleanup(); the missing half was the
//    acquire, and both harness callers run cleanup() in a finally.
//
// 2. ebookjapan must resolve a volume once at a time. The boot poll and the run
//    timer both drive ebjResolvePages, which makes three network calls and
//    instantiates the wasm module, so it reliably outlives its own triggers.
//    Without a shared promise each caller opened its own open_book session and
//    built a second module to race over the same ebjState.
//
// Both are driven behaviourally: the shipped bytes are sliced out and executed,
// so this fails if the fix stops working, not merely if a name disappears.
'use strict';
const fs = require('fs');
const path = require('path');
const { US } = require('./_userscript');

let pass = 0;
const fails = [];
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label + (detail ? '  \u2014 ' + detail : '')); }
    else { fails.push(label); console.log('FAIL  ' + label + (detail ? '  \u2014 ' + detail : '')); }
}

// Slice a top-level function out of the artifact by brace matching, skipping
// strings, template literals and comments so a brace inside one cannot end the
// block early.
function sliceFunction(text, header) {
    const start = text.indexOf(header);
    if (start === -1) return null;
    let depth = 0;
    for (let i = text.indexOf('{', start); i < text.length; i++) {
        const c = text[i], d = text[i + 1];
        if (c === '/' && d === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
        if (c === '/' && d === '*') { const j = text.indexOf('*/', i + 2); i = j < 0 ? text.length : j + 1; continue; }
        if (c === '"' || c === "'" || c === '`') {
            const q = c; i++;
            while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i] === q) break; i++; }
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') { if (--depth === 0) return text.slice(start, i + 1); }
    }
    return null;
}

(async () => {
    const src = fs.readFileSync(US, 'utf8');

    const harnessSrc = sliceFunction(src, 'function createRunHarness(ui, mode, options, meta) {');
    check('the shared run harness is present in the shipped artifact', !!harnessSrc);

    if (harnessSrc) {
        const box = () => ({ style: {} });
        const stubs = ['setBar', 'clearPageCache', 'safeLogText', 'reportRunProgress'];
        const factory = new Function('performance', 'makeUploadBarUpdater', stubs.join(', '),
            harnessSrc + '\nreturn createRunHarness;');
        const create = ui => factory({ now: () => 0 }, () => () => {},
            ...stubs.map(() => () => {}))(ui, 'zip', {}, { total: 3 });

        const lockCalls = [];
        const uiFields = () => ({
            details: { textContent: '' }, barWrap: box(),
            barDownload: { wrap: box() }, barDescramble: { wrap: box() },
            barMokuro: box(), barUpload: box(),
        });

        const H = create(Object.assign(uiFields(), { setRunLock(busy) { lockCalls.push(busy); } }));
        check('creating a run harness takes the run lock',
            lockCalls.length === 1 && lockCalls[0] === true, JSON.stringify(lockCalls));

        await H.cleanup();
        check('cleanup releases the run lock',
            lockCalls.length === 2 && lockCalls[1] === false, JSON.stringify(lockCalls));

        await H.cleanup();
        check('cleanup is idempotent and does not release twice',
            lockCalls.length === 2, JSON.stringify(lockCalls));

        // The headless ui stub has setRunLock as a no-op, but a partial ui must
        // not throw: the acquire is behind a typeof guard.
        let threw = null;
        try { await create(uiFields()).cleanup(); } catch (e) { threw = e; }
        check('a ui without setRunLock is tolerated', !threw, threw ? threw.message : 'no throw');
    }

    const wrapperSrc = sliceFunction(src, 'async function ebjResolvePages(target, opts) {');
    check('ebookjapan resolves through a single-flight wrapper', !!wrapperSrc);
    check('its in-flight promise is declared at module scope',
        /let ebjResolveInflight = null;/.test(src));

    if (wrapperSrc) {
        const URL_A = 'https://ebookjapan.yahoo.co.jp/viewer/free/abc';
        const URL_B = 'https://ebookjapan.yahoo.co.jp/viewer/free/zzz';
        const gates = [];
        let attempts = 0;
        const once = () => { attempts++; return new Promise((res, rej) => gates.push({ res, rej })); };
        const factory = new Function('ebjResolvePagesOnce', 'location',
            'let ebjResolveInflight = null;\n' + wrapperSrc + '\nreturn ebjResolvePages;');
        const resolve = factory(once, { href: URL_A });

        const a = resolve(URL_A), b = resolve(URL_A);
        check('two concurrent resolves make one attempt', attempts === 1, 'attempts: ' + attempts);
        gates[0].res('pages');
        const [ra, rb] = await Promise.all([a, b]);
        check('both callers receive that one result', ra === 'pages' && rb === 'pages');

        const c = resolve(URL_A);
        check('a later resolve starts a fresh attempt', attempts === 2, 'attempts: ' + attempts);
        gates[1].res('pages2');
        await c;

        const d = resolve(URL_A), e = resolve(URL_B);
        check('different targets are not merged', attempts === 4, 'attempts: ' + attempts);
        gates[2].res('one'); gates[3].res('two');
        const [rd, re] = await Promise.all([d, e]);
        check('each caller gets its own result', rd === 'one' && re === 'two');

        const f = resolve(URL_A);
        check('a resolve after a settled pair is fresh', attempts === 5, 'attempts: ' + attempts);
        gates[4].rej(new Error('boom'));
        await f.catch(() => {});
        const g = resolve(URL_A);
        check('a rejected resolve does not wedge the memo', attempts === 6, 'attempts: ' + attempts);
        gates[5].res('recovered');
        check('and the retry returns normally', (await g) === 'recovered');
    }

    console.log('');
    if (fails.length) {
        fails.forEach(f => console.log('  failed: ' + f));
        console.log(fails.length + ' FAILED');
        process.exit(1);
    }
    console.log('ALL ' + pass + ' CHECKS PASSED');
})();
