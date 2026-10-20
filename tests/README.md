# Tests

Most of the suite loads the built userscript into headless Chrome against local stub servers; a few files are pure Node checks. The artifact on disk is what is driven, so run `npm run build` first, or `npm run check:build` to see whether it is stale. The live-store run and the bridge benchmark are opt-in.

```sh
npm install          # puppeteer
npm run browser      # one-time Chrome download for puppeteer
npm test             # the hermetic suite, 37 of the 38 test files
node tests/run.js lane   # only files whose name contains "lane"
npm run test:bridge  # opt-in bridge fetch-proxy benchmark (needs a mokuro-bridge
                     # checkout; set MOKURO_BRIDGE_DIR if it is not at
                     # ~/Projects/mokuro-bridge)
```

Each script prints `ALL n CHECKS PASSED` on success and exits non-zero otherwise, so a file works on its own (`node tests/test_lanes.js`) or through `npm test`. `tests/run.js` fails a file unless it both exits zero and prints that line. There are 38 `test_*.js` files here; `npm test` runs every one except the opt-in `test_bridge_e2e.js`.

| File | Covers |
| --- | --- |
| `test_artifacts.js` | every built artifact compiles as a script and as a function body, carries exactly one metadata block, has no placeholder left and is not stale against `src/` |
| `test_split_builds.js` | every target in `src/targets.json`: header, version, reader-only match and connect lists, module isolation, and each artifact booted in Chrome on readers, storefronts and headless product pages |
| `test_site_dispatch.js` | reader-only adapter selection: every reader boots its adapter and capture, storefront pages select nothing, unclaimed hosts fall back to BookWalker, and headless product pages still claim their store |
| `test_lanes.js` | lane balance, manager-lane fallback, 403 recovery and inflight de-duplication |
| `test_dot_lane.js` | trailing-dot lane probing and fallback |
| `test_edge_lane.js` | the HTTP/2 edge-mirror lane against a local h2 server |
| `test_socket_budget.js` | the data-plane socket budget and its browser-profile cap |
| `test_upstream_path.js` | how a bridge lane is told which CDN to fetch, and what that costs in preflights |
| `test_proxy_parking.js` | a failing proxy parks its lanes instead of deleting them, and recovers after cooldown |
| `test_ticker.js` | hidden-tab timer throttling, and that the relayed progress poll keeps its cadence |
| `test_image_codec.js` | format and quality resolution, emitted mime type and file extension |
| `test_format_selection.js` | the chosen format reaching the bytes on the paths that used to pass the store's JPEG through, and the cached or bridge-bound page named after its real type |
| `test_ui_panel.js` | panel readout, popovers, format picker and the repository link |
| `test_run_safety.js` | the shared run harness takes the panel run lock for the whole run, and ebookjapan resolves a volume once at a time |
| `test_availability.js` | the cross-store "also available on" card for all six shops, including the DMM adapter's search, flight payload and BFF volume list, and the count-driven five-, six- and seven-pill layouts; skipped for an artifact that does not carry the module |
| `test_search_candidates.js` | the shared title-candidate builder: the original title stays first, a trailing imprint label such as `(サンプルコミックスDIGITAL)` gets a label-free variant, and `(上)`, `(下)` and a bare volume number are not mistaken for labels |
| `test_descramble_equivalence.js` | BookWalker worker output compared with reference pages, byte for byte |
| `test_bookwalker_naming.js` | BookWalker page names derived from the manifest source, and ZIP entry order across double-digit pages |
| `test_cmoa_adapter.js` | a full CMOA ZIP run against a synthetic speed reader: detection, title, naming, quality ladder and descramble |
| `test_cmoa_ocr.js` | the CMOA OCR path: session, page order and naming, early cover, finalize, descrambled bytes and host-scoped proxy ports |
| `test_cmoa_offline_descramble.js` | the viewer-free descramble engine |
| `test_cmoa_scramble_tables.js` | the ported scramble tables against a real content info response |
| `test_cmoa_descramble_required.js` | an unscrambled page is never reported as a finished page |
| `test_cmoa_pagecache_stall.js` | the page-cache stall that used to hold the progress bar short of the end |
| `test_cmoa_tail_hedge.js` | the slow tail of a real CMOA run |
| `test_ebookjapan_adapter.js` | the pinned wasm glue and its consumer, no browser needed |
| `test_ebookjapan_gm_lane.js` | reaching the bridge accelerator from a page whose CSP forbids loopback |
| `test_kindle_adapter.js` | the Kindle adapter against a synthetic render service: window walk, reading order and page cipher |
| `test_kmanga_protocol.js` | the BCP000 wire format against recorded frames |
| `test_kmanga_pipeline.js` | the pipelined page loop, with replies matched by scene |
| `test_kmanga_descramble.js` | a real k-manga page unscrambled on a canvas, scored by seam energy |
| `test_kmanga_title_page.js` | the title page's point prices and free-volume detection |
| `test_dmm_protocol.js` | DMM URL/auth paths, CloudFront cookie-to-query names, the 64×64 geometry, fan-out sizing, and the worker job envelope |
| `test_dmm_worker.js` | the real DMM worker source against a fake `OffscreenCanvas`: tile count, orientation, message ids and decode errors |
| `test_dmm_adapter.js` | the DMM adapter end to end against a local HTTPS stand-in for the viewer and its CDN: adapter selection, the cookie-to-signed-query manifest fetch, page count and resolution, a full ZIP run with the 64×64 geometry, the shared 403 auth refresh, page-cache resume and the tachiyomi sampler |
| `test_mokuro_client.js` | the mokuro-bridge wire protocol against a stand-in bridge: upload plan, session start, per-page multipart push, 409 cache hit versus conflict, finalize parameters, every NDJSON frame, partial upload, truncated stream and rejected finalize |
| `test_acceptance_oracle.js` | the oracle the live acceptance run rests on: store ZIP parsing and the cross-implementation page comparison |
| `test_bridge_e2e.js` | opt-in fetch-proxy benchmark against a throwaway bridge instance, plus a read-only health check of the running one |

`tests/acceptance/` is the live acceptance suite. It talks to real stores, so it is not collected by `npm test`; run it with `npm run test:acceptance` and see `tests/acceptance/README.md`.

`tests/_userscript.js` loads the built userscript for injection with the bridge URL pointed at a closed port. The suite has to be hermetic: with the real bridge running, its fetch-proxy ports would be discovered by every test page and mixed into the lane pool, turning distribution assertions into measurements of the bridge instead of the code. A test that wants a bridge supplies its own stub and passes `{ bridge: true }`.

`tests/tls/` holds a self-signed localhost certificate, used so the page can serve HTTPS (a secure context) while local stub servers stay on HTTP.

`test_cmoa_ocr.js` serves its synthetic storefront from a real local HTTPS server reached as `www.cmoa.jp` through Chrome's `--host-resolver-rules`, rather than fulfilling requests with puppeteer interception. That is deliberate: interception cannot relay a binary multipart upload faithfully (`postData()` is string-only, and the bridge uploads JPEGs), and it will not carry a public-origin to loopback hop at all, which is exactly the hop to the bridge.

The architecture these tests pin is described in [docs/architecture.md](../docs/architecture.md).
