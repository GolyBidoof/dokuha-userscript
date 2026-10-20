    function v_jdf(filename) {
        const n = parseInt(filename, 10);
        if (!isNaN(n) && n >= 0 && n <= 1152921504606847000) {
            const h = n.toString(16);
            return h.length.toString(16) + h;
        }
        return '0' + filename;
    }
    function v_hdf(k1, k2, k3) {
        const out = [];
        out.length = Math.max(k1.length, k2.length, k3.length);
        for (let i = 0; i < out.length; i++) out[i] = 0;
        for (let i = 0; i < k1.length; i++) out[i] ^= k1[i];
        for (let i = 0; i < k2.length; i++) out[i] ^= k2[i];
        for (let i = 0; i < k3.length; i++) out[i] ^= k3[i];
        return out;
    }
    const vval = (value) => (value < 10 ? 48 : 87) + value;
    function v_ndf(b9w, pageId, fileName) {
        const parentFolder = pageId + '/';
        const pathLength = parentFolder.length + fileName.length;
        const v_bef = (1 + pathLength) << 1;
        const cef = new Array(v_bef);
        cef[0] = 0; cef[1] = 59;
        const def = String.prototype.charCodeAt.bind(parentFolder + fileName);
        for (let p = 2, o = 0; o < pathLength; o++) {
            const s = def(o);
            cef[p++] = s >>> 8;
            cef[p++] = s % 256;
        }
        let fef = 3;
        for (let eef = (fileName.length << 1) + v_bef + v_bef; eef < 256; fef++) eef += v_bef;
        let jef = 1670739, kef = 1282576, lef = 2237221;
        for (let i = (1 + parentFolder.length) << 1, j = 0, k = 0; k < fef; k++, i = 0) {
            for (; i < v_bef; ) {
                lef ^= cef[i++] ^ b9w[j++];
                const ief = 435 * lef;
                const hef = 435 * kef + ((lef & 7) << 18) + (ief >>> 22);
                const gef = 435 * jef + ((kef & 3) << 19) + ((lef & 4194296) >>> 3) + (hef >>> 21);
                lef = ief & 4194303;
                kef = hef & 2097151;
                jef = gef & 2097151;
                j >= b9w.length && (j = 0);
            }
        }
        const mef = new Array(16);
        const pval = (idx, value) => { mef[idx] = vval(value >>> 4); mef[idx + 1] = vval(value & 15); };
        pval(0, (jef >>> 13) ^ b9w[0]);
        pval(2, ((jef >>> 5) & 255) ^ b9w[1]);
        pval(4, (((jef & 31) << 3) | (kef >>> 18)) ^ b9w[2]);
        pval(6, ((kef >>> 10) & 255) ^ b9w[3]);
        pval(8, ((kef >>> 2) & 255) ^ b9w[4]);
        pval(10, (((kef & 3) << 6) | (lef >>> 16)) ^ b9w[5]);
        pval(12, ((lef >>> 8) & 255) ^ b9w[6]);
        pval(14, (lef & 255) ^ b9w[7]);
        return String.fromCharCode(...mef);
    }
    function b8gNo(pageId, k1, k2, k3, no) {
        const fname = String(no == null ? 0 : no);
        return pageId + '/' + v_jdf(fname) + v_ndf(v_hdf(k1, k2, k3), pageId, fname) + '.jpeg';
    }

