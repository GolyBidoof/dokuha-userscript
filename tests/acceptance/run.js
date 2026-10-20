'use strict';
/*
 * Live acceptance run: does each store still download, and are the pages
 * descrambled?
 *
 * This is NOT part of `npm test`. The default suite is hermetic and must stay
 * that way; this file talks to real storefronts, so it runs only when asked:
 *
 *   npm run test:acceptance                    # every store, userscript only
 *   npm run test:acceptance -- --cli ../manga-dl
 *   npm run test:acceptance -- --stores cmoa --keep
 *
 * For each store it:
 *   1. discovers a volume that is free right now (tests/acceptance/lib/discover.js)
 *   2. downloads it with the built userscript in headless Chrome
 *   3. optionally downloads the same volume with the headless CLI (manga-dl)
 *   4. checks the archive structurally
 *   5. compares the two implementations page by page, in pixels
 *
 * Step 5 is the descramble check. See lib/oracle.js for why the obvious
 * single-image heuristic was measured, rejected, and replaced by this.
 *
 * The downloads are thrown away unless --keep is passed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { discoverAll } = require('./lib/discover.js');
const { launch, downloadWithUserscript } = require('./lib/browser.js');
const { downloadWithCli, readPages } = require('./lib/cli.js');
const { compareFingerprintSets, fingerprint } = require('./lib/oracle.js');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
    const out = {
        stores: ['bookwalker', 'cmoa', 'ebookjapan'],
        cli: process.env.BWDD_CLI_ROOT || null,
        script: process.env.BWDD_US || 'dokuha-userscript.user.js',
        minPages: 3,
        settleMs: 7000,
        timeoutMs: 600000,
        minPsnr: 25,
        keep: false,
        json: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const val = () => argv[++i];
        if (a === '--stores') out.stores = val().split(',').map(s => s.trim()).filter(Boolean);
        else if (a === '--cli') out.cli = val();
        else if (a === '--script') out.script = val();
        else if (a === '--min-pages') out.minPages = Number(val());
        else if (a === '--settle') out.settleMs = Number(val());
        else if (a === '--timeout') out.timeoutMs = Number(val());
        else if (a === '--min-psnr') out.minPsnr = Number(val());
        else if (a === '--keep') out.keep = true;
        else if (a === '--json') out.json = val();
        else if (a === '--help' || a === '-h') { out.help = true; }
        else throw new Error(`unknown option ${a}`);
    }
    return out;
}

/** Structure of the userscript's run: enough to fail a broken fetch loudly. */
function checkUserscript(result, pages, minPages) {
    const value = (result && result.value) || {};
    const errors = Array.isArray(value.errors) ? value.errors : [];
    const entries = (pages && pages.entries) || [];
    const bad = entries.filter(e => !(e.width > 0 && e.height > 0 && e.size > 0));
    return [
        { n: 'run completed without throwing', pass: !!result && result.ok === true, d: (result && result.error) || value.status || '' },
        { n: 'the run reported success', pass: value.ok === true, d: `ok=${value.ok} status=${value.status || ''}` },
        { n: `at least ${minPages} pages`, pass: Number(value.pageCount) >= minPages, d: `pageCount=${value.pageCount} total=${value.total}` },
        { n: 'no page failed', pass: errors.length === 0, d: errors.length ? `${errors.length} e.g. ${errors[0]}` : 'no errors' },
        { n: 'every declared page is in the archive', pass: entries.length > 0 && entries.length === Number(value.pageCount), d: `${entries.length} entries vs pageCount ${value.pageCount}` },
        { n: 'every page decodes to a non-empty image', pass: entries.length > 0 && bad.length === 0, d: bad.length ? `${bad.length} bad, e.g. ${bad[0].name}` : `${entries.length} pages` },
    ];
}

function checkCli(cli, pages, minPages) {
    if (!cli) return [];
    const s = cli.summary || {};
    const results = Array.isArray(s.results) ? s.results : [];
    const failed = results.filter(r => r && r.ok === false).length;
    return [
        { n: 'cli exited 0', pass: cli.code === 0 && !cli.timedOut, d: cli.timedOut ? 'timed out' : `exit ${cli.code}` },
        { n: `cli produced at least ${minPages} pages`, pass: pages.length >= minPages, d: `${pages.length} page files` },
        { n: 'cli reported every volume ok', pass: results.length > 0 && failed === 0, d: `${results.length - failed}/${results.length} volumes ok` },
    ];
}

async function run() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('\n').slice(1).map(l => l.replace(/^ \* ?/, '')).join('\n'));
        return 0;
    }

    const scriptPath = path.resolve(ROOT, opts.script);
    if (!fs.existsSync(scriptPath)) throw new Error(`no built userscript at ${scriptPath} — run npm run build`);
    if (opts.cli && !fs.existsSync(path.join(opts.cli, 'bin', 'manga-dl.mjs'))) {
        throw new Error(`--cli ${opts.cli} has no bin/manga-dl.mjs`);
    }

    const started = new Date().toISOString();
    console.log(`acceptance run ${started}`);
    console.log(`  script: ${path.relative(ROOT, scriptPath)}`);
    console.log(`  cli:    ${opts.cli || '(not given — structure only, no descramble comparison)'}`);
    console.log(`  stores: ${opts.stores.join(', ')}\n`);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bwdd-acceptance-'));
    const targets = await discoverAll(opts.stores);
    const report = { started, script: path.relative(ROOT, scriptPath), cli: opts.cli || null, stores: {} };
    let browser = null;
    let failures = 0;
    const lines = [];

    try {
        browser = await launch();
        for (const store of opts.stores) {
            const target = targets[store];
            const record = { store, target: target || null, checks: [], outcome: 'unknown' };
            report.stores[store] = record;
            lines.push(`\n=== ${store} ===`);

            if (!target || target.error) {
                record.outcome = 'discovery';
                record.checks.push({ n: 'a free target was discovered', pass: false, d: (target && target.error) || 'discovery failed' });
                lines.push(`FAIL  discovery: ${(target && target.error) || 'no target'}`);
                if (target && target.detail) lines.push(`      ${JSON.stringify(target.detail).slice(0, 200)}`);
                failures++;
                continue;
            }
            lines.push(`target: ${target.title || target.cid || target.uuid || target.bookCd}${target.expiry ? ` (free until ${target.expiry})` : ''}`);
            lines.push(`        ${target.url}`);
            lines.push(`        via ${target.how || 'discovery'}`);

            const us = await downloadWithUserscript({
                browser, scriptPath, url: target.url,
                settleMs: opts.settleMs, timeoutMs: opts.timeoutMs,
                log: m => lines.push(m),
            });
            const usChecks = checkUserscript(us.result, us.pages, opts.minPages);
            record.userscript = {
                site: us.site,
                status: (us.result && us.result.value && us.result.value.status) || null,
                pageCount: (us.result && us.result.value && us.result.value.pageCount) || 0,
                total: (us.result && us.result.value && us.result.value.total) || 0,
                errors: (us.result && us.result.value && us.result.value.errors || []).slice(0, 5),
                archivedPages: (us.pages && us.pages.entries || []).length,
                consoleErrors: us.consoleErrors.slice(0, 5),
            };
            record.checks.push(...usChecks.map(c => ({ ...c, side: 'userscript' })));

            let cliPages = [];
            if (opts.cli) {
                const cliDir = path.join(tmp, `cli-${store}`);
                const cli = await downloadWithCli({
                    cliRoot: opts.cli, url: target.cliUrl || target.url, outDir: cliDir,
                    log: m => lines.push(m),
                });
                cliPages = readPages(cliDir);
                record.cli = { code: cli.code, timedOut: cli.timedOut, pages: cliPages.length, stderr: cli.stderr.slice(-400) };
                record.checks.push(...checkCli(cli, cliPages, opts.minPages).map(c => ({ ...c, side: 'cli' })));
            }

            if (opts.cli && us.pages && us.pages.entries && us.pages.entries.length && cliPages.length) {
                const left = us.pages.entries.map(e => ({
                    name: e.name,
                    fp: { data: Buffer.from(e.fp, 'base64'), width: 64, height: 64 },
                }));
                const right = [];
                for (const p of cliPages) {
                    right.push({ name: p.path, fp: await fingerprint(p.data) });
                }
                const cmp = compareFingerprintSets(left, right, { minPsnr: opts.minPsnr });
                record.comparison = { compared: cmp.compared, agreed: cmp.agreed, worst: cmp.worst, minPsnr: cmp.minPsnr };
                record.checks.push({
                    side: 'both',
                    n: 'the two implementations agree page by page',
                    pass: cmp.ok,
                    d: `${cmp.agreed}/${cmp.compared} pages >= ${cmp.minPsnr} dB` + (cmp.worst ? `, worst page ${cmp.worst.page} at ${cmp.worst.psnr}` : ', nothing overlapped'),
                });
            } else if (opts.cli) {
                record.checks.push({
                    side: 'both',
                    n: 'the two implementations agree page by page',
                    pass: false,
                    d: 'not comparable: one side produced no pages',
                });
            }

            const failed = record.checks.filter(c => !c.pass);
            record.outcome = failed.length ? 'failed' : 'passed';
            if (failed.length) failures++;
            lines.push('');
            for (const c of record.checks) {
                lines.push(`${c.pass ? 'PASS' : 'FAIL'}  [${c.side}] ${c.n}${c.d ? `  — ${c.d}` : ''}`);
            }
            if (record.userscript.consoleErrors.length) {
                lines.push(`      page errors: ${record.userscript.consoleErrors.join(' | ').slice(0, 300)}`);
            }
        }
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (!opts.keep) fs.rmSync(tmp, { recursive: true, force: true });
        else lines.push(`\nkept downloads in ${tmp}`);
    }

    report.finished = new Date().toISOString();
    report.failures = failures;
    const outPath = opts.json || path.join(ROOT, 'tests', 'acceptance_result.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    console.log(lines.join('\n'));
    console.log(`\n${opts.stores.length - failures}/${opts.stores.length} stores passed`);
    console.log(`report: ${path.relative(ROOT, outPath)}`);
    return failures ? 1 : 0;
}

run().then(code => process.exit(code)).catch(e => { console.error('FATAL', e); process.exit(1); });
