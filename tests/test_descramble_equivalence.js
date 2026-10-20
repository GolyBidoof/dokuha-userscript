// test_descramble_equivalence.js
//
// The descramble worker was rewritten to blit tiles with drawImage instead of
// round-tripping the frame through getImageData/putImageData. "Faster but
// subtly wrong" is the failure mode that matters, so this compares the SHIPPED
// worker against a reference implementation of the original algorithm over
// several tile geometries, and checks the new no-op short-circuit.
'use strict';
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const fs = require('fs');
const path = require('path');
const https = require('https');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');
const W = 1400, H = 2100, Q = 0.92;

const appSrv = https.createServer(
  { key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')) },
  (req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body></body></html>'); });
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The original algorithm, kept here as the reference. Tiles are passed IN so
// this worker needs none of the A9p/B2y machinery.
const REFERENCE = `
self.onmessage = async (ev) => {
  const { blob, tiles, seeds, W, H, q } = ev.data;
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  // The original guards the whole pixel pass on noDescramble — preserve that,
  // or the reference "fixes" pages the shipped worker correctly leaves alone.
  if (!seeds.noDescramble) {
    const src = ctx.getImageData(0, 0, W, H).data;
    const out = new Uint8ClampedArray(src.length);
    const stride = W * 4;
    for (const t of tiles) {
      const sx = t.destX, sy = t.destY, dx = t.srcX, dy = t.srcY, tw = t.width, th = t.height;
      const srcRow = sy * stride + sx * 4, dstRow = dy * stride + dx * 4, len = tw * 4;
      for (let r = 0; r < th; r++) out.set(src.subarray(srcRow + r*stride, srcRow + r*stride + len), dstRow + r*stride);
    }
    ctx.putImageData(new ImageData(out, W, H), 0, 0);
  }
  let outCanvas = canvas;
  const S = seeds.Size;
  if (S && S.Width && S.Height && (W !== S.Width || H !== S.Height)) {
    outCanvas = new OffscreenCanvas(S.Width, S.Height);
    outCanvas.getContext('2d').drawImage(canvas, 0, 0);
  }
  const ob = await outCanvas.convertToBlob({ type: 'image/jpeg', quality: q });
  self.postMessage({ blob: ob });
};
`;

const CASES = [
  { name: 'tiles 256, integer grid     ', seeds: { b8A: 256, b6V: 256, B0J: 1, B0K: 2, B0n: 3, B0A: 4 } },
  { name: 'tiles 256, odd remainder    ', seeds: { b8A: 301, b6V: 197, B0J: 11, B0K: 22, B0n: 33, B0A: 44 } },
  { name: 'tiles 128, many small tiles ', seeds: { b8A: 128, b6V: 128, B0J: 5, B0K: 6, B0n: 7, B0A: 8 } },
  { name: 'tiles 512, few large tiles  ', seeds: { b8A: 512, b6V: 512, B0J: 9, B0K: 3, B0n: 1, B0A: 2 } },
  { name: 'same grid, other seeds      ', seeds: { b8A: 256, b6V: 256, B0J: 77, B0K: 88, B0n: 99, B0A: 12 } },
  { name: 'rescaled output (700x1050)  ', seeds: { b8A: 256, b6V: 256, B0J: 1, B0K: 2, B0n: 3, B0A: 4, Size: { Width: 700, Height: 1050 } } },
];

(async () => {
  const appPort = await listen(appSrv);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'] });
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto('https://127.0.0.1:' + appPort + '/?bwddDebug=1');
  await page.addScriptTag({ content: loadUserscript() });
  await sleep(300);

  const results = [];
  const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };

  const shippedSrc = await page.evaluate(() => window.__bwdd.buildWorkerSource());

  // Regression: the main-thread prefetcher (including bridge proxy lanes) must
  // hand its Blob to the worker. If that field is omitted, workerMain quietly
  // downloads the same page again through the workers' shared six-socket CDN
  // origin, making the fetch bar finish long before descrambling does.
  const handoff = await page.evaluate(async () => {
    const NativeWorker = window.Worker;
    const NativeTimeout = window.setTimeout;
    const sent = [];
    const completions = [];
    class FakeWorker {
      constructor() { this.busy = false; this.jobIds = []; FakeWorker.instances.push(this); }
      postMessage(message) { sent.push(message); }
      terminate() { this.terminated = true; }
    }
    FakeWorker.instances = [];
    window.Worker = FakeWorker;
    let timeoutCall = 0;
    window.setTimeout = (fn, ms, ...args) => NativeTimeout(
      fn, timeoutCall++ === 0 ? 15 : 250, ...args);
    try {
      const blobA = new Blob(['prefetched page A'], { type: 'image/jpeg' });
      const blobB = new Blob(['prefetched page B'], { type: 'image/jpeg' });
      const done = result => completions.push(result);
      const pool = window.__bwdd.makePool(1, 'worker source', done, 1000);
      const common = {
        relPath: 'page.jpeg', seeds: {}, auth: { Policy: 'secret' }, baseUrl: 'https://cdn.example/',
        q: 0.92, fmt: 'image/jpeg', _resolve() {},
      };
      // The default batch is two. These submissions must be coalesced before pump.
      pool.submit({ ...common, id: 7, blob: blobA });
      pool.submit({ ...common, id: 8, blob: blobB });
      await new Promise(r => NativeTimeout(r, 0));
      const envelope = sent[0];
      const jobs = envelope && envelope.jobs || [];
      const firstWorker = FakeWorker.instances[0];
      // Let page 7 time out, then finish page 8, then deliver page 7's stale
      // result. Only the timed-out ID may fail; late work is ignored.
      await new Promise(r => NativeTimeout(r, 30));
      if (jobs.length === 2) {
        firstWorker.onmessage({ data: {
          batchId: envelope.batchId,
          result: { id: 8, blob: new Blob(['done B'], { type: 'image/jpeg' }) },
        } });
        firstWorker.onmessage({ data: {
          batchId: envelope.batchId,
          result: { id: 7, blob: new Blob(['late A'], { type: 'image/jpeg' }) },
        } });
      }
      await new Promise(r => NativeTimeout(r, 20));
      pool.terminate();
      return {
        messages: sent.length,
        jobCount: jobs.length,
        hasBlob: jobs.length === 2 && jobs.every(job => !!job.blob),
        sameBlob: jobs.length === 2 && jobs[0].blob === blobA && jobs[1].blob === blobB,
        leakedResolve: jobs.some(job => Object.prototype.hasOwnProperty.call(job, '_resolve')),
        leakedAuth: jobs.some(job => Object.prototype.hasOwnProperty.call(job, 'auth')),
        oldWorkerRetired: !!firstWorker.terminated,
        completions,
      };
    } finally {
      window.setTimeout = NativeTimeout;
      window.Worker = NativeWorker;
    }
  });
  check('two prefetched Blobs share one worker batch without duplicate fetches',
    handoff.messages === 1 && handoff.jobCount === 2 && handoff.hasBlob && handoff.sameBlob,
    `messages=${handoff.messages} jobs=${handoff.jobCount} blobs=${handoff.hasBlob}/${handoff.sameBlob}`);
  check('batch clones omit secrets and a timed-out page cannot discard its sibling',
    !handoff.leakedResolve && !handoff.leakedAuth && handoff.oldWorkerRetired && handoff.completions.length === 2 &&
      handoff.completions.some(r => r.id === 7 && r.error === 'timeout') &&
      handoff.completions.some(r => r.id === 8 && r.blob),
    `leakedResolve=${handoff.leakedResolve} leakedAuth=${handoff.leakedAuth} retired=${handoff.oldWorkerRetired} completions=${JSON.stringify(handoff.completions.map(r => ({ id: r.id, ok: !!r.blob, error: r.error })))}`);

  const info = await page.evaluate(async (W, H) => {
    const c = new OffscreenCanvas(W, H);
    const x = c.getContext('2d');
    const img = x.createImageData(W, H);
    for (let i = 0; i < img.data.length; i += 4) {
      const p = i >> 2;
      img.data[i] = (p * 7) & 255; img.data[i+1] = (p * 13) & 255; img.data[i+2] = (p * 29) & 255; img.data[i+3] = 255;
    }
    x.putImageData(img, 0, 0);
    // Asymmetric marks: any tile landing in the wrong place changes the hash.
    x.fillStyle = '#f00'; x.fillRect(0, 0, 37, 53);
    x.fillStyle = '#0f0'; x.fillRect(W - 91, 11, 91, 400);
    x.fillStyle = '#00f'; x.fillRect(13, H - 77, 400, 77);
    window.__b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    return { size: window.__b.size };
  }, W, H);
  console.log(`source JPEG ${(info.size / 1048576).toFixed(2)} MB, ${W}x${H}\n`);

  async function run(code, seeds, useTiles) {
    return await page.evaluate(async (code, seeds, useTiles, W, H, q) => {
      const blob = window.__b;
      const tiles = useTiles ? window.__bwdd.A9p(seeds, W, H) : null;
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const w = new Worker(url);
      const data = await new Promise((resolve) => {
        w.onmessage = (ev) => resolve(ev.data);
        w.onerror = (e) => resolve({ error: String((e && e.message) || e) });
        w.postMessage({ id: 1, blob, seeds, tiles, q, W, H });
      });
      w.terminate(); URL.revokeObjectURL(url);
      if (!data || data.error) return { error: (data && data.error) || 'no message' };
      if (!data.blob) return { error: 'worker returned no blob' };
      const u = new Uint8Array(await data.blob.arrayBuffer());
      let h = 2166136261 >>> 0;
      for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
      return { hash: h, bytes: u.length };
    }, code, seeds, useTiles, W, H, Q);
  }

  async function runBatch(code, seedA, seedB) {
    return await page.evaluate(async (code, seedA, seedB, W, H, q) => {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const w = new Worker(url);
      const byId = {};
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('batch timeout')), 20000);
        w.onmessage = (ev) => {
          const result = ev.data && ev.data.result;
          if (!result) return;
          byId[result.id] = result;
          if (byId[1] && byId[2]) { clearTimeout(timer); resolve(); }
        };
        w.onerror = (e) => { clearTimeout(timer); reject(new Error(String((e && e.message) || e))); };
        w.postMessage({ batchId: 99, jobs: [
          { id: 1, blob: window.__b, seeds: seedA, q, needCrc: true },
          { id: 2, blob: window.__b, seeds: seedB, q, needCrc: true },
        ] });
      });
      w.terminate(); URL.revokeObjectURL(url);
      const hashBlob = async (blob) => {
        if (!blob) return null;
        const u = new Uint8Array(await blob.arrayBuffer());
        let h = 2166136261 >>> 0;
        for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
        return { hash: h, bytes: u.length };
      };
      const oneBlob = byId[1] && byId[1].blob;
      const twoBlob = byId[2] && byId[2].blob;
      return {
        one: await hashBlob(oneBlob),
        two: await hashBlob(twoBlob),
        crcOne: byId[1] && byId[1].crc,
        expectedCrcOne: oneBlob ? window.__bwdd.crc32Bytes(await oneBlob.arrayBuffer()) : null,
        crcTwo: byId[2] && byId[2].crc,
        expectedCrcTwo: twoBlob ? window.__bwdd.crc32Bytes(await twoBlob.arrayBuffer()) : null,
      };
    }, code, seedA, seedB, W, H, Q);
  }

  let allMatch = true;
  for (const c of CASES) {
    const ref = await run(REFERENCE, c.seeds, true);
    const ship = await run(shippedSrc, c.seeds, false);
    const same = !ref.error && !ship.error && ref.hash === ship.hash && ref.bytes === ship.bytes;
    if (!same) allMatch = false;
    check(c.name + ' byte-identical', same,
      ref.error ? 'reference error: ' + ref.error
        : ship.error ? 'shipped error: ' + ship.error
          : `ref ${ref.hash}/${ref.bytes}B  shipped ${ship.hash}/${ship.bytes}B`);
  }

  const batchA = await runBatch(shippedSrc, CASES[0].seeds, CASES[1].seeds);
  const batchRefA = await run(REFERENCE, CASES[0].seeds, true);
  const batchRefB = await run(REFERENCE, CASES[1].seeds, true);
  check('two concurrent pages in one worker stay byte-identical and precompute ZIP CRC',
    batchA.one && batchA.two && batchA.one.hash === batchRefA.hash && batchA.one.bytes === batchRefA.bytes &&
      batchA.two.hash === batchRefB.hash && batchA.two.bytes === batchRefB.bytes &&
      batchA.crcOne === batchA.expectedCrcOne && batchA.crcTwo === batchA.expectedCrcTwo,
    `A ${JSON.stringify(batchA.one)}/${batchA.crcOne} vs ${JSON.stringify(batchRefA)}; B ${JSON.stringify(batchA.two)}/${batchA.crcTwo} vs ${JSON.stringify(batchRefB)}`);

  const origHash = await page.evaluate(async () => {
    const u = new Uint8Array(await window.__b.arrayBuffer());
    let h = 2166136261 >>> 0;
    for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
    return { hash: h, bytes: u.length };
  });
  const noop = await run(shippedSrc, { noDescramble: true, Size: null }, false);
  check('an unscrambled page is returned untouched (no re-encode)',
    noop.hash === origHash.hash && noop.bytes === origHash.bytes,
    `original ${origHash.hash}/${origHash.bytes}B  shipped ${noop.hash}/${noop.bytes}B`);

  // ...but a no-op page that still needs a resize must go through the pipeline
  const noopScaled = await run(shippedSrc, { noDescramble: true, Size: { Width: 700, Height: 1050 } }, false);
  const refScaled = await run(REFERENCE, { noDescramble: true, Size: { Width: 700, Height: 1050 } }, true);
  check('an unscrambled page that needs a resize still rescales',
    !refScaled.error && !noopScaled.error && refScaled.hash === noopScaled.hash,
    `ref ${refScaled.hash}  shipped ${noopScaled.hash}`);

  const zipCheck = await page.evaluate(async () => {
    const bytes = new TextEncoder().encode('123456789');
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const crc = window.__bwdd.crc32Bytes(bytes);
    const precomputed = await window.__bwdd.buildStoreZip([
      { path: 'page-0001.jpg', blob, crc },
      { path: 'page-0002.jpg', blob, crc },
    ]);
    const fallback = await window.__bwdd.buildStoreZip([
      { path: 'page-0001.jpg', blob },
      { path: 'page-0002.jpg', blob },
    ]);
    const a = new Uint8Array(await precomputed.arrayBuffer());
    const b = new Uint8Array(await fallback.arrayBuffer());
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) same = a[i] === b[i];
    const dv = new DataView(a.buffer);
    return {
      same,
      size: a.length,
      signature: dv.getUint32(0, true),
      method: dv.getUint16(8, true),
      crc: dv.getUint32(14, true),
      expectedCrc: crc,
      payloadSize: dv.getUint32(18, true),
    };
  });
  check('store ZIP is byte-identical with precomputed worker CRC',
    zipCheck.same && zipCheck.signature === 0x04034b50 && zipCheck.method === 0 &&
      zipCheck.crc === zipCheck.expectedCrc && zipCheck.payloadSize === 9,
    JSON.stringify(zipCheck));

  await browser.close(); appSrv.close();
  const failed = results.filter(r => !r.pass);
  fs.writeFileSync(path.join(__dirname, 'descramble_equiv_result.json'), JSON.stringify({ cases: CASES.length, allMatch, results }, null, 2));
  console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
