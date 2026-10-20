# Architecture

This document explains how dokuha-userscript is built, how a download actually runs, and where the shared code ends and a store's own protocol begins. It is the deep reference behind [README.md](../README.md); [src/README.md](../src/README.md) is the file-by-file map.

## One artifact built from plain fragments

The shipped userscript is not bundled. `src/` holds ordered fragments of a single immediately invoked function expression, and `build.mjs` concatenates the fragments a target selects, in the order the fragment graph declares, then strips comments with a small lexer of its own. There is no module loader, no transpiler and no source map. The consequence is the useful part: the artifact is the source code with comments removed, line for line, so a reader can diff what they installed against the repository and a test can prove that the file on disk is exactly what `src/` currently produces.

Three files drive the build:

- `src/manifest.json` names every fragment, the module it belongs to, an optional `after` reference and a human note. `build.mjs` derives the load order from the `after` graph (Kahn's algorithm, manifest order breaking ties), so a store is a linked block and adding one never means splicing entries into the middle of a list.
- `src/targets.json` declares each artifact: output filename, metadata name and description, icon, `@match` list, `@connect` list, banner and the modules it includes. Every field is substituted into `src/_meta/00-header.txt`, so no artifact can claim a store its code cannot handle.
- `src/core/00-identity.js` holds the version literal and the repository URL. `build.mjs` substitutes the version into `@version`, `tools/bump.mjs` is the only writer, and `tests/test_artifacts.js` fails when an artifact and the source disagree.

Seven artifacts are built: the combined `dokuha-userscript.user.js` with all six stores and availability module, plus `bookwalker-only`, `cmoa-only`, `ebookjapan-only`, `kindle-only`, `kmanga-only` and `dmm-only`, each carrying the shared core and exactly one store module. `tests/test_split_builds.js` boots every artifact and inspects what it carries, so isolation is a tested property rather than a convention.

## The runtime at a glance

The entry fragment detects the current page once. A reader page selects its store's adapter, which installs the page hooks and then boots the shared panel. A storefront page on a host a store owns selects nothing, so the panel, the bridge probe and the traffic capture never run there. A host no store claims falls back to BookWalker, which is what makes an injected copy in tests or by the CLI useful. The headless path is the only deliberate non-reader entry: `window.__BWDD_HEADLESS__` and `window.__BWDD_CLI__` let a caller inject the script on a product page, and the automation API then drives it through `window.__bwddAutomation`.

Debug internals live behind `?bwddDebug`, which the test suite uses and normal pages never see.

## The pipeline in five stages

Every store follows the same shape, and only the middle differs.

1. **Capture.** Read the viewer's own state and, for BookWalker, passively record its network traffic. Nothing is requested from the CDN at this stage.
2. **Plan.** Turn that state into a complete page list before downloading anything, so the total, the page order and the archive names are known up front.
3. **Fetch.** Request every page at full resolution, in parallel, through every lane that can be opened. Retry ladders handle expired signatures, throttling and per-store refusals.
4. **Rebuild.** Reassemble each page offline: decrypt, unshuffle, decrypt and decode, or apply the store's cipher. Work happens on a canvas and, where the store allows it, in a worker pool.
5. **Deliver.** Save the pages as a ZIP, or stream them to a running mokuro-bridge while the capture is still going.

| Store | Capture source | Page list | Rebuild |
| --- | --- | --- | --- |
| BookWalker | viewer fetch and XHR traffic for the signed API, auth and encrypted manifest | decrypted `configuration_pack.json` | RC4-style envelope then the A9p tile permutation in a worker |
| CMOA | reader or viewer state, then the content info response | content info metadata | the viewer's BinB permutation over four scramble tables, on a canvas or in a worker |
| ebookjapan | viewer state, then the viewer's own `open_book` and `get_drm` calls | the viewer's book manifest | the viewer's wasm core on a page-realm canvas |
| Kindle | the reader's embedded `#bookInfo` JSON | `/renderer/render` TAR windows | AES-GCM for encrypted resources, otherwise the JPEG itself |
| k-manga | the viewer URL and the viewer WebSocket session | the viewer's BCP000 page list | block permutation on a canvas |
| DMMブックス | the viewer URL, then `/viewerapi/auth/` | `configuration_pack.json` | 64×64 tile permutation on a canvas |

Each store's protocol record lives with its code under `src/sites/<store>/README.md`: [BookWalker](../src/sites/bookwalker/README.md), [CMOA](../src/sites/cmoa/README.md), [ebookjapan](../src/sites/ebookjapan/README.md), [Kindle](../src/sites/kindle/README.md), [k-manga](../src/sites/kmanga/README.md), [DMMブックス](../src/sites/dmm/README.md).

## The cross-store availability card

The "also available on" card lives in `core/32-availability.js`, tagged module `feature/availability`, which only the combined artifact includes: the single-store builds carry neither its markup and CSS nor the storefront hosts it queries. Each store registers one adapter from `src/sites/<store>/40-availability.js` through `registerAvailabilityStore()` and supplies only what is true of that shop: its search URL, which of its paths are product pages, and how to read a volume row's price, free state and unit, plus any further list pages. The core owns the shared work: the scored title match, the per-series merge that turns volume rows into "which shops carry this series, at what price", the card markup and the count-driven layout. All six supported stores register an adapter, so the card asks six shops, and it appears as soon as the first one confirms the book, with a placeholder pill for every shop whose search is still in flight; a shop that does not carry the book gets no pill at all. DMMブックス is the newest of the six: its results page is server-rendered and one card stands for a whole series, so its adapter reads the per-volume rows out of the product page's Next.js flight payload and fills a truncated run from the store's own BFF volume list.

## The shared run harness

`core/61-run-harness.js` owns everything a run shows and everything that is not the store's protocol: the progress bars, the page accounting, the page cache, the OCR session lifecycle, ZIP assembly and naming, the result object and teardown. A store calls `notePage(index, blob, crc, ext)` for a page it rebuilt and `noteFailure(index, message)` for one it could not, and the harness keeps the two bars honest.

Five stores use the harness today: CMOA, ebookjapan, Kindle, k-manga and DMMブックス. BookWalker's full and trial pipelines predate it and keep their own bookkeeping; moving them onto the harness is the largest open refactor in the repository.

The harness also holds the panel's run lock and the browser's unload guard for the length of a run. Every fetched and descrambled page is in the tab's memory, and the finalize stream is a request that tab is reading, so a stray tab close would throw the run away. The lock is released in a `finally`, so a failed run cannot leave the panel disabled.

## Concurrency and lanes

Two independent limits shape throughput.

**Rebuild work** runs in a worker pool sized from `navigator.hardwareConcurrency`, clamped to between 4 and 16 workers. JPEG work batches two pages per worker because two overlapping codec jobs fit; lossless WebP and PNG use one, because their encoders cost far more memory and CPU. Each worker handles one store-defined job envelope, so the pool is shared while the message shape stays the store's own.

**Network work** is spread across lanes by `core/21-transport-pool.js`. A browser allows six HTTP/1.1 connections per origin, and an origin is scheme plus host plus port, so every distinct origin is six more sockets:

- the page lane, six sockets;
- the userscript manager's own background context (`GM_xmlhttpRequest`);
- a trailing-dot host, when the server accepts it, as an independent origin;
- an HTTP/2 edge mirror, which multiplexes many requests over one connection instead of six;
- every local fetch-proxy port a running mokuro-bridge advertises, each a separate origin.

The budget is the sum of those lanes capped at 240 sockets, which leaves the browser profile's 256-socket ceiling a reserve for the control plane. Sizing logic then decides how many fetches to keep in flight, and the health and burst modules back off after refusals instead of hammering a CDN that has started saying no. A JSON 403 from a proxy lane is the bridge refusing a host, not a CDN answer, and is treated as a lane failure so the request falls through to another lane.

## The bridge's fetch proxy lanes

A running mokuro-bridge doubles as a fetch accelerator. Its `/health` advertised `fetchProxyPorts` list names the localhost ports it bound, and each port is a fresh browser origin with six more sockets. The port is not a transparent forwarder: the bridge fetches the host named in the `x-bwdd-upstream` request header and refuses any host outside its `fetchUpstreams` allowlist with a JSON 403. The lane pool therefore tracks the advertised upstream list, opts a store in per host, and sends the header only when the host differs from the bridge's default upstream. A newer bridge also accepts the CDN as a path segment (`/_bwdd/<host>/<path>`), which keeps the request simple and avoids a preflight per page; `fetchPathUpstream` says whether that form is available.

None of this is required. With the bridge stopped there are no proxy lanes and the run proceeds on its own page, manager, dotted-host and edge lanes.

## Page cache and resume

Every rebuilt page is stored in an IndexedDB cache keyed by content id, page index, output mime type and quality, so changing the image format cannot reuse the wrong bytes. Entries are `{blob, ts}` with an optional CRC, a twenty minute TTL and a 4000-entry ceiling, pruned in the background. Reads sit in front of every fetch and are given a one second deadline: losing a cache hit there costs one re-fetch, while a stalled read would cost the page.

That cache is what makes resume work. A page already in the cache is counted, zipped and handed to OCR without a network request, and a run that was interrupted only fetches the pages it is missing. A clean run clears the cache on teardown; a failed run leaves it for the next attempt. A partial failure is reported as a named missing-page count instead of a silent short archive.

## Delivery

**ZIP.** `core/41-zip.js` is a dependency-free store-method ZIP writer. Pages land flat at the archive root as `page-0001.jpg` and so on, which is what manga readers and CBZ readers expect. No server and no upload are involved.

**Mokuro hand-off.** With a running mokuro-bridge, the same pages are streamed over HTTP while the capture is still going. The client opens a session, posts each page as multipart, posts the first page early as the volume cover, and then finalizes and reads an NDJSON progress stream to its terminal frame. The bridge assembles OCR output, packs the `.cbz`, `.mokuro` and cover `.webp` trio, writes the per-series `series.json` that reader.mokuro.app reads, and delivers to a local folder, MEGA, Google Drive, OneDrive, WebDAV or whichever other destination the bridge is configured for. A destination owned by mokuro-bunko gets the same volume files but keeps its own manifest, because bunko compiles that metadata itself.

The hand-off is optional in both directions. mokuro-bridge is an independent service in the mokuro ecosystem, not part of the dokuha tools, and this userscript only acts as its HTTP client when one is running. Downloading, rebuilding and ZIP saving never touch it; the panel probes the bridge at boot and then on a short interval (faster while its state is still unknown), and the fetch proxy ports are re-discovered every thirty seconds, so a bridge started later is picked up without a reload.

## Failure and progress semantics

A page that cannot be fetched or rebuilt is counted as failed and named in the run result. The ZIP still builds from the pages that succeeded, and the panel says how many are missing. The OCR path is stricter about its own contract: a finalize stream that ends without a terminal `done` frame is a truncated upload, a terminal `partial_upload` means the volume files arrived but the series index did not, and both are surfaced instead of being reported as a clean success. A page the bridge already holds is acknowledged as a cache hit rather than retried forever.

Progress reporting has one shared shape for the panel, the automation API and the headless CLI. Timers that drive progress polls run on a worker timer, because a hidden tab clamps main-thread timers hard enough to freeze a bar for minutes while the work itself continues.

## Testing and verification

The default suite is hermetic and runs in headless Chrome against local stub servers plus artifact checks that need no browser. It covers the build and artifact invariants, site dispatch and the reader-only gate, every store's protocol against recorded data or a synthetic storefront, the transport lanes, the page cache, the panel, the automation API, the six-shop availability card and the mokuro-bridge wire protocol. `tests/README.md` lists every file.

Two suites are opt-in because they need the outside world. `tests/acceptance/` downloads a real free volume from BookWalker, CMOA or ebookjapan and compares the pages with dokuha-cli's independent descrambler. `tests/test_bridge_e2e.js` measures the bridge's fetch-proxy lanes against a throwaway bridge instance. Both are excluded from `npm test` by default.

There is no golden image anywhere in the repository. The suites compare implementations and invariants, which is why they can run against synthetic servers and still catch a wrong tile.

## What is deliberately not here

- **No bundler, no minifier, no framework.** The shipped file stays a readable concatenation of the source.
- **No server side.** OCR and delivery belong to the separate mokuro-bridge service.
- **No series or batch subsystem.** dokuha-cli owns batch downloads; this script downloads the volume open in the viewer.
- **No store-specific knowledge in the shared core.** A store is one module plus its adapter registration.

Adding a store is documented in [src/README.md](../src/README.md#adding-a-store).
