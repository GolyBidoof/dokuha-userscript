#!/usr/bin/env node
'use strict';
/*
 * CMOA scramble tables — the ported engine, checked against real data.
 *
 * The tables below are a real `bibGetCntntInfo` response for one CMOA volume
 * (captured from a session, `cid`/`k` included), so this pins the port to what
 * the store actually sends rather than to a pattern invented for a test:
 *
 *   * the four tables decode to JSON with the client-side `k`;
 *   * the tiled patterns parse, apply to a real 900x1280 page, and form a
 *     bijection whose destination rectangles exactly tile the visible area -
 *     a wrong permutation would still "look" plausible, so tiling exactly is
 *     the property worth asserting;
 *   * `selectScramble` picks the table by filename checksum, per page;
 *   * the page list comes out of the ttx document with the portrait half
 *     dropped (getting that wrong silently doubles a volume).
 *
 * Everything here is pure data in, geometry out: no network, no viewer.
 */
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

const CID = "0000214822_jp_0001";
const K = "2S0CSz3lFNF0GZ87Le4uE63iLOrXeSqi";
const TABLES = {
    stbl: "5S:<%NF>@@1fD>2:#(pV=L7J48.bDq7/7.*1Y',5[|k-'_gpI@1%$a88/)(^Pri<K\"#C+Si0)Ov[5P9fuitVmp)fDlHqXHfP_#$_ -)W>=m?3HJBx[n$%U2it*CHq?^!#",
    ttbl: "5QG8%LKCDA1eIA84#&{WCBAC999\\MnA3D(16e'8,`zv(+WmsOF5z0_D9/-/][wi8X\"'D+Pq1.TvY9N>jug{Vyu)iInRvXLlQjz.[',3PDAxG;=QC}\\u|,T6cy!KJyBhtZE>\\@`NlPnO)m\\&0/Pu/HM=27H463-26<duqr$UpyqNt 1(^\\rYuMSG.\\I5Dq$h3;\"5rOaq&mfFr Dnn/@:j!Tm-yY7e_Oq#RwY?3kvV29ezFATEpNhPHZFA'%0/5pJD^<g^@nby)3?Q.9K58-.`08:jQ#NhPpS&,Lt+ZEJ8fIC<IJ@x'}5$\\.eHC@apX>?KuW?p$TFWt+BDhG:5P>k\"JhOB]yiD=nRp^5SHl_Le!Y9<2-Z33b^u",
    ctbl: "5>K?&QEAARLx[MHE?6+gU]OZNsn| R|SxlPU]?e8a^*oL6%Rjp<j9'tzuH/:hrI\\tRP\\4c@@6aZRKmtIM# >7q\\#]]H_iNgU^$%m8=@gUL%QJTdS5n)@2XnDddZv)$LKu} ^ve}Gwn+JOra@O7.@KJdhMS5INw^95{rNT]6-UR$4JAL%{8ydM@L5QJ4Fe5{OQ1J(e{%5#|\\\"0frEf_T'>zJ)a4X9Km6Fp%hHq'X<1scH,(x\\:_7NZ=#vC<dia/2%pt=lZNa\\)4>R++>+@0)e(@3zZ.[\"b$c6=h&>mZZyIp#SW4W}G?N;4l'uvvM$ +wiGUzqE8]{01b#fGxP(nLdktNP01ccbAUFgo'by\\w[vGE</9P4-rm[#3JIBs[m[ (d{(tl1Y}!\"#xLU(HViY,fb}+Us/;f6|4B)X/'%9U.V#^rVdK{%E2!ExTvpmN<MBKl`H?!qR:{BE[[u;M?}a9yB@U\"Ru1gtc\"aHNM`P>sk-B4w0(D'-uIgVGPEfn5r&[& mF!v@*yG9%R8uNcpmsLM=mrd-tXf}XX383N,XQLHT:tkK&Lr):=n+[d<[8(JLAds$ YLFxmxv4L&s3A8(u$M>T1RkJ9BLs?xwsvn9MKx*yc^2\\i,'0,%sb{f0'aR8`CNTgT`^=oW]Tv+85no]PdxIx:pu_Z^l6+7L3kl=U,/R@7<='T/8[EM4Gg--'Aly!GJ*F#AHndLwi2^!oQ}2",
    ptbl: "5>K?&QGAAKHv[NIF:9-hX^STI9C(i(v>#>/i>+iXxKw</r<gTg^?`E!Vdr@\"?0$w'<KJv36-kcX7zLr =eL:8BdBd]H_iNgU`$%n7=CjYP(PIT`R1k,?ooR<.Yq'M[t5)tja>5%!N*ton _gS7Sk&p[{Lt4]|Q,;_<p^KC7L$u_%\"?MHjVndM@L5QJ6Fe1{ML0F$aw&8&z^!7V3$zpnddwVPz%Y8c\\0]S.VNXo;2)G)H%Pn}JRT5V8C@K?s`iCp}%YCl{K`^4X$']+>+@0)e*@3u[3a#c$b1<f$;o]`(GwRLTjv^*Qn@&Q;UOxzotf?!$v^Q=RawPxZkj_ |+=-|&%5#68]n\"80D+Ac@1s,[vGE</9R4-vm`%3LIIr[oW#%dyj!@Q!c5MQ>FgvI:3>}0X%)D3+_@?=2?Mxvpd>}hbD5I`Htqbt{>QWsGgn5)Y'Ck$H?!qR:{DE[Xr8J<{`6y?CW\"Ox1-*Gq&pmt3\\4ui+=h7>?6wjIp&88p&?w,$*WB4mc4sQ,&c\"vezwrUhsYP=H&en5rxf}XX383P,XQJHS:sjL$Ox)5Bt)G1@|FVKN!^&.jB}KAW/iAtwu.s>.@#ZG[!D+5nen&}JLY1qRM7+M;N$1SI/dXadRb{f0'aR:`CLUhUa_=n[[Tv.:4im<\\IC]\"^)zQ/Ah&Gc\";xqCUW4P9S5\"1OntQrKk9'F'Bs7z5uz[O|94r<n:dc1*#e}2",
};

// A real page from the same volume's ttx.
const PAGE_SRC = 'pages/l37unaWP.jpg';
const STORED = { width: 900, height: 1280 };

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
const PAGE = '<!doctype html><html><body><div id="content"></div></body></html>';
// The adapter only registers (and so only publishes its debug globals) for a
// store host, so the page is served as www.cmoa.jp through interception.
const appSrv = https.createServer({
    key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')),
}, (req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); });

(async () => {
    const results = [];
    const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  \u2014 ' + d); };

    const appPort = await listen(appSrv);
    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'],
    });
    try {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', req => {
            const url = req.url();
            if (/127\.0\.0\.1:62642|learnnatively|manga-kotoba/.test(url)) return req.abort();
            if (/cmoa\.jp/.test(url)) {
                return req.respond({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: PAGE });
            }
            return req.continue();
        });
        await page.goto('https://www.cmoa.jp/bib/speedreader/?bwddDebug=1', { waitUntil: 'domcontentloaded' });
        await page.addScriptTag({ content: loadUserscript() });
        const engine = await page.evaluate(() => !!window.__bwddCmoaScramble);
        check('the ported engine is reachable', engine, 'window.__bwddCmoaScramble=' + engine);

        const decoded = await page.evaluate((cid, k, tables) => {
            const out = window.__bwddCmoaScramble.decodeTables(cid, k, tables);
            return {
                keys: Object.keys(out).sort(),
                ctbl: out.ctbl, ptbl: out.ptbl,
                stblLen: (out.stbl || []).length, ttblLen: (out.ttbl || []).length,
            };
        }, CID, K, TABLES);
        check('real tables decode with the client-side key',
            decoded.ctbl && decoded.ctbl.length === 8 && decoded.ptbl && decoded.ptbl.length === 8,
            'ctbl=' + (decoded.ctbl || []).length + ' ptbl=' + (decoded.ptbl || []).length +
            ' stbl=' + decoded.stblLen + ' ttbl=' + decoded.ttblLen);

        const picked = await page.evaluate((src, tables) => {
            const sel = window.__bwddCmoaScramble.selectScramble(src, tables);
            return sel && { coord: sel.coordTable, piece: sel.pieceTable, checksum: sel.checksum };
        }, PAGE_SRC, { ctbl: decoded.ctbl, ptbl: decoded.ptbl });
        check('the per-page checksum selects a real tiled pair',
            !!picked && /^=8-8\+4-/.test(picked.coord) && /^=8-8-4-/.test(picked.piece),
            'checksum=' + JSON.stringify(picked && picked.checksum) +
            ' coord=' + JSON.stringify((picked && picked.coord || '').slice(0, 14)) +
            ' piece=' + JSON.stringify((picked && picked.piece || '').slice(0, 14)));

        const plan = await page.evaluate((coord, piece, w, h) =>
            window.__bwddCmoaScramble.plan(coord, piece, w, h), picked.coord, picked.piece, STORED.width, STORED.height);
        const coords = (plan.transfers && plan.transfers[0] && plan.transfers[0].coords) || [];
        check('the tiled plan applies to a real page and drops the padding',
            plan.kind === 'tiled' && plan.width === 836 && plan.height === 1216,
            'kind=' + plan.kind + ' display=' + plan.width + 'x' + plan.height + ' rects=' + coords.length);

        // Exact tiling: areas add up, every rectangle is inside the stored
        // image and inside the visible area, and no two destination rectangles
        // overlap. A permutation that dropped or duplicated a tile fails here.
        const area = coords.reduce((sum, c) => sum + c.width * c.height, 0);
        const expected = plan.width * plan.height;
        let inside = true;
        for (const c of coords) {
            if (c.xsrc < 0 || c.ysrc < 0 || c.xsrc + c.width > STORED.width || c.ysrc + c.height > STORED.height) inside = false;
            if (c.xdest < 0 || c.ydest < 0 || c.xdest + c.width > plan.width || c.ydest + c.height > plan.height) inside = false;
        }
        let overlaps = 0;
        for (let i = 0; i < coords.length; i++) {
            for (let j = i + 1; j < coords.length; j++) {
                const a = coords[i], b = coords[j];
                if (a.xdest < b.xdest + b.width && b.xdest < a.xdest + a.width &&
                    a.ydest < b.ydest + b.height && b.ydest < a.ydest + a.height) overlaps++;
            }
        }
        check('the geometry is an exact tiling of the visible page',
            area === expected && inside && overlaps === 0 && coords.length === 64,
            'area=' + area + '/' + expected + ' inside=' + inside + ' overlaps=' + overlaps + ' rects=' + coords.length);

        const identity = await page.evaluate(() => window.__bwddCmoaScramble.plan('', '', 900, 1280));
        check('a volume with no scramble tables is served whole',
            identity.kind === 'none' && identity.width === 900 && identity.height === 1280,
            'kind=' + identity.kind + ' ' + identity.width + 'x' + identity.height);

        const numeric = await page.evaluate(() => {
            try { window.__bwddCmoaScramble.plan('1234', '1234', 900, 1280); return null; }
            catch (e) { return String(e.message); }
        });
        check('an unimplemented layout is named rather than guessed',
            !!numeric && /numeric scramble layout/.test(numeric), JSON.stringify(numeric));

        const list = await page.evaluate((ttx) => window.__bwddCmoaScramble.parsePageList(ttx),
            '<t-ttx><t-time pagedirection="rtl"></t-time>' +
            '<t-case screen.portrait><t-img src="pages/portrait.jpg" orgwidth="900" orgheight="1280" /></t-case>' +
            '<t-img id="L0000" src="pages/a.jpg" orgwidth="900" orgheight="1280" />' +
            '<t-img id="L0001" src="pages/b.jpg" orgwidth="900" orgheight="1280" /></t-ttx>');
        check('the ttx page list keeps the landscape half only',
            list.length === 2 && list[0].src === 'pages/a.jpg' && list[0].width === 900,
            list.length + ' pages, first=' + JSON.stringify(list[0] && list[0].src));

        console.log('\n--- summary ---');
        console.log('volume   : ' + CID);
        console.log('page src : ' + PAGE_SRC + '  -> ' + picked.coord.slice(0, 16) + ' / ' + picked.piece.slice(0, 16));
        console.log('display  : ' + plan.width + 'x' + plan.height + ' from ' + STORED.width + 'x' + STORED.height +
            ' in ' + coords.length + ' tiles');
    } finally {
        await browser.close().catch(() => {});
        appSrv.close();
    }

    const failed = results.filter(r => !r.pass);
    require('fs').writeFileSync(require('path').join(__dirname, 'cmoa_scramble_tables_result.json'),
        JSON.stringify({ results }, null, 2));
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
