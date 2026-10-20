'use strict';
/*
 * Run one store target through the headless CLI (manga-dl) and read its pages
 * back off disk.
 *
 * The CLI is a second, independent implementation of the same store protocols:
 * it descrambles in Node with sharp rather than in a browser canvas. The live
 * acceptance run uses it as the reference the userscript is compared against,
 * which is what makes the descramble check meaningful without a golden image.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readZip } = require('./zipread.js');

const IMAGE_EXT = /\.(jpe?g|png|webp|avif)$/i;

function walk(dir, out = []) {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

/**
 * Download `url` into `outDir`.
 *
 * `--format original` asks for the source resolution the userscript also
 * defaults to, so the two page sets are comparable. A non-zero exit is
 * returned rather than thrown: the caller reports it as a store finding.
 */
function downloadWithCli(opts) {
    const { cliRoot, url, outDir, timeoutMs = 600000, log = () => {} } = opts;
    const bin = path.join(cliRoot, 'bin', 'manga-dl.mjs');
    if (!fs.existsSync(bin)) throw new Error(`no manga-dl CLI at ${bin}`);

    const args = [bin, url, '--out', outDir, '--json', '--no-progress', '--no-state', '--format', 'original'];
    log(`  cli: ${url}`);
    return new Promise((resolve) => {
        const child = spawn(process.execPath, args, { cwd: cliRoot, env: { ...process.env, NO_COLOR: '1' } });
        let stdout = '', stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.on('close', (code) => {
            clearTimeout(timer);
            let summary = null;
            const start = stdout.indexOf('{');
            if (start !== -1) { try { summary = JSON.parse(stdout.slice(start)); } catch (e) { /* keep null */ } }
            resolve({ code, summary, stdout, stderr: stderr.slice(-2000), timedOut: code === null });
        });
    });
}

/**
 * Read every page the CLI produced under `dir` as `{ path, data }`.
 *
 * BookWalker is written as an archive rather than loose files, so an archive is
 * opened and its image entries are used; the other two stores write pages
 * directly. Either way the result is sorted the same way so the caller can align
 * by page number.
 */
function readPages(dir) {
    if (!fs.existsSync(dir)) return [];
    const pages = [];
    for (const p of walk(dir)) {
        if (IMAGE_EXT.test(p)) {
            pages.push({ path: path.basename(p), full: p, data: fs.readFileSync(p) });
        } else if (/\.zip$/i.test(p)) {
            try {
                for (const e of readZip(fs.readFileSync(p))) {
                    if (IMAGE_EXT.test(e.name)) pages.push({ path: path.basename(e.name), full: p + '!' + e.name, data: e.data });
                }
            } catch (e) {
                // Leave the archive out rather than failing the whole store here;
                // the page count check reports the shortfall.
            }
        }
    }
    return pages.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

module.exports = { downloadWithCli, readPages };
