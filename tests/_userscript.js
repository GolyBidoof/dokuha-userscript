'use strict';
/*
 * Shared loader for the built userscript.
 *
 * The suite must be hermetic. A developer who has the real mokuro bridge running
 * (which is the normal state when working on this script) would otherwise have
 * its 48 fetch-proxy ports discovered by every test page and mixed into the lane
 * pool, so distribution assertions like "round-robin stays balanced" or "the
 * dotted host gets its own pool" would be measuring the bridge rather than the
 * code under test.
 *
 * Pointing the bridge URL at a closed port keeps discovery off. Tests that want
 * a bridge supply their own stub and pass { bridge: true }.
 */
const fs = require('fs');
const path = require('path');

const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');
const REAL_BRIDGE = "'http://127.0.0.1:62642'";
const DEAD_BRIDGE = "'http://127.0.0.1:1'";

function loadUserscript(opts) {
    const file = (opts && opts.file) || US;
    const src = fs.readFileSync(file, 'utf8');
    if (opts && opts.bridge) return src;
    const patched = src.replace(REAL_BRIDGE, DEAD_BRIDGE);
    if (patched === src && src.indexOf(REAL_BRIDGE) !== -1) {
        throw new Error('bridge URL substitution failed');
    }
    return patched;
}

module.exports = { loadUserscript, US };
