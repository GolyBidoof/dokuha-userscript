// test_artifacts.js — every built userscript compiles, and is the file it claims
// to be.
//
// test_split_builds.js boots each artifact in Chrome and inspects what it
// carries; this test needs no browser and looks at the artifact on disk, which
// is a different failure mode: a file that is stale, hand-edited, truncated by
// an interrupted write, or left behind by a renamed target. Keeping it
// browser-free means a corrupt artifact is caught by `npm test` quickly, and
// caught at all even when nobody rebuilds.
//
// Targets are read from src/targets.json, so a new artifact (a new store, say)
// is covered the moment it is declared, with no edit here.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/targets.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/manifest.json'), 'utf8'));
const HEADER = '_meta/00-header.txt';

const results = [];
const check = (n, pass, d) => { results.push({ n, pass }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };

// The version literal in the core is the single source of truth; @version is
// substituted from it, so the two must agree in every artifact.
function coreVersion() {
  const src = fs.readFileSync(path.join(ROOT, 'src/core/00-identity.js'), 'utf8');
  const m = /return\s+'(\d+\.\d+\.\d+)';/.exec(src);
  return m ? m[1] : null;
}

function where(err, text, label) {
  const m = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+)').exec(err.stack || '');
  if (!m) return err.message;
  const line = Number(m[1]);
  return err.message + ' @ ' + label + ':' + line + '  ' +
    (text.split('\n')[line - 1] || '').trim().slice(0, 120);
}

const fragmentBody = f => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
// The built bundles are comment-stripped, so "the fragment is present whole"
// means its stripped form is present. Both this test and build.mjs call the
// same lexer, so the expectation is byte-identical to what the build emits.
const { stripSource } = require('../tools/strip-comments.js');
const strippedFragmentBody = f => stripSource(fragmentBody(f));
const VERSION = coreVersion();

check('the core declares a version to compare against', !!VERSION, VERSION || 'not found in src/core/00-identity.js');

let built = 0;
for (const [id, target] of Object.entries(TARGETS)) {
  const label = target.out;
  const file = path.join(ROOT, label);
  if (!fs.existsSync(file)) { check(label + ': exists', false, 'missing — run `node build.mjs`'); continue; }
  const text = fs.readFileSync(file, 'utf8');
  built++;
  check(label + ': is a whole file, not empty', text.length > 4096, text.length + ' bytes');

  // 1) compiles as a classic script, which is how a manager injects it. This is
  // the check that turns "Unexpected token" into a line number in the artifact.
  let err = null;
  try { new vm.Script(text, { filename: label }); } catch (e) { err = e; }
  check(label + ': compiles as a script (V8)', !err, err ? where(err, text, label) : 'parsed');

  // 2) and as a function body, because a host may wrap the source before
  // compiling it. The two wrappings accept different things (a top-level return,
  // for one), so both are worth asserting.
  err = null;
  try { new Function(text); } catch (e) { err = e; }
  check(label + ': compiles as a function body', !err, err ? err.message : 'parsed');

  // 3) a valid script with a broken or duplicated header is still uninstallable
  const opens = (text.match(/==UserScript==/g) || []).length;
  const closes = (text.match(/==\/UserScript==/g) || []).length;
  check(label + ': exactly one metadata block', opens === 1 && closes === 1, 'open=' + opens + ' close=' + closes);
  check(label + ': ends with a newline', text.endsWith('\n'), JSON.stringify(text.slice(-14)));
  const holders = text.match(/\{\{[A-Z_]+\}\}/g);
  check(label + ': no unsubstituted placeholder', !holders,
    holders ? [...new Set(holders)].join(' ') : 'none');
  const ver = /@version\s+(\d+\.\d+\.\d+)/.exec(text);
  check(label + ': @version is the core version', !!ver && ver[1] === VERSION,
    '@version ' + (ver ? ver[1] : 'missing') + ' vs core ' + VERSION);

  // 4) nothing is truncated. Every fragment is emitted as its stripped body
  // (or, for the metadata header, verbatim), so each one this target includes
  // must appear whole. The header is checked separately below.
  const allow = new Set(target.modules);
  const included = MANIFEST.fragments.filter(f => allow.has(f.module));
  const shortFrag = included.filter(f => f.file !== HEADER && !text.includes(strippedFragmentBody(f.file)));
  check(label + ': all ' + included.length + ' fragments present whole', shortFrag.length === 0,
    shortFrag.length ? 'missing or truncated: ' + shortFrag.map(f => f.file).join(', ') : 'no truncation');

  // 5) and nothing leaked in from a module this target excludes. §4 catches a
  // partial leak only if it breaks the parse; this catches a clean one.
  const leakedFrag = MANIFEST.fragments.filter(f => !allow.has(f.module) && text.includes(strippedFragmentBody(f.file)));
  check(label + ': no fragment from an excluded module', leakedFrag.length === 0,
    leakedFrag.length ? 'leaked: ' + leakedFrag.map(f => f.file).join(', ') : 'clean');
}

// 6) the artifacts are what src/ currently produces. `--check` never writes, and
// assembling also compiles, so this covers the sources still building a valid
// script as well as the files on disk being current.
let stale = null;
try {
  execFileSync(process.execPath, ['build.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
} catch (e) {
  stale = String((e.stdout || '') + (e.stderr || '')).trim().split('\n').slice(-3).join(' | ');
}
check('every artifact matches a fresh build of src/', !stale, stale || built + ' artifacts up to date');

// 7) no artifact left behind by a renamed or removed target
const declared = new Set(Object.values(TARGETS).map(t => t.out));
const orphans = fs.readdirSync(ROOT).filter(f => f.endsWith('.user.js') && !declared.has(f));
check('no orphan .user.js in the repo root', orphans.length === 0,
  orphans.length ? orphans.join(', ') : 'none');

// 8) the single-store builds' "all-in-one downloader" pointer hard-codes the combined
// artifact's filename, because a fragment cannot be templated. Keep that name
// honest: renaming the combined target has to fail here rather than ship a link
// that 404s.
const UNIFIED_SRC = 'src/core/34-unified-link.js';
if (fs.existsSync(path.join(ROOT, UNIFIED_SRC))) {
  const frag = fs.readFileSync(path.join(ROOT, UNIFIED_SRC), 'utf8');
  const named = (/BWDD_UNIFIED_OUT = '([^']+)'/.exec(frag) || [])[1];
  const unifiedTargets = Object.entries(TARGETS)
    .filter(([, t]) => t.modules.includes('feature/unified-link')).map(([id]) => id);
  check('the "all-in-one downloader" pointer names the combined artifact',
    named === TARGETS.both.out,
    `fragment=${named} both.out=${TARGETS.both.out}`);
  check('the "all-in-one downloader" pointer is in the single-store builds only',
    unifiedTargets.length > 0 && !unifiedTargets.includes('both'),
    unifiedTargets.join(', ') || 'no target carries it');
}

// 9) the build's own guards must bite. A module a target names but no fragment
// declares, and a store fragment ordered above the registerSite() definition,
// are both silent failures otherwise: the first ships an artifact missing a
// store, the second throws a TDZ ReferenceError at boot. Build in a temp copy so
// the real src/ is never touched.
function buildInTemp(mutate, keepTmp) {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bwdd-guard-'));
  let keep = false;
  try {
    fs.cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true });
    // build.mjs imports the stripper from tools/, so the temp copy needs it too.
    fs.cpSync(path.join(ROOT, 'tools'), path.join(tmp, 'tools'), { recursive: true });
    for (const f of ['build.mjs', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
    mutate(tmp);
    execFileSync(process.execPath, ['build.mjs', '--target', 'bookwalker'], { cwd: tmp, stdio: 'pipe' });
    if (keepTmp) keep = true;
    return { ok: true, err: '', tmp };
  } catch (e) {
    const all = String((e.stdout || '') + (e.stderr || ''));
    // Node prints the throwing frame before the message; the message is the
    // useful evidence, so surface that line rather than the stack's first one.
    const fail = all.split('\n').map(l => l.trim()).find(l => l.startsWith('Error:'));
    return { ok: false, err: fail || all.trim(), tmp };
  } finally {
    if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const phantom = buildInTemp(tmp => {
  const p = path.join(tmp, 'src/targets.json');
  const t = JSON.parse(fs.readFileSync(p, 'utf8'));
  t.bookwalker.modules.push('sites/nonexistent');
  fs.writeFileSync(p, JSON.stringify(t, null, 2));
});
check('a target naming a module with no fragments fails the build',
  !phantom.ok && /no fragments/.test(phantom.err),
  phantom.err || 'build SUCCEEDED - guard missing');

// The order comes from the `after` links now, so the guard is exercised by
// splicing the store adapter's link in front of registerSite(), not by moving
// its entry in the array: the array no longer decides the load order at all.
const order = buildInTemp(tmp => {
  const p = path.join(tmp, 'src/manifest.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  const adapter = m.fragments.find(f => f.file === 'sites/bookwalker/30-adapter.js');
  const site = m.fragments.find(f => f.file === 'core/70-site.js');
  const next = m.fragments.find(f => f.after === adapter.file);
  if (next) next.after = adapter.after; else delete adapter.after;
  adapter.after = site.after;
  site.after = adapter.file;
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
});
check('a store fragment ordered above registerSite() fails the build',
  !order.ok && /defines it/.test(order.err),
  order.err || 'build SUCCEEDED - guard missing');

// 10) the derived order does not read the fragment array. Sorting the entries
// leaves every `after` link intact, so the build must produce the identical
// artifact; if it did not, the array would still be the real load order.
const shuffled = buildInTemp(tmp => {
  const p = path.join(tmp, 'src/manifest.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.fragments.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
}, true);
let shuffleSame = false;
let shuffleWhy = shuffled.err || 'build failed';
if (shuffled.ok) {
  const repoText = fs.readFileSync(path.join(ROOT, 'bookwalker-only.user.js'), 'utf8');
  const tmpText = fs.readFileSync(path.join(shuffled.tmp, 'bookwalker-only.user.js'), 'utf8');
  shuffleSame = repoText === tmpText;
  shuffleWhy = shuffleSame ? 'byte-identical after reordering the array' : 'the array still decides the order';
}
fs.rmSync(shuffled.tmp, { recursive: true, force: true });
check('the derived order ignores the fragment array order', shuffleSame, shuffleWhy);

const failed = results.filter(r => !r.pass);
console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
process.exit(failed.length ? 1 : 0);
