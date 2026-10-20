#!/usr/bin/env node
/*
 *
 * GreasyFork's sync settings take a GitHub *raw* URL (its sync_type "webhook"),
 * which it re-fetches periodically and pulls when @version changes. That URL is
 * the whole per-script setup, so this prints the one thing you have to paste -
 * and reads it from targets.json, so a new store appears here by itself.
 *
 * Which entry gets which URL is NOT obvious: the file named
 * dokuha-userscript.user.js is the combined script, while the
 * BookWalker-only entry follows bookwalker-only.user.js. See RELEASING.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The release branch, not main: it holds only released builds, so a synced entry
// moves when a release is cut, and never because somebody pushed to main.
const BRANCH = process.env.BWDD_SYNC_BRANCH || 'release';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (!pkg.repository) {
    console.error('package.json needs a repository URL: it is the base for the sync URLs');
    process.exit(1);
}
const rawRoot = String(pkg.repository)
    .replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '')
    .replace('https://github.com/', 'https://raw.githubusercontent.com/') + '/' + BRANCH;

const version = (/return '([0-9]+\.[0-9]+\.[0-9]+)'/.exec(
    fs.readFileSync(path.join(ROOT, 'src/core/00-identity.js'), 'utf8')) || [])[1] || '?';

const targets = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/targets.json'), 'utf8'));
const rows = Object.entries(targets).map(([id, t]) => ({
    id, out: t.out, name: t.name, url: rawRoot + '/' + t.out,
}));
const wOut = Math.max(...rows.map(r => r.out.length));
const wName = Math.max(...rows.map(r => r.name.length));

console.log('GreasyFork sync sources  (sync_type "webhook", one per script entry)\n');
for (const r of rows) {
    console.log('  ' + r.out.padEnd(wOut) + '  ' + r.name.padEnd(wName) + '  ' + r.url);
}
console.log('\n  version now: ' + version +
    '   (GreasyFork pulls the file only when @version changes)');
console.log('  release notes to paste:  npm run notes -- v' + version);
console.log('\n  The combined script is dokuha-userscript.user.js.');
console.log('  The BookWalker-only entry follows bookwalker-only.user.js - see RELEASING.md.');
console.log('  The release branch does not exist until the first release, so these 404');
console.log('  until then - GreasyFork simply has nothing to pull, which is the safe default.');
