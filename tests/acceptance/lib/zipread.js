'use strict';
/*
 * Read a ZIP from a Buffer, without a dependency.
 *
 * The CLI writes BookWalker volumes as an archive rather than loose pages, so
 * the acceptance run has to open one to compare it. `unzip` would do, but it is
 * an external binary that may or may not be on a runner; Node's `zlib` is
 * already here and `inflateRaw` is the whole of what a ZIP needs.
 *
 * Sizes come from the central directory rather than the local headers, because
 * a streamed entry may be written with a data descriptor and zeros locally.
 */

const zlib = require('zlib');

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

function readZip(buf) {
    // End of central directory: scan back over the (max 64 KB) comment.
    let eocd = -1;
    const from = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= from; i--) {
        if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('not a ZIP: no end-of-central-directory record');

    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const entries = [];

    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== CENTRAL) throw new Error(`central directory entry ${i} has a bad signature`);
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localAt = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

        const lNameLen = buf.readUInt16LE(localAt + 26);
        const lExtraLen = buf.readUInt16LE(localAt + 28);
        const start = localAt + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(start, start + compSize);

        let data;
        if (method === 0) data = raw;
        else if (method === 8) data = zlib.inflateRawSync(raw);
        else throw new Error(`${name}: unsupported compression method ${method}`);

        if (!name.endsWith('/')) entries.push({ name, data });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

module.exports = { readZip };
