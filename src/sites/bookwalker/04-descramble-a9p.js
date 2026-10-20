    const B2Y_TRIPLES = JSON.parse('[[1,3,10],[1,5,16],[1,5,19],[1,9,29],[1,11,6],[1,11,16],[1,19,3],[1,21,20],[1,27,27],[2,5,15],[2,5,21],[2,7,7],[2,7,9],[2,7,25],[2,9,15],[2,15,17],[2,15,25],[2,21,9],[3,1,14],[3,3,26],[3,3,28],[3,3,29],[3,5,20],[3,5,22],[3,5,25],[3,7,29],[3,13,7],[3,23,25],[3,25,24],[3,27,11],[4,3,17],[4,3,27],[4,5,15],[5,3,21],[5,7,22],[5,9,7],[5,9,28],[5,9,31],[5,13,6],[5,15,17],[5,17,13],[5,21,12],[5,27,8],[5,27,21],[5,27,25],[5,27,28],[6,1,11],[6,3,17],[6,17,9],[6,21,7],[6,21,13],[7,1,9],[7,1,18],[7,1,25],[7,13,25],[7,17,21],[7,25,12],[7,25,20],[8,7,23],[8,9,23],[9,5,14],[9,5,25],[9,11,19],[9,21,16],[10,9,21],[10,9,25],[11,7,12],[11,7,16],[11,17,13],[11,21,13],[12,9,23],[13,3,17],[13,3,27],[13,5,19],[13,17,15],[14,1,15],[14,13,15],[15,1,29],[17,15,20],[17,15,23],[17,15,26]]');
    const XSHIFT = [
        (p1, p2, p3, p4) => { p1 ^= p1 << p2; p1 ^= p1 >>> p3; p1 ^= p1 << p4; return p1; },
        (p1, p2, p3, p4) => { p1 ^= p1 << p4; p1 ^= p1 >>> p3; p1 ^= p1 << p2; return p1; },
        (p1, p2, p3, p4) => { p1 ^= p1 >>> p2; p1 ^= p1 << p3; p1 ^= p1 >>> p4; return p1; },
        (p1, p2, p3, p4) => { p1 ^= p1 >>> p4; p1 ^= p1 << p3; p1 ^= p1 >>> p2; return p1; },
        (p1, p2, p3, p4) => { p1 ^= p1 << p2; p1 ^= p1 << p4; p1 ^= p1 >>> p3; return p1; },
        (p1, p2, p3, p4) => { p1 ^= p1 >>> p2; p1 ^= p1 >>> p4; p1 ^= p1 << p3; return p1; },
    ];
    const B2Y_SEED = 2463534242;
    class B2y {
        constructor() {
            this.vk = 0; this.j = B2Y_SEED;
            this.l = B2Y_TRIPLES[74][this.vk++];
            this.m = B2Y_TRIPLES[74][this.vk++];
            this.n = B2Y_TRIPLES[74][this.vk++];
            this.f = XSHIFT[0];
        }
        b9es(E, L) {
            this.j = B2Y_SEED;
            const p = B2Y_TRIPLES[E];
            this.l = p[0]; this.m = p[1]; this.n = p[2]; this.f = XSHIFT[L];
        }
        B0o(p1) { const r = p1 >>> 0; this.j = r || B2Y_SEED; }
        b4K(p1) {
            if (p1 <= 1) return 0;
            const vv = 4294967295 - p1;
            let u = this.j, t, s;
            do {
                u = this.f(u, this.l, this.m, this.n) >>> 0;
                t = u - 1;
                s = t % p1;
            } while (vv < t - s);
            this.j = u;
            return s;
        }
    }
    B2y.b6o = B2Y_TRIPLES.length;
    B2y.b6b = XSHIFT.length;
    B2y.b4v = B2y.b6o * B2y.b6b;

    function v_mqg(fn, total) {
        const o = [];
        for (let i = 0; i < total; i++) { const n = fn(i + 1); o[i] = o[n]; o[n] = i; }
        return o;
    }
    function v_6qg(fn, v) { return v < 4 ? fn(v + 1) : fn(v - 1) + 1; }
    function v_7qg(fn, ye, ee) { if (ee <= 0) return 0; const r = fn(ee); return r < ye ? r : r + 1; }
    function v_9qg(fn, p2, p3, p4, p5, p6, p7) {
        for (let a, b, c, d = p6, e = p7, f = p4, g = p5, h = 0, i = 0, j = -1; d + e > 0; ) {
            const k = 0, l = j;
            a = fn(d + e);
            if (a < d) {
                if (a < f) {
                    for (b = i; b > k && !(h >= p2[b + l]); b--);
                    for (c = i + e; c < p7 && !(h >= p2[c]); c++);
                    p3[h] = fn(c - b) + b;
                    h++; f--;
                } else {
                    for (b = i; b > k && !(h + d <= p2[b + l]); b--);
                    for (c = i + e; c < p7 && !(h + d <= p2[c]); c++);
                    p3[h + d + l] = fn(c - b) + b;
                }
                d--;
            } else {
                if (a - d < g) {
                    for (b = h; b > k && !(i >= p3[b + l]); b--);
                    for (c = h + d; c < p6 && !(i >= p3[c]); c++);
                    p2[i] = fn(c - b) + b;
                    i++; g--;
                } else {
                    for (b = h; b > k && !(i + e <= p3[b + l]); b--);
                    for (c = h + d; c < p6 && !(i + e <= p3[c]); c++);
                    p2[i + e + l] = fn(c - b) + b;
                }
                e--;
            }
        }
    }
    function v_qpg(p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13) {
        const result = [], q1 = p1 + 1, q2 = p2 + 1, q3 = q1 << 1, q4 = q2 << 1;
        for (let v = 0; v < p1; v++) for (let w = 0; w < p2; w++) {
            const z = p3[v + w * p1], x = z % p1, y = (z - x) / p1;
            const r = v < p11[w] ? v : v + q1;
            const s = w < p10[v] ? w : w + q2;
            const t = x < p7[y] ? x : x + q1;
            const u = y < p6[x] ? y : y + q2;
            result.push(u * q3 + r);
            result.push(t * q4 + s);
        }
        result.push(p9 * q3 + p12);
        result.push(p8 * q4 + p13);
        for (let v = 0; v < p1; v++) {
            const x = p4[v], r = v < p12 ? v : v + q1, t = x < p8 ? x : x + q1;
            result.push(p6[x] * q3 + r);
            result.push(t * q4 + p10[v]);
        }
        for (let w = 0; w < p2; w++) {
            const y = p5[w], s = w < p13 ? w : w + q2, u = y < p9 ? y : y + q2;
            result.push(u * q3 + p11[w]);
            result.push(p7[y] * q4 + s);
        }
        return result;
    }
    function a3f(p1, p2, p3, p4) {
        const tog = new B2y();
        const uog = p2 ^ p3 ^ p4;
        const vog = Math.floor(p1 / 65536);
        const wog = Math.floor(p2 / 65536);
        const xog = Math.floor(p3 / 65536);
        const yog = Math.floor(p4 / 65536);
        const zo = B2y.b6o, zp = B2y.b6b;
        let q1 = wog ^ xog ^ yog, q2 = vog ^ yog, q3 = p1 ^ p2, q4 = p1 ^ p3, q5 = p1 ^ p4;
        q1 >>>= 16;
        const r6 = q1 % zp, r7 = ((q1 - r6) / zp) % zo;
        const b4k = tog.b4K.bind(tog);
        tog.b9es(r7, r6);
        tog.B0o(uog);
        const r9 = b4k(65536) | (b4k(65536) << 16);
        const apg = b4k(512);
        const bpg = wog >>> 16, cpg = xog >>> 16;
        q2 = (q2 >>> 16) ^ apg;
        q3 = (q3 ^ r9) >>> 0;
        q4 = (q4 ^ r9) >>> 0;
        q5 = (q5 ^ r9) >>> 0;
        const dpg = q2 % zp, epg = ((q2 - dpg) / zp) % zo;
        tog.b9es(epg, dpg);
        tog.B0o(q3);
        const fpg = v_mqg(b4k, bpg * cpg);
        tog.B0o(q4);
        const gpg = v_6qg(b4k, bpg), hpg = v_6qg(b4k, cpg);
        const ipg = v_7qg(b4k, gpg, bpg), jpg = v_7qg(b4k, hpg, cpg);
        tog.B0o(q5);
        const kpg = [], lpg = [];
        v_9qg(b4k, kpg, lpg, gpg, hpg, bpg, cpg);
        const mpg = v_mqg(b4k, bpg), npg = v_mqg(b4k, cpg);
        const opg = [], ppg = [];
        v_9qg(b4k, ppg, opg, ipg, jpg, bpg, cpg);
        return v_qpg(bpg, cpg, fpg, mpg, npg, opg, ppg, ipg, jpg, lpg, kpg, gpg, hpg);
    }
    function A9p(page, width, height) {
        const bw = page.b8A, bh = page.b6V;
        const r = page.B0J, s = page.B0K, t = page.B0n, u = page.B0A;
        const vo = B2y.b6o, wo = B2y.b6b;
        const bx = Math.floor(width / bw), by = Math.floor(height / bh);
        const lbw = width % bw, lbh = height % bh;
        const d14 = (bx + 1) << 1, d24 = (by + 1) << 1;
        const lxvs = (bx + 1) * bw - lbw, lyvs = (by + 1) * bh - lbh;
        const b54 = new B2y();
        const b64 = u ^ bx ^ by;
        const b74 = b64 % wo, b84 = ((b64 - b74) / wo) % vo;
        const out = [];
        b54.b9es(b84, b74);
        b54.B0o(r ^ s ^ t);
        const b94 = b54.b4K(65536) + b54.b4K(65536) * 65536 + b54.b4K(512) * 4294967296;
        const a4j = bx * 4294967296 + r, b4j = by * 4294967296 + s, c4j = u * 4294967296 + t;
        const d4j = a3f(b94, a4j, b4j, c4j);
        const e4j = (index, total, sbw, sbh) => {
            if (sbw !== 0 && sbh !== 0) for (; index < total; ) {
                const f = d4j[index++], g = d4j[index++];
                const h = f % d14, i = g % d24;
                const j = (g - i) / d24, k = (f - h) / d14;
                out.push({
                    srcX: h * bw - (h > bx ? lxvs : 0),
                    srcY: i * bh - (i > by ? lyvs : 0),
                    destX: j * bw - (j > bx ? lxvs : 0),
                    destY: k * bh - (k > by ? lyvs : 0),
                    width: sbw, height: sbh,
                });
            }
        };
        let x = 0, y = bx * by * 2;
        e4j(x, y, bw, bh);
        x = y; y += 2;
        e4j(x, y, lbw, lbh);
        x = y; y += bx * 2;
        e4j(x, y, bw, lbh);
        x = y; y += by * 2;
        e4j(x, y, lbw, bh);
        return out;
    }
    function pageSeedsNo(pageId, pageConfig, k1, k2, k3, no) {
        const list = pageConfig.FileLinkInfo.PageLinkInfoList;
        const Page = (list[no] && list[no].Page) || list[0].Page;
        const NS = Page.NS, PS = Page.PS, RS = Page.RS, No = Page.No;
        let v0 = 47;
        for (let i = 0; i < pageId.length; i++) v0 += pageId.charCodeAt(i);
        const fn = No.toString(10);
        for (let i = 0; i < fn.length; i++) v0 += fn.charCodeAt(i);
        v0 += k1.reduce((a, b) => a + b, 0) + k2.reduce((a, b) => a + b, 0) + k3.reduce((a, b) => a + b, 0);
        let v9 = v0 & 255;
        v9 |= v9 << 8;
        v9 |= v9 << 16;
        function xorHash(key) {
            let nhf = 0, ohf = key.length & -4;
            if (ohf > 32) ohf = 32;
            for (let phf = 0; phf < ohf; ) {
                nhf ^= key[phf++] << 24;
                nhf ^= key[phf++] << 16;
                nhf ^= key[phf++] << 8;
                nhf ^= key[phf++] << 0;
            }
            return nhf >>> 0;
        }
        const noDescramble = NS === null || NS === undefined || PS === null || PS === undefined || RS === null || RS === undefined;
        return {
            B0A: v0 % B2y.b4v,
            B0J: (v9 ^ xorHash(k1) ^ (NS || 0)) >>> 0,
            B0K: (v9 ^ xorHash(k2) ^ (PS || 0)) >>> 0,
            B0n: (v9 ^ xorHash(k3) ^ (RS || 0)) >>> 0,
            b8A: Page.BlockWidth,
            b6V: Page.BlockHeight,
            Size: Page.Size,
            noDescramble,
        };
    }

