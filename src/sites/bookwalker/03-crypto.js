
    // The viewer's configuration_pack.json is a custom envelope:
    //   { "version":"1.0", "data":"<custom-base64 payload>" }
    // Decoding is a fixed pipeline: custom base64 (A8j) -> a byte-keyed
    // key schedule (A3b / B0p / A7L / A6I / A2F / B0L / tB0l, an RC4 variant)
    // -> UTF-8 JSON of the page manifest. The first 128 chars of the payload
    // are three 32-byte keys (key1/key2/key3) later used to derive per-page
    // descramble seeds (section 3) and image filename tokens (section 4).
    // NOTE: identifiers like A8j, A3b, B0p, v4..v9 are the original names
    // from the minified viewer, preserved verbatim because this port is
    // validated byte-for-byte against live HAR data and the bookworm
    // offline client. Renaming them would risk silent drift; the
    // pipeline below is annotated instead.

    function arraySwap(arr, a, b) { const t = arr[a]; arr[a] = arr[b]; arr[b] = t; }

    // BookWalker's base64 alphabet is the standard A-Z a-z 0-9 + / set, but
    // the decode uses shifted bit masks per byte position (v5..v9).
    const ARR1 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('');
    const ARR2 = ARR1.map(c => c.charCodeAt(0));
    const v4 = [], v5 = [], v6 = [], v7 = [], v8 = [], v9 = [], vak = [];
    for (let i = 0; i < 64; i++) {
        const ch = ARR2[i];
        v4[ch] = i; v5[ch] = i << 2; v6[ch] = (i << 4) & 255;
        v7[ch] = (i << 6) & 255; v8[ch] = i >> 2; v9[ch] = i >> 4; vak[ch] = true;
    }
    const A8f = [v4, v5, v6, v7, v8, v9, vak];

    // Decode the custom base64 payload between dataOffset..dataEndOffset.
    // Returns [decodedBytes, decodedLength, key1, key2, key3] where the keys
    // are the first 128 chars split into three 32-byte registers.
    function A8j(content, dataOffset, dataEndOffset) {
        const arrayLength = 32, keyDataLength = 128;
        const payloadOffset = dataOffset + keyDataLength;
        const payloadLength = dataEndOffset - payloadOffset;
        if (payloadLength & 3) throw new Error('Invalid A8j payload length');
        const k1 = new Array(arrayLength), k2 = new Array(arrayLength), k3 = new Array(arrayLength);
        for (let i = dataOffset, active = k1, ai = 0; i < payloadOffset; ) {
            const a = content.charCodeAt(i++), b = content.charCodeAt(i++), c = content.charCodeAt(i++), d = content.charCodeAt(i++);
            if (!(A8f[6][a] && A8f[6][b] && A8f[6][c] && A8f[6][d])) throw new Error('Corrupted A8j characters');
            active[ai++] = A8f[1][a] | A8f[5][b];
            if (i === dataOffset + 88) { active = k3; ai = 0; }
            active[ai++] = A8f[2][b] | A8f[4][c];
            if (i === dataOffset + 44) { active = k2; ai = 0; }
            active[ai++] = A8f[3][c] | A8f[0][d];
        }
        if (payloadLength === 0) return [new Uint8Array(0), 0, k1, k2, k3];
        let resultLength = (payloadLength * 3) >> 2;
        if (content.charCodeAt(dataEndOffset - 2) === 61) resultLength -= 2;
        else if (content.charCodeAt(dataEndOffset - 1) === 61) resultLength -= 1;
        const result = new Uint8Array(resultLength);
        let off = payloadOffset, idx = 0;
        for (; off < dataEndOffset - 4; ) {
            const c1 = content.charCodeAt(off++), c2 = content.charCodeAt(off++), c3 = content.charCodeAt(off++), c4 = content.charCodeAt(off++);
            if (!(A8f[6][c1] && A8f[6][c2] && A8f[6][c3] && A8f[6][c4])) throw new Error('A8j char failure');
            result[idx++] = A8f[1][c1] | A8f[5][c2];
            result[idx++] = A8f[2][c2] | A8f[4][c3];
            result[idx++] = A8f[3][c3] | A8f[0][c4];
        }
        const u = content.charCodeAt(off++), v = content.charCodeAt(off++), w = content.charCodeAt(off++), x = content.charCodeAt(off++);
        if (!A8f[6][u] || !A8f[6][v]) throw new Error('A8j tail parsing error');
        result[idx++] = A8f[1][u] | A8f[5][v];
        if (A8f[6][w]) {
            result[idx++] = A8f[2][v] | A8f[4][w];
            if (A8f[6][x]) result[idx++] = A8f[3][w] | A8f[0][x];
            else if (x !== 61) throw new Error('A8j tail alignment error');
        } else if (w !== 61 || x !== 61) throw new Error('A8j tail padding error');
        return [result, resultLength, k1, k2, k3];
    }

    function a0F(input) {
        const result = new Array(256).fill(0).map((_, i) => i);
        const get = typeof input === 'string' ? input.charCodeAt.bind(input) : i => input[i];
        for (let c = 0, i = 0; i < 256; i++) {
            c = (c + result[i] + get(i % input.length)) % 256;
            arraySwap(result, i, c);
        }
        return result;
    }
    function a0g(key, b) {
        const result = [], g = a0F(b);
        for (let i = 0, c = 0, d = 0; i < key.length; i++) {
            c = (c + 1) % 256;
            d = (d + g[c]) % 256;
            arraySwap(g, c, d);
            result.push(key[i] ^ g[(g[c] + g[d]) % 256]);
        }
        return result;
    }
    const v_qmi = (p1, p2, p3) => a0F([...p1, ...p2, ...p3]);
    const v_smi = (content, p1, p2, p3) => a0g(content, [...p1, ...p2, ...p3]);

    function step(v7, v8, i, key, content) {
        v7 = (v7 + 1) % 256;
        v8 = (v8 + key[v7]) % 256;
        arraySwap(key, v7, v8);
        content[i] ^= key[(key[v7] + key[v8]) % 256];
        return [v7, v8];
    }
    function processContentStep(st, key, i) {
        const [content, clen, k1, k2, k3] = st;
        let v7 = 0, v8 = 0;
        for (; i >= 0; i -= 2) [v7, v8] = step(v7, v8, i, key, content);
        return [content, clen, k1, k2, k3];
    }

    function check1(n, m) { return (n & m) === m; }
    function process1(v0, v1, key) {
        for (let i = 0; i < 32; i++) { v0 = (v0 + key[i]) & 255; v1 ^= key[i]; }
        return [v0, v1];
    }
    function process2(y, u, g) {
        for (let v = y; u > y; u--, v--) arraySwap(g, u, v);
    }
    function A3b(of, st) {
        let [content, clen, k1, k2, k3] = st;
        let jki, kki, lki, mki, nki;
        switch (of) {
            case 3: jki = k1; kki = 32; lki = k2; mki = k3; nki = null; break;
            case 2: jki = k2; kki = 32; lki = k1; mki = k3; nki = null; break;
            case 1: jki = k3; kki = 32; lki = k1; mki = k2; nki = null; break;
            default: jki = content; kki = clen; lki = k1; mki = k2; nki = k3;
        }
        let [w0, x1] = process1(0, 0, lki);
        [w0, x1] = process1(w0, x1, mki);
        if (nki) [w0, x1] = process1(w0, x1, nki);
        const f2 = !check1(w0, 2), f4 = !check1(w0, 4), f8 = !check1(w0, 8);
        const s5 = x1 >>> 5, s6 = 8 - s5;
        let p7 = 0;
        const gli = [];
        for (let pli, qli, rli, sli, tli, uli, wli, xli, zli; p7 < kki; ) {
            for (
                pli = p7 + 32, qli = pli > kki,
                    qli ? ((pli = kki), (rli = pli - p7)) : (rli = 32),
                    wli = w0, xli = x1, tli = 0, uli = p7;
                tli < rli;
            ) {
                sli = jki[uli++];
                if (f2) sli = ((sli & 85) << 1) | ((sli >>> 1) & 85);
                if (f4) sli = ((sli & 51) << 2) | ((sli >>> 2) & 51);
                if (f8) sli = ((sli & 15) << 4) | ((sli >>> 4) & 15);
                gli[tli++] = sli;
                wli = (wli + sli) & 255;
                xli ^= sli;
            }
            for (let j = 0; j < rli; j++) {
                for (let i = 1; i <= 6; i++) {
                    const a = Math.pow(2, i);
                    if (!check1(j, a - 1)) break;
                    if (!check1(wli, a)) process2(j - Math.pow(2, i - 1), j, gli);
                }
            }
            zli = xli >>> 3;
            qli ? (zli %= rli) : (zli &= 31);
            if (s5 === 0) {
                for (let i = p7, j = rli - zli; i < pli; ) {
                    if (j === rli) j = 0;
                    jki[i++] = gli[j++];
                }
            } else {
                for (let i = p7, j = rli - zli - 1; i < pli; ) {
                    sli = gli[j] << s6;
                    if (++j === rli) j = 0;
                    sli |= gli[j] >>> s5;
                    jki[i++] = sli & 255;
                }
            }
            p7 = pli;
        }
        return [content, clen, k1, k2, k3];
    }

    function B0p(fk, st) {
        const [content, clen, k1, k2, k3] = st;
        const key = v_qmi(k2, fk, k3);
        for (let off = 0, omi = 0; off < clen; omi %= 256) content[off++] ^= key[omi++];
        return [content, clen, k1, k2, k3];
    }
    function A7L(fk, st) {
        const [content, clen, k1, k2, k3] = st;
        const i = (clen | 1) - 2;
        const key = v_qmi(fk, k1, k2);
        return processContentStep([content, clen, k1, k2, k3], key, i);
    }
    function A6I(fk, st) {
        const [content, clen, k1, k2, k3] = st;
        const i = (clen - 1) & -2;
        const key = v_qmi(k3, fk, k1);
        return processContentStep([content, clen, k1, k2, k3], key, i);
    }
    function A2F(st) {
        const [content, clen, k1, k2, k3] = st;
        const dmi = Math.min(32, clen);
        let a, b;
        for (let i = 0; i < dmi; i++) {
            const x = content[i] ^ k1[i] ^ k2[i] ^ k3[i];
            switch (x & 12) { case 0: a = k1[i]; break; case 4: a = k2[i]; break; case 8: a = k3[i]; break; case 12: a = content[i]; }
            switch (x & 3) {
                case 0: b = k1[i]; k1[i] = a; break;
                case 1: b = k2[i]; k2[i] = a; break;
                case 2: b = k3[i]; k3[i] = a; break;
                case 3: b = content[i]; content[i] = a;
            }
            switch (x & 12) { case 0: k1[i] = b; break; case 4: k2[i] = b; break; case 8: k3[i] = b; break; case 12: content[i] = b; }
            switch (x & 192) { case 0: a = k1[i]; break; case 64: a = k2[i]; break; case 128: a = k3[i]; break; case 192: a = content[i]; }
            switch (x & 48) {
                case 0: b = k1[i]; k1[i] = a; break;
                case 16: b = k2[i]; k2[i] = a; break;
                case 32: b = k3[i]; k3[i] = a; break;
                case 48: b = content[i]; content[i] = a;
            }
            switch (x & 192) { case 0: k1[i] = b; break; case 64: k2[i] = b; break; case 128: k3[i] = b; break; case 192: content[i] = b; }
        }
        return [content, clen, k1, k2, k3];
    }
    function B0L(fk, st) {
        let [content, clen, k1, k2, k3] = st;
        k3 = v_smi(k3, k2, k1, fk);
        k2 = v_smi(k2, k1, fk, k3);
        k1 = v_smi(k1, fk, k3, k2);
        return [content, clen, k1, k2, k3];
    }
    function tB0l(fk, st) {
        const [content, clen, k1, k2, k3] = st;
        const key = v_qmi(k3, k2, fk);
        let v7 = 0, v8 = 0;
        for (let i = 0; i < clen; i++) [v7, v8] = step(v7, v8, i, key, content);
        return [content, clen, k1, k2, k3];
    }
    function processFilename(filename) { return Array.from(new TextEncoder().encode(filename)); }
    function A6e(st) {
        const [content, clen] = st;
        return [new TextDecoder('utf-8').decode(content.slice(0, clen))];
    }
