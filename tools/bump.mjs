#!/usr/bin/env node
/*
 * Version bump + regenerate.
 *
 * The version has exactly one source of truth: the BWDD_VERSION literal in
 * src/core/00-identity.js. build.mjs substitutes it into every artifact's
 * @version, so the manager keys updates off the same number the panel prints.
 * This script is the only thing that should write that literal; it also keeps
 * the two other places that name a version in step, then rebuilds every target.
 *
 *   node bump.mjs patch        1.6.4 -> 1.6.5
 *   node bump.mjs minor        1.6.4 -> 1.7.0
 *   node bump.mjs major        1.6.4 -> 2.0.0
 *   node bump.mjs 1.7.2        an explicit version
 *   node bump.mjs --dry-run patch
 *
 * CHANGELOG.md is deliberately not touched: its "## vX.Y.Z" headings are
 * history, and rewriting or stubbing them automatically would put words in your
 * mouth. The script prints the reminder instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IDENTITY = path.join(ROOT, 'src', 'core', '00-identity.js');
const README = path.join(ROOT, 'README.md');
const PKG = path.join(ROOT, 'package.json');
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function currentVersion() {
    const src = fs.readFileSync(IDENTITY, 'utf8');
    const m = src.match(/return '([0-9]+\.[0-9]+\.[0-9]+)';/);
    if (!m) throw new Error("no version literal in src/core/00-identity.js (expected: return 'x.y.z';)");
    return m[1];
}

function nextVersion(cur, how) {
    if (SEMVER.test(how)) return how;
    const [maj, min, pat] = cur.split('.').map(Number);
    if (how === 'major') return (maj + 1) + '.0.0';
    if (how === 'minor') return maj + '.' + (min + 1) + '.0';
    if (how === 'patch') return maj + '.' + min + '.' + (pat + 1);
    throw new Error('expected patch|minor|major or an explicit x.y.z, got: ' + JSON.stringify(how));
}

// One replacement, and it must actually land: a silently missed version
// reference is how package.json ended up three releases behind at 1.5.1.
function replaceIn(file, re, make, what) {
    const before = fs.readFileSync(file, 'utf8');
    const m = before.match(re);
    if (!m) throw new Error('could not find ' + what + ' in ' + path.relative(ROOT, file));
    const after = before.replace(re, make);
    if (after === before) throw new Error(what + ' did not change in ' + path.relative(ROOT, file));
    return { file, before, after, what };
}

function main() {
    const args = process.argv.slice(2);
    const dry = args.includes('--dry-run');
    const how = args.filter(a => !a.startsWith('--'))[0];
    if (!how) {
        console.error('usage: node bump.mjs <patch|minor|major|x.y.z> [--dry-run]');
        process.exit(2);
    }
    const cur = currentVersion();
    const next = nextVersion(cur, how);
    if (next === cur) {
        console.error('version is already ' + cur + '; nothing to do');
        process.exit(1);
    }

    const edits = [
        replaceIn(IDENTITY, new RegExp("return '" + cur.replace(/\./g, '\\.') + "';"),
            "return '" + next + "';", 'the BWDD_VERSION literal'),
        replaceIn(README, new RegExp('· v' + cur.replace(/\./g, '\\.')),
            '· v' + next, 'the version in the title'),
        replaceIn(PKG, /"version":\s*"[0-9]+\.[0-9]+\.[0-9]+"/,
            '"version": "' + next + '"', 'the package version'),
    ];

    console.log('version  ' + cur + ' -> ' + next + (dry ? '   (dry run, nothing written)' : ''));
    for (const e of edits) console.log('  ' + path.relative(ROOT, e.file).padEnd(26) + e.what);
    if (dry) return;

    for (const e of edits) fs.writeFileSync(e.file, e.after);

    console.log();
    const built = spawnSync(process.execPath, [path.join(ROOT, 'build.mjs')], { cwd: ROOT, stdio: 'inherit' });
    if (built.status !== 0) {
        console.error('\nthe build failed; sources are at ' + next + ' but an artifact may be stale');
        process.exit(built.status || 1);
    }
    console.log('\nnext: add a "## v' + next + '" entry to CHANGELOG.md, then `npm test`');
}

try { main(); } catch (e) { console.error('error: ' + e.message); process.exit(1); }
