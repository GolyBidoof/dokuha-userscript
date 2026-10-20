#!/usr/bin/env node
'use strict';
/*
 * Runs the real DMM worker source against a fake OffscreenCanvas. This does not
 * prove a browser codec works, but it does pin the message protocol, the tile
 * loop and the error path without needing Chrome (which cannot launch in this
 * environment).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const check = (name, pass, detail) => {
    results.push({ name, pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
};
const equal = (name, got, want) => check(name,
    JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));

const protocol = fs.readFileSync(path.join(ROOT, 'src/sites/dmm/00-state.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(ROOT, 'src/sites/dmm/01-protocol.js'), 'utf8')
    + '\n;globalThis.__dmm = { job: dmmWorkerJob, source: dmmWorkerSource };';
const host = {
    console,
    URL,
    URLSearchParams,
    location: { hostname: 'book.dmm.com', href: 'https://book.dmm.com/' },
    document: { cookie: '' },
    IMAGE_CODEC: { type: 'image/jpeg', quality: 0.9 },
    BWDD_DEBUG: false,
};
vm.createContext(host);
vm.runInContext(protocol, host);
const dmm = host.__dmm;

const page = {
    file: 'item/xhtml/p-011.xhtml', no: 0, type: 'jpeg',
    width: 900, height: 1280, dummyWidth: 4, dummyHeight: 0,
    scrambled: true, pattern: 4,
};
const job = dmm.job(11, new Uint8Array([0xff, 0xd8, 0xff]), page);

(async () => {
    const messages = [];
    const draws = [];
    const sandbox = {
        Blob,
        self: { postMessage: (m) => messages.push(m) },
        createImageBitmap: async () => ({ width: 904, height: 1280, close() {} }),
        OffscreenCanvas: class {
            constructor(width, height) { this.width = width; this.height = height; }
            getContext() {
                return { drawImage: (...args) => draws.push(args) };
            }
            async convertToBlob(opts) {
                return new Blob([new Uint8Array([1, 2, 3])], { type: opts && opts.type || 'image/png' });
            }
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(dmm.source(), sandbox);

    await sandbox.self.onmessage({ data: { batchId: 7, jobs: [job] } });
    equal('one worker result comes back', messages.length, 1);
    equal('the result keeps the batch and page ids',
        [messages[0].batchId, messages[0].id], [7, 11]);
    equal('the worker returns a JPEG Blob', messages[0].blob.type, 'image/jpeg');
    equal('every tile is blitted once', draws.length, 300);
    equal('the first edge-strip tile keeps source/destination orientation',
        draws[0].slice(1, 7), [704, 768, 8, 64, 640, 0]);

    sandbox.createImageBitmap = async () => { throw new Error('bad jpeg'); };
    await sandbox.self.onmessage({ data: { batchId: 8, jobs: [job] } });
    equal('a decode error is reported against the page',
        [messages[1].batchId, messages[1].id, /bad jpeg/.test(messages[1].error)], [8, 11, true]);

    const failed = results.filter((r) => !r.pass);
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
