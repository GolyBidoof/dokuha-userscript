// test_mokuro_client.js — the wire protocol between the userscript and
// mokuro-bridge, pinned against a stand-in bridge.
//
// The client is the half of the integration that a live bridge cannot prove in
// CI: the exact multipart fields, the meaning of a per-page 409, the finalize
// parameters, every NDJSON frame the current bridge emits, and the failure modes
// (an error frame, a stream that ends without `done`, a rejected finalize). The
// stand-in below emulates mokuro-bridge 0.9 (`docs/endpoints.md`,
// `docs/clients.md`) and records what the script actually sent.
//
// The hardcoded bridge URL is substituted as a test fixture only, like the rest
// of the suite: the shipped file keeps http://127.0.0.1:62642.
'use strict';
const puppeteer = require('puppeteer');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
const US = path.resolve(__dirname, '..', process.env.BWDD_US || 'dokuha-userscript.user.js');

const results = [];
const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

const stub = {
  requests: [],
  pageModes: new Map(),        // filename -> [{status, detail, alreadyPresent}, ...]
  finalizeMode: 'success',
  finalizeRequests: 0,
  start: null,
  lastFinalize: null,
  covers: [],
  health: {
    app: 'mokuro-bridge', version: '0.9.0', status: 'ok', busy: false,
    output_dir: '/tmp/bwdd-out', upload_method_default: 'mega',
    fetchProxyPorts: [], fetchUpstreams: ['*'], fetchPathUpstream: true,
    upload_methods: [
      { id: 'local', name: 'Local', configured: true, default: false, current_folder: '/tmp/bwdd-out' },
      { id: 'mega', name: 'MEGA', configured: true, default: true, current_folder: '/MEGA' },
    ],
  },
  uploadMethods: {
    upload_method_default: 'mega',
    upload_method_selected: null,
    methods: [
      { id: 'local', name: 'Local', configured: true, default: false, current_folder: '/tmp/bwdd-out' },
      { id: 'mega', name: 'MEGA', configured: true, default: true, current_folder: '/MEGA' },
    ],
  },
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Minimal multipart reader: enough for FastAPI's FormData shape, and byte-exact
// about the uploaded file because the page blob's size is what the wire carries.
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return { fields: {}, files: [] };
  const boundary = '--' + (m[1] || m[2]).trim();
  const text = buf.toString('binary');
  const fields = {};
  const files = [];
  for (const part of text.split(boundary).slice(1, -1)) {
    const body = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const sep = body.indexOf('\r\n\r\n');
    if (sep < 0) continue;
    const head = body.slice(0, sep);
    const data = body.slice(sep + 4).replace(/\r\n$/, '');
    const name = (/name="([^"]*)"/.exec(head) || [])[1] || '';
    const filename = (/filename="([^"]*)"/.exec(head) || [])[1];
    if (filename != null) files.push({ name, filename, size: Buffer.from(data, 'binary').length });
    else fields[name] = Buffer.from(data, 'binary').toString('utf8');
  }
  return { fields, files };
}

function frame(obj) { return JSON.stringify(obj) + '\n'; }

async function streamFrames(res, frames, opts) {
  opts = opts || {};
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  for (const f of frames) {
    if (f.split) {
      // Deliver one frame in two chunks, with a pause, so the client's line
      // buffering is exercised the way a slow upload splits it. Written one
      // frame at a time so the chunks stay in stream order, which is what a
      // real bridge guarantees.
      const line = frame(f.split);
      const cut = Math.floor(line.length / 2);
      res.write(line.slice(0, cut));
      await sleep(45);
      res.write(line.slice(cut));
    } else {
      res.write(frame(f));
    }
  }
  if (opts.truncate) { res.end(); return; }
  await sleep(5);
  res.end();
}

function finalizeFrames(mode) {
  const base = [
    { stage: 'wait_ocr', message: 'Waiting for OCR queue (0 pending)…', pages_received: 10, pages_ocr_done: 10, pages_ocr_pending: 0, ocr_chunk_size: 8 },
    { stage: 'assemble', message: 'Assembling .mokuro from 10 OCR pages…' },
    { stage: 'pack', message: 'Packaging CBZ + cover…' },
  ];
  if (mode === 'error') {
    return base.concat([{ stage: 'error', message: 'OCR failed for 2 page(s); refusing to assemble an incomplete .mokuro', status: 'ocr_failed', pages_ocr_failed: 2 }]);
  }
  const uploadPlan = {
    stage: 'upload', message: 'Uploading to MEGA… (/MEGA/Test Vol 1)', series: 'Test Vol 1',
    remote_path: '/MEGA/Test Vol 1', mega_path: '/MEGA/Test Vol 1', method: 'mega',
    files: [
      { file: 'Test Vol 1.webp', total_bytes: 120 },
      { file: 'Test Vol 1.cbz', total_bytes: 9000 },
      { file: 'Test Vol 1.mokuro', total_bytes: 4000 },
    ],
  };
  const progress = {
    stage: 'upload_progress', message: 'Test Vol 1.cbz: 50.0%',
    upload: { file: 'Test Vol 1.cbz', bytes: 4500, total_bytes: 9000, current_bytes: 4500, percent: 50, speed_bps: 1048576, speed_human: '1.00 MiB/s', method: 'mega' },
    mega_path: '/MEGA/Test Vol 1', method: 'mega',
  };
  const uploaded = { stage: 'upload', message: 'Uploaded Test Vol 1.cbz', file: 'Test Vol 1.cbz', method: 'mega', url: 'https://mega.example/MEGA/Test%20Vol%201/Test%20Vol%201.cbz' };
  const seriesOk = { stage: 'series_json', message: 'Updating series.json…', file: 'series.json', remote_path: '/MEGA/Test Vol 1', ok: true };
  if (mode === 'local') {
    return [
      { stage: 'wait_ocr', message: 'OCR 10/10', pages_received: 10, pages_ocr_done: 10, pages_ocr_pending: 0 },
      { stage: 'assemble', message: 'Assembling .mokuro…' },
      { stage: 'pack', message: 'Saved local pack → /tmp/custom out/Test Vol 1', output_dir: '/tmp/custom out/Test Vol 1', series: 'Test Vol 1', files: ['Test Vol 1.webp', 'Test Vol 1.cbz', 'Test Vol 1.mokuro'] },
      { stage: 'series_json', message: 'Wrote series.json → /tmp/custom out/Test Vol 1', file: 'series.json', ok: true, output_dir: '/tmp/custom out/Test Vol 1' },
      { stage: 'done', message: 'Done! 10 pages OCR\'d → /tmp/custom out/Test Vol 1', status: 'success', title: 'Test Vol 1', series: 'Test Vol 1', pages: 10, output_dir: '/tmp/custom out/Test Vol 1', staging: '/tmp/custom out/Test Vol 1', remote_path: null, mega_path: null, uploads: [], reader_url: null, method: 'local' },
    ];
  }
  const done = {
    stage: 'done', message: 'Done! 10 pages OCR\'d and uploaded', status: mode === 'partial' ? 'partial_upload' : 'success',
    title: 'Test Vol 1', series: 'Test Vol 1', pages: 10, remote_path: '/MEGA/Test Vol 1', mega_path: '/MEGA/Test Vol 1',
    output_dir: null, staging: '/tmp/work/Test Vol 1',
    uploads: [
      { file: 'Test Vol 1.webp', bytes: 120, total_bytes: 120, current_bytes: 120, percent: 100, success: true, url: 'https://mega.example/a.webp' },
      { file: 'Test Vol 1.cbz', bytes: 9000, total_bytes: 9000, current_bytes: 9000, percent: 100, success: true, url: 'https://mega.example/b.cbz' },
      { file: 'series.json', bytes: 500, total_bytes: 500, current_bytes: mode === 'partial' ? 0 : 500, percent: mode === 'partial' ? 0 : 100, success: mode !== 'partial', url: mode === 'partial' ? null : 'https://mega.example/series.json' },
    ],
    reader_url: 'https://reader.mokuro.app/?library=1', method: 'mega',
  };
  if (mode === 'partial') {
    done.message = 'MEGA upload partially completed: series.json: permission denied';
  }
  return base.concat([uploadPlan, { split: progress }, uploaded, seriesOk, done]);
}

const bridge = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = req.url.split('?')[0];
  const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
  const form = req.method === 'POST' ? parseMultipart(body, req.headers['content-type']) : { fields: {}, files: [] };
  stub.requests.push({ method: req.method, url, fields: form.fields, files: form.files.map(f => ({ name: f.name, filename: f.filename, size: f.size })) });

  if (req.method === 'GET' && url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(stub.health));
    return;
  }
  if (req.method === 'GET' && url === '/upload-methods') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(stub.uploadMethods));
    return;
  }
  if (req.method === 'POST' && url === '/session/start') {
    stub.start = form;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ session_id: 'sess-1', safe_title: 'Test Vol 1', title: 'Test Vol 1', ocr_chunk_size: 8 }));
    return;
  }
  if (req.method === 'POST' && url === '/session/sess-1/cover') {
    stub.covers.push(form);
    const size = form.files.length ? form.files[0].size : 0;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true, method: form.fields.upload_method || 'local', file: 'Test Vol 1.webp',
      remote_path: '/MEGA/Test Vol 1', url: 'https://mega.example/Test%20Vol%201/Test%20Vol%201.webp', size,
    }));
    return;
  }
  if (req.method === 'POST' && url === '/session/sess-1/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ session_id: 'sess-1', pages_received: 10, pages_ocr_done: 10, busy: false }));
    return;
  }
  if (req.method === 'POST' && url === '/session/sess-1/finalize') {
    stub.finalizeRequests++;
    stub.lastFinalize = form;
    if (stub.finalizeMode === 'reject') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ detail: 'unknown upload account: nope (available: local, mega)' }));
      return;
    }
    if (stub.finalizeMode === 'truncated') {
      await streamFrames(res, finalizeFrames('success').slice(0, 2), { truncate: true });
      return;
    }
    await streamFrames(res, finalizeFrames(stub.finalizeMode));
    return;
  }
  const pageMatch = /^\/session\/sess-1\/page$/.test(url);
  if (req.method === 'POST' && pageMatch) {
    const filename = form.fields.filename || '';
    const queue = stub.pageModes.get(filename) || [{ status: 200 }];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next.status === 200) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        session_id: 'sess-1', filename, page_num: Number(form.fields.page_num) || 0,
        pages_received: 1, pages_ocr_done: 0,
        ...(next.alreadyPresent ? { already_present: true } : {}),
      }));
      return;
    }
    res.statusCode = next.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ detail: next.detail }));
    return;
  }
  res.statusCode = 404;
  res.end('nope');
});

const appSrv = https.createServer(
  { key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')) },
  (req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html><body></body></html>'); });
const listen = (s) => new Promise((resolve, reject) => s.listen(0, '127.0.0.1', () => resolve(s.address().port)).on('error', reject));

(async () => {
  const bridgePort = await listen(bridge);
  const appPort = await listen(appSrv);
  const APP = 'https://127.0.0.1:' + appPort + '/?bwddDebug=1';

  const src = fs.readFileSync(US, 'utf8');
  const patched = src.replace("'http://127.0.0.1:62642'", "'http://127.0.0.1:" + bridgePort + "'");
  if (patched === src) throw new Error('bridge URL substitution failed');
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'],
  });
  let page;
  try {
    page = await browser.newPage();
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 180)));
    await page.goto(APP);
    await page.addScriptTag({ content: patched });
    await page.waitForFunction(() => !!(window.__bwdd && window.__bwdd.mokuroClient), { timeout: 8000 });
    await sleep(300);

    // --- discovery ---------------------------------------------------------
    const plan = await page.evaluate(() => window.__bwdd.mokuroClient.uploadPlan());
    check('the upload plan prefers the bridge\'s configured sticky default',
      plan && plan.method === 'mega' && plan.folder === '/MEGA',
      JSON.stringify(plan));
    check('health and upload-methods were read before the plan was chosen',
      stub.requests.some(r => r.url === '/health') && stub.requests.some(r => r.url === '/upload-methods'),
      stub.requests.map(r => r.url).filter(u => /health|upload-methods/.test(u)).join(', '));

    // --- session start -----------------------------------------------------
    const session = await page.evaluate(() => window.__bwdd.mokuroClient.startSession('Test Vol 1'));
    check('session start posts the title and returns session_id',
      session && session.session_id === 'sess-1' && stub.start && stub.start.fields.title === 'Test Vol 1',
      `session=${session && session.session_id} title=${stub.start && stub.start.fields.title}`);

    // --- page pushes -------------------------------------------------------
    const pushed = await page.evaluate(() => window.__bwdd.mokuroClient.streamPage(
      'sess-1', new Blob([new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,1])], {type:'image/jpeg'}), 'page-0001.jpg', 1));
    const pageReq = stub.requests.filter(r => r.url === '/session/sess-1/page').pop();
    check('a page is one multipart POST with page, filename and page_num',
      pushed && pushed.filename === 'page-0001.jpg' && pageReq &&
      pageReq.files.some(f => f.name === 'page' && f.size === JPEG.length) &&
      pageReq.fields.filename === 'page-0001.jpg' && pageReq.fields.page_num === '1',
      `file=${pageReq && pageReq.files.map(f => f.name + ':' + f.size).join(',')} fields=${JSON.stringify(pageReq && pageReq.fields)}`);

    stub.pageModes.set('cached.jpg', [{ status: 409, detail: 'Page already has completed OCR: cached.jpg' }]);
    const cached = await page.evaluate(() => window.__bwdd.mokuroClient.streamPage(
      'sess-1', new Blob([new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,1])], {type:'image/jpeg'}), 'cached.jpg', 2));
    check('a 409 "already has completed OCR" is a cache hit, not a failure',
      cached && cached.cached === true && cached.already_present === true,
      JSON.stringify(cached));

    stub.pageModes.set('present.jpg', [{ status: 200, alreadyPresent: true }]);
    const present = await page.evaluate(() => window.__bwdd.mokuroClient.streamPage(
      'sess-1', new Blob([new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,1])], {type:'image/jpeg'}), 'present.jpg', 3));
    check('200 with already_present:true is reported as cached',
      present && present.cached === true, JSON.stringify(present));

    stub.pageModes.set('busy.jpg', [
      { status: 409, detail: "Page is currently being OCR'd: busy.jpg" },
      { status: 200 },
    ]);
    const busy = await page.evaluate(() => window.__bwdd.mokuroClient.streamPage(
      'sess-1', new Blob([new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,1])], {type:'image/jpeg'}), 'busy.jpg', 4));
    const busyRequests = stub.requests.filter(r => r.fields && r.fields.filename === 'busy.jpg');
    check('a "currently being OCR\'d" 409 is retried and then accepted',
      busy && busy.filename === 'busy.jpg' && busyRequests.length === 2,
      `requests=${busyRequests.length}`);

    stub.pageModes.set('conflict.jpg', [{ status: 409, detail: 'Image filename stem already exists with another extension' }]);
    const conflict = await page.evaluate(async () => {
      try {
        await window.__bwdd.mokuroClient.streamPage('sess-1', new Blob([new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,1])], {type:'image/jpeg'}), 'conflict.jpg', 5);
        return { ok: true };
      } catch (e) { return { ok: false, status: e.status, message: String(e.message) }; }
    });
    check('a real 409 conflict (stem collision) is thrown with the bridge detail',
      conflict && conflict.ok === false && conflict.status === 409 && /stem already exists/.test(conflict.message),
      JSON.stringify(conflict));

    // --- early cover -------------------------------------------------------
    const cover = await page.evaluate(() => window.__bwdd.mokuroClient.uploadCover(
      'sess-1', new Blob([new Uint8Array([255,216,255,224,0,16,74,70,73,70,0,1])], {type:'image/jpeg'}), {method:'mega'}));
    const coverReq = stub.covers[stub.covers.length - 1];
    check('the early cover posts cover bytes plus the chosen destination',
      cover && cover.ok === true && cover.size === JPEG.length &&
      coverReq && coverReq.fields.upload_method === 'mega' &&
      coverReq.files.some(f => f.name === 'cover' && f.size === JPEG.length),
      JSON.stringify({ cover, fields: coverReq && coverReq.fields }));

    // --- finalize: the current 0.9 stream ---------------------------------
    stub.finalizeMode = 'success';
    const fin = await page.evaluate(async () => {
      const stages = [], uploads = [];
      const result = await window.__bwdd.mokuroClient.finalize('sess-1',
        { method: 'mega', overwrite: 'overwrite' },
        (stage, msg) => stages.push({ stage, files: msg && msg.files ? msg.files.length : null }),
        ev => uploads.push(ev));
      return { result, stages, uploads };
    });
    const fFields = stub.lastFinalize && stub.lastFinalize.fields;
    check('finalize sends upload_method, delete_after_upload and overwrite',
      fFields && fFields.upload_method === 'mega' && fFields.delete_after_upload === 'true' && fFields.overwrite === 'overwrite',
      JSON.stringify(fFields));
    check('every current finalize frame reaches the caller in order',
      fin.stages.map(s => s.stage).join(',') === 'wait_ocr,assemble,pack,upload,upload_progress,upload,series_json,done',
      fin.stages.map(s => s.stage).join(','));
    check('the upload plan frame seeds the bar with every file',
      fin.stages.find(s => s.stage === 'upload').files === 3,
      'seeded=' + (fin.stages.find(s => s.stage === 'upload') || {}).files);
    const up = fin.uploads.find(u => u.file === 'Test Vol 1.cbz') || {};
    check('upload_progress maps to bytes, percent, speed, method and remote path',
      up.currentBytes === 4500 && up.totalBytes === 9000 && up.percent === 50 &&
      up.speed === '1.00 MiB/s' && up.method === 'mega' && up.remotePath === '/MEGA/Test Vol 1',
      JSON.stringify(up));
    check('a frame split across chunks is not lost',
      fin.uploads.some(u => u.file === 'Test Vol 1.cbz'), 'frames=' + fin.uploads.length);
    check('done keeps output, reader URL and per-file URLs, preferring the .cbz',
      fin.result && fin.result.status === 'success' &&
      fin.result.reader_url === 'https://reader.mokuro.app/?library=1' &&
      fin.result.uploadUrls.length === 4 && /\.cbz$/.test(fin.result.storedUrl || '') &&
      fin.result.partialUpload !== true,
      JSON.stringify({ status: fin.result && fin.result.status, urls: fin.result && fin.result.uploadUrls, stored: fin.result && fin.result.storedUrl }));

    // --- finalize: partial_upload -----------------------------------------
    stub.finalizeMode = 'partial';
    const partial = await page.evaluate(() => window.__bwdd.mokuroClient.finalize('sess-1', { method: 'mega' }));
    check('a done frame with partial_upload is surfaced, not reported as success',
      partial && partial.status === 'partial_upload' && partial.partialUpload === true &&
      /partially completed/.test(partial.message || ''),
      JSON.stringify({ status: partial && partial.status, partial: partial && partial.partialUpload }));

    // --- finalize: failure modes ------------------------------------------
    stub.finalizeMode = 'truncated';
    const truncated = await page.evaluate(async () => {
      try { await window.__bwdd.mokuroClient.finalize('sess-1', { method: 'mega' }); return { ok: true }; }
      catch (e) { return { ok: false, message: String(e.message) }; }
    });
    check('a stream that ends without done is a truncated upload',
      truncated && truncated.ok === false && /without a terminal done frame/.test(truncated.message),
      JSON.stringify(truncated));

    stub.finalizeMode = 'error';
    const errorFrame = await page.evaluate(async () => {
      try { await window.__bwdd.mokuroClient.finalize('sess-1', { method: 'mega' }); return { ok: true }; }
      catch (e) { return { ok: false, status: e.status, message: String(e.message) }; }
    });
    check('an error frame throws with the bridge\'s machine-readable status',
      errorFrame && errorFrame.ok === false && errorFrame.status === 'ocr_failed' && /OCR failed/.test(errorFrame.message),
      JSON.stringify(errorFrame));

    stub.finalizeMode = 'reject';
    const before = stub.finalizeRequests;
    const rejected = await page.evaluate(async () => {
      try { await window.__bwdd.mokuroClient.finalize('sess-1', { method: 'nope' }); return { ok: true }; }
      catch (e) { return { ok: false, status: e.status, message: String(e.message) }; }
    });
    check('a rejected finalize reports the bridge\'s reason instead of a closed stream',
      rejected && rejected.ok === false && rejected.status === 400 && /unknown upload account/.test(rejected.message),
      JSON.stringify(rejected));
    check('a rejected finalize is not silently retried to another destination',
      stub.finalizeRequests - before === 1, 'requests=' + (stub.finalizeRequests - before));

    // --- finalize: local mode ---------------------------------------------
    stub.finalizeMode = 'local';
    const local = await page.evaluate(async () => {
      const stages = [];
      const client = window.__bwdd.mokuroClient;
      const result = await client.finalize('sess-1', { method: 'local', localDir: '/tmp/custom out' },
        stage => stages.push(stage));
      return { result, readerUrl: client.readerJumpUrl(result), stages };
    });
    const lFields = stub.lastFinalize && stub.lastFinalize.fields;
    check('local finalize sends local_dir and no overwrite (safe default)',
      lFields && lFields.upload_method === 'local' && lFields.local_dir === '/tmp/custom out' &&
      lFields.delete_after_upload === 'true' && lFields.overwrite == null,
      JSON.stringify(lFields));
    check('local done reports the output folder and falls back to the reader home',
      local.result && local.result.output_dir === '/tmp/custom out/Test Vol 1' &&
      local.readerUrl === 'https://reader.mokuro.app/' &&
      local.stages.indexOf('pack') !== -1 && local.stages.indexOf('done') !== -1,
      JSON.stringify({ output: local.result && local.result.output_dir, readerUrl: local.readerUrl }));

    // --- finalize: legacy upload_to_mega ----------------------------------
    stub.finalizeMode = 'success';
    await page.evaluate(() => window.__bwdd.mokuroClient.finalize('sess-1', { forceMega: true }));
    const legacyFields = stub.lastFinalize && stub.lastFinalize.fields;
    check('the legacy upload_to_mega flag is sent when no method is known',
      legacyFields && legacyFields.upload_to_mega === 'true' && legacyFields.upload_method == null,
      JSON.stringify(legacyFields));
  } finally {
    if (page) await page.close().catch(() => {});
    await browser.close().catch(() => {});
    bridge.close();
    appSrv.close();
  }

  const failed = results.filter(r => !r.pass);
  fs.writeFileSync(path.join(__dirname, 'mokuro_client_result.json'),
    JSON.stringify({ results, requests: stub.requests.map(r => ({ method: r.method, url: r.url, fields: r.fields })) }, null, 2));
  console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
