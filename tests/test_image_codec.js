// test_image_codec.js — the output-codec option.
//
// Checks each setting resolves to the right mime/ext, that the worker really
// emits that type, that "lossless" is bit-exact against the DESCRAMBLED
// reference, and that a lossy setting still yields a sane image.
'use strict';
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const fs = require('fs');
const path = require('path');
const https = require('https');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');
const W = 1200, H = 1800;

const appSrv = https.createServer(
  { key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')) },
  (req, res) => { res.setHeader('Content-Type','text/html'); res.end('<html><body></body></html>'); });
const listen = (s) => new Promise(r => s.listen(0,'127.0.0.1',()=>r(s.address().port)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const CONFIGS = [
  { label: 'defaults',                set: {},                              fmt:'jpeg', type:'image/jpeg', ext:'jpg',  lossless:false },
  { label: 'jpeg q0.80',              set: {bwddImageQuality:'0.8'},        fmt:'jpeg', type:'image/jpeg', ext:'jpg',  lossless:false },
  { label: 'webp',                    set: {bwddImageFormat:'webp'},        fmt:'webp', type:'image/webp', ext:'webp', lossless:false },
  { label: 'lossless',                set: {bwddImageFormat:'lossless'},    fmt:'lossless', type:'image/webp', ext:'webp', lossless:true },
  { label: 'png',                     set: {bwddImageFormat:'png'},         fmt:'png',  type:'image/png',  ext:'png',  lossless:true },
];

(async () => {
  const appPort = await listen(appSrv);
  const APP = 'https://127.0.0.1:' + appPort + '/?bwddDebug=1';
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox','--ignore-certificate-errors'] });
  const results = [];
  const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass?'PASS  ':'FAIL  ')+n+'  — '+d); };

  // Every case here builds its reference page with BookWalker's own A9p
  // descrambler, so the file only applies to an artifact carrying that module.
  // The CMOA-only build has no A9p by design: skip instead of crashing.
  {
    const probe = await browser.newPage();
    await probe.goto(APP);
    await probe.addScriptTag({ content: loadUserscript() });
    await sleep(250);
    const hasA9p = await probe.evaluate(() => !!(window.__bwdd && typeof window.__bwdd.A9p === 'function'));
    await probe.close();
    if (!hasA9p) {
      await browser.close(); appSrv.close();
      console.log('SKIP  test_image_codec.js  — this artifact has no BookWalker A9p descrambler');
      process.exit(0);
    }
  }

  for (const cfg of CONFIGS) {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0,160)));
    // localStorage is per-origin and survives page.close(), so clear it first or
    // one config's setting leaks into the next page's run.
    await page.evaluateOnNewDocument((set) => {
      try { localStorage.clear(); for (const k of Object.keys(set)) localStorage.setItem(k, set[k]); } catch (e) {}
    }, cfg.set);
    await page.goto(APP);
    await page.addScriptTag({ content: loadUserscript() });
    await sleep(250);

    const out = await page.evaluate(async (W, H) => {
      const b = window.__bwdd;
      const codec = b.imageCodec;
      const c = new OffscreenCanvas(W, H);
      const x = c.getContext('2d');
      // Realistic-ish page content. Per-pixel noise would be the worst case for
      // JPEG and would make the PSNR assertions meaningless.
      const g = x.createLinearGradient(0,0,W,H);
      g.addColorStop(0,'#ffffff'); g.addColorStop(1,'#223044');
      x.fillStyle=g; x.fillRect(0,0,W,H);
      x.fillStyle='#000';
      for (let i=0;i<60;i++) x.fillRect((i*97)%W, (i*151)%H, 40+(i%7)*13, 9);
      x.strokeStyle='#111'; x.lineWidth=3;
      for (let i=0;i<40;i++) x.strokeRect((i*211)%W, (i*173)%H, 80+(i%5)*30, 60+(i%3)*40);
      x.font='28px sans-serif'; x.fillStyle='#000';
      for (let i=0;i<20;i++) x.fillText('サンプル text line '+i, 60, 100+i*40);
      x.fillStyle='#f00'; x.fillRect(0,0,61,61);
      const seeds = { b8A:256, b6V:256, B0J:1, B0K:2, B0n:3, B0A:4 };
      const src = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });

      const sb = await createImageBitmap(src);
      const rc = new OffscreenCanvas(W,H); const rx = rc.getContext('2d');
      rx.drawImage(sb,0,0); sb.close&&sb.close();
      const srcPix = rx.getImageData(0,0,W,H).data;
      const expected = new Uint8ClampedArray(srcPix.length);
      const stride = W*4;
      for (const t of b.A9p(seeds, W, H)) {
        const srow = t.destY*stride + t.destX*4, drow = t.srcY*stride + t.srcX*4, len = t.width*4;
        for (let r=0;r<t.height;r++) expected.set(srcPix.subarray(srow+r*stride, srow+r*stride+len), drow+r*stride);
      }

      const url = URL.createObjectURL(new Blob([b.buildWorkerSource()], { type: 'text/javascript' }));
      const w = new Worker(url);
      const data = await new Promise((res) => {
        w.onmessage = (ev) => res(ev.data);
        w.onerror = (e) => res({ error: String((e&&e.message)||e) });
        w.postMessage({ id: 1, blob: src, seeds, q: codec.quality, fmt: codec.type, W, H });
      });
      w.terminate(); URL.revokeObjectURL(url);
      if (!data || data.error) return { codec, error: (data&&data.error)||'no message' };

      const bmp = await createImageBitmap(data.blob);
      const oc = new OffscreenCanvas(W,H); const ox = oc.getContext('2d');
      ox.drawImage(bmp,0,0); bmp.close&&bmp.close();
      const got = ox.getImageData(0,0,W,H).data;
      let se=0,n=0;
      for (let i=0;i<got.length;i+=4) for (let k=0;k<3;k++){const d=got[i+k]-expected[i+k]; se+=d*d; n++;}
      const psnr = se===0 ? 99 : 10*Math.log10(255*255/(se/n));
      return { codec, blobType: data.blob.type, bytes: data.blob.size, psnr:+psnr.toFixed(2), lossless: psnr===99 };
    }, W, H);

    const ok1 = out.codec && out.codec.fmt===cfg.fmt && out.codec.type===cfg.type
             && out.codec.ext===cfg.ext && out.codec.lossless===cfg.lossless;
    check(`${cfg.label}: resolves`, ok1,
      out.codec ? `fmt=${out.codec.fmt} type=${out.codec.type} ext=.${out.codec.ext} q=${out.codec.quality}` : 'no codec');
    check(`${cfg.label}: worker emits that type`, out.blobType===cfg.type,
      `${out.blobType}, ${(out.bytes/1048576).toFixed(2)} MB, PSNR ${out.psnr}`);
    if (cfg.lossless) {
      check(`${cfg.label}: descramble is bit-exact`, out.lossless===true, `PSNR vs descrambled reference = ${out.psnr} (99 = identical)`);
    } else {
      check(`${cfg.label}: sane lossy encode`, out.psnr>30 && out.psnr<99, `PSNR ${out.psnr} dB`);
    }
    await page.close();
  }

  await browser.close(); appSrv.close();
  const failed = results.filter(r=>!r.pass);
  fs.writeFileSync(path.join(__dirname,'image_codec_result.json'), JSON.stringify({results},null,2));
  console.log(failed.length ? '\n'+failed.length+' FAILED' : '\nALL '+results.length+' CHECKS PASSED');
  process.exit(failed.length?1:0);
})().catch(e=>{ console.error('FATAL', e); process.exit(1); });
