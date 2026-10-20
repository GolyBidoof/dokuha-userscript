# Source layout

The userscripts are **built**, not hand-edited. Each is the concatenation of the fragments in `src/`, in the order derived from the `after` references in `src/manifest.json`, filtered to the modules its target selects in `src/targets.json`. This file is the file-by-file map; [docs/architecture.md](../docs/architecture.md) explains why the build works this way and how a run uses the result.

| Artifact | Modules |
| --- | --- |
| `dokuha-userscript.user.js` | core + all six stores |
| `bookwalker-only.user.js` | core + `sites/bookwalker` |
| `cmoa-only.user.js` | core + `sites/cmoa` |
| `ebookjapan-only.user.js` | core + `sites/ebookjapan` |
| `kindle-only.user.js` | core + `sites/kindle` |
| `kmanga-only.user.js` | core + `sites/kmanga` |
| `dmm-only.user.js` | core + `sites/dmm` |

The split artifacts share the compiled core and carry exactly one store module, so none contains a line of another store's logic. `tests/test_split_builds.js` enforces it: metadata, fragment-level absence, and the adapter that actually boots.

```sh
npm run build                    # regenerate every artifact
node build.mjs --target cmoa     # regenerate one
npm run check:build              # fail if any artifact is stale

npm run bump patch               # bump the version, then rebuild everything
```

The fragments are plain, ordered pieces of **one IIFE**: they share a single closure, so any fragment can call anything else in the file. There is no module loader, no bundler and no source map. That is deliberate: the shipped file stays readable and diffable against `src/` line for line, and `node build.mjs --check` can prove the artifact matches its sources exactly.

## Why one file, six stores

A userscript has to be a single installable file, but it serves six stores. The split is therefore by **ownership**, not by load order:

```
src/
  _meta/               userscript metadata + the IIFE wrapper
  core/                shared by every store, store-agnostic
  sites/bookwalker/    BookWalker protocol only
  sites/ebookjapan/    ebookjapan protocol only
  sites/cmoa/          CMOA protocol only
  sites/kindle/        Kindle protocol only
  sites/kmanga/        k-manga protocol only
  sites/dmm/           DMMブックス protocol only
  entry/90-boot.js     pick an adapter from the host, then boot the shared panel
```

A fragment's place in the artifact comes from its `after` reference in `manifest.json`, not from where the entry sits in that file or which directory the file lives in: `build.mjs` sorts the references (a fragment is emitted once the fragment it follows has been) and uses the manifest order only to break a tie. A new store is therefore a linked block rather than an insertion into the middle of the list, and the manifest array stays free to be grouped by directory for humans.

## The version

`src/core/00-identity.js` holds the only copy, as the `BWDD_VERSION` literal. Each artifact's `@version` is substituted from it at build time, so the two can never disagree, and `node tools/bump.mjs <patch|minor|major|x.y.z>` is the only thing that should write it - it updates the README title and `package.json` too, then rebuilds. `tests/test_split_builds.js` asserts the derivation for every artifact.

`manifest.json` records only `file`, `module`, an optional `after` reference and a hand-written `note` per fragment. It deliberately stores no byte or line counts: those are derived, and a hand-kept copy of them had drifted 1,789 lines out of date before it was dropped. `node build.mjs` verifies the list against the tree instead, so a fragment dropped into `src/` but never listed, listed twice, or belonging to a module no target includes is a build error rather than a silent omission.

## The site adapter contract

`src/core/70-site.js` holds the registry. An adapter answers only the questions that genuinely differ between the stores:

| Hook | Meaning |
| --- | --- |
| `matches()` | does this adapter own the current reader page? Reader pages only. |
| `ownsHost()` | is this the adapter's store host? A page on a store host that matches no reader is a storefront page, and nothing boots there. |
| `headlessMatches()` | optional: the store-wide claim used only when `window.__BWDD_HEADLESS__` is set, so the CLI can inject the script on a product page. |
| `install()` | install page hooks (network capture); called once, at load |
| `refresh()` | optional: top up metadata before the panel reads it |
| `getBook()` | `{ rawTitle, title, series, volNum }` for the panel + stat lookups |
| `getPreview()` | `{ title, pages, resolution, type }` for the book card |
| `getCid()` | stable volume id, used as the page-cache key |
| `archiveDefault(rawTitle)` | the store's default archive name |
| `run(ui, mode, options)` | the download pipeline for this store |

Everything else is shared verbatim, which is what keeps the stores from drifting apart:

- the panel, its controls, the progress bars and the archive-name field (`core/51-panel.js`, `core/50-styles.js`)
- the optional mokuro-bridge hand-off, where mokuro-bridge is an independent local service this script acts as a client of: health, idle gate, session, ordered page streaming, early cover upload, finalize, upload progress (`core/31-mokuro.js`, `core/60-mokuro-flow.js`, and `core/61-run-harness.js`)
- the manga-kotoba and LearnNatively cards (`core/30-stats.js`)
- the cross-store "also available on" card, which asks all six shops: the title match, the per-series merge and the count-driven layout live in `core/32-availability.js` (module `feature/availability`, which only the combined target includes), and each store declares its own search URL and volume reader in `src/sites/<store>/40-availability.js` through `registerAvailabilityStore()`
- archive naming, the ZIP writer and the outcome wording (`core/40-naming.js`, `core/41-zip.js`)
- the page cache (`core/13-pagecache.js`) and the headless automation API (`core/11-automation.js`)

A host that no store owns falls back to BookWalker, so an injected copy (and the test suite) still gets a panel. Detection checks the reader matchers first, and when a page sits on a host one store owns but does not match that store's reader patterns, it returns no adapter at all rather than trying another store; that is what leaves series, title, product and search pages inert. Under `window.__BWDD_HEADLESS__` a store's optional `headlessMatches()` may claim its product page, which is the only non-reader path.

## The shared run harness

`core/61-run-harness.js` is the piece that makes "identical controls and an identical optional OCR hand-off" true rather than aspirational. A site pipeline creates one:

```js
const H = createRunHarness(ui, mode, options, { title, archiveName, sv, total, cid });
await H.mokuro.open();                    // OCR runs only
H.showBars();
H.bumpFetched(1);
H.notePage(index, blob, crc, ext);        // counts it, zips it, caches it, OCRs it
H.noteFailure(index, 'HTTP 403');
await H.finishZip();                      // or H.mokuro.finalize()
return H.outcome(missing === 0);
```

The harness owns the bars, progress reporting, the Mokuro session lifecycle, ZIP assembly and naming, the result object and teardown. A site keeps only what is genuinely its own: **how** pages are fetched. BookWalker drives a worker descramble engine, CMOA a quality and token retry ladder over a canvas descrambler, Kindle a render-window walk, k-manga a WebSocket pipeline, and DMM a signed manifest plus a 64×64 tile unshuffle. Those have nothing in common, and forcing them through one generic fetch loop would mean rewriting the tuned BookWalker path that works.

It also owns the run lock, via `ui.setRunLock(busy)`: a run disables the action buttons and the destination section, and it holds the browser's own "leave site?" prompt (`beforeunload`) for exactly as long as it is in progress. Every page already fetched and descrambled is in that tab's memory and the finalize stream is a request that tab is reading, so a stray Cmd-W would throw the run away without a word. The guard is armed on `true` and dropped on `false`, never left behind, so a later navigation is not nagged. Headless/CLI pages get no panel and so no prompt.

**Five stores create a harness today**: CMOA, ebookjapan, Kindle, k-manga and DMM (`sites/cmoa/02-run.js`, `sites/ebookjapan/05-run.js`, `sites/kindle/03-run.js`, `sites/kmanga/05-run.js`, `sites/dmm/02-run.js`). `sites/bookwalker/22-run.js` and `21-trial-zip.js` still hand-roll the same stages, so for BookWalker this section describes where the code is going rather than where it is. Unifying that is the largest open refactor in the repo.

What they *do* share is the transport. Those pipelines fetch through `laneFetch()`, so they all get the same fan-out across the manager lane and every local fetch-proxy port a running mokuro-bridge advertises, and they size their worker count from `fetchSocketBudget()`. A site that reaches for `GM_xmlhttpRequest` directly gets one lane and no port fan-out, which is why CMOA originally downloaded at about one page per request round-trip no matter how many bridge ports were running.

### The bridge's proxy ports are not transparent

The mokuro bridge opens a band of localhost ports so a download is not pinned to one origin's six sockets. Those ports are **not** a generic forwarder: the bridge fetches the host named in the `x-bwdd-upstream` request header and refuses any host outside its allowlist with a JSON 403. Two consequences for this code:

- a proxy lane is only usable for a CDN the bridge says it will fetch, so the lane pool tracks the advertised `fetchUpstreams` and a site opts in per host (`proxyCanServe(hostOf(url))`); a bridge too old to advertise the list is assumed to serve only the BookWalker CDN, which is what those builds hardcoded;
- the header is only sent when the host differs from the bridge's own default upstream, so a BookWalker request keeps exactly the shape it always had (no header, no CORS preflight).

A JSON 403 from a proxy lane is the bridge refusing the host, not an answer from the CDN, so `laneAttempt` turns it into a lane failure and the request falls through to another lane rather than failing the page.

CMOA's `q` parameter is a quality index where **lower is better**: the reader's own `getImageUrl()` sets `q=0` when its high-quality setting is on and `q=1` otherwise, and never requests `2` or `3`. The ladder is therefore `['0','1']`, overridable at runtime with `window.__bwddCmoaQualityOrder = ['1']`.

## Adding a store

1. Add `src/sites/<store>/` fragments and `registerSite({...})` in the last one.
2. Give the store one adapter fragment in `src/sites/<store>/40-availability.js`, tag it module `feature/availability` and have it call `registerAvailabilityStore({...})`, then list every fragment in `src/manifest.json` with its `module`, its `after` reference and a `note`. The build derives the load order from `after`, so the store is a linked block and no other entry has to move.
3. Add `src/sites/<store>` to the relevant `modules` list in `src/targets.json`, and give that target its `name`, `description`, `icon`, `matches`, `connects` and `banner`, with reader URLs only in `matches`. The adapter's `ownsHost()` must name the store host, so its series, title, product and search pages select no adapter at all. `src/_meta/00-header.txt` is a template - those fields are substituted into it, so the metadata block is never hand-edited per artifact and a script cannot claim a store it cannot handle.
4. Run `npm run build && npm test`.

## Fragment map

Each store keeps its protocol record next to its code, linked from the heading below.

### `src/_meta/`

| File | Purpose |
| --- | --- |
| `00-header.txt` | userscript metadata block: every store, grants, connects |
| `01-wrapper-open.js` | the shared IIFE opening (`(function () { 'use strict';`) |
| `99-wrapper-close.js` | the shared IIFE close (`})();`) |

### `src/core/`

| File | Purpose |
| --- | --- |
| `00-identity.js` | version/author/repo identity, read from the installed metadata |
| `10-util.js` | headless detection and log/URL redaction helpers |
| `11-automation.js` | headless automation API (window.__bwddAutomation) and run-option normalisation |
| `12-imagecodec.js` | output codec selection (jpeg/webp/lossless/png) |
| `13-pagecache.js` | IndexedDB page cache so an interrupted volume resumes |
| `14-ticker.js` | hidden-tab-safe interval: progress polls tick on a Worker timer so a background tab cannot starve them, plus a task-based yield for the ZIP writer |
| `20-worker-pool.js` | worker count and per-format batch sizing |
| `21-transport-pool.js` | transport lanes: on-page fetch, GM_xhr, local proxy ports, edge mirror |
| `22-transport-health.js` | cooldowns, circuit breaker, CORS-like error classification |
| `23-transport-burst.js` | burst sizing under consecutive blocks |
| `30-stats.js` | manga-kotoba + LearnNatively lookup and card rendering |
| `31-mokuro.js` | mokuro-bridge client: health, sessions, page upload, finalize stream |
| `32-availability.js` | cross-store availability (module `feature/availability`, combined build only): the store registry, the title match, the per-series merge and the count-driven card; each store declares its own search and volume reader in `sites/<store>/40-availability.js` |
| `34-unified-link.js` | single-store builds only: a panel-header link to the combined script |
| `40-naming.js` | cross-platform file naming, archive naming, message wording |
| `41-zip.js` | dependency-free store-method ZIP writer |
| `50-styles.js` | panel stylesheet and theme |
| `51-panel.js` | the panel UI: layout, controls, bars, archive-name field |
| `60-mokuro-flow.js` | early cover upload and the shared OCR finalize phase |
| `61-run-harness.js` | shared run plumbing: bars, Mokuro session, ZIP assembly, outcomes |
| `70-site.js` | site adapter registry, detection and the shared panel boot loop |

### `src/sites/bookwalker/` ([protocol notes](sites/bookwalker/README.md))

| File | Purpose |
| --- | --- |
| `bookwalker/00-state.js` | BookWalker protocol state and shared auth/codec constants |
| `bookwalker/01-debug-helpers.js` | ?bwddDebug gate and the NFBR page-global walker |
| `bookwalker/02-capture.js` | passively capture the viewer's signed API responses |
| `bookwalker/03-crypto.js` | configuration_pack.json decrypt (base64 + RC4 key schedule) |
| `bookwalker/04-descramble-a9p.js` | tile-shuffle geometry (A9p) and helpers |
| `bookwalker/05-filename-token.js` | per-page filename token derivation |
| `bookwalker/06-auth-helpers.js` | CloudFront auth query building and BID handling |
| `bookwalker/07-worker-descramble.js` | builds the descramble Web Worker source |
| `bookwalker/08-worker-main.js` | the worker body that reassembles one BookWalker page |
| `bookwalker/09-decode-blob.js` | decode a prefetched Blob with BookWalker seeds |
| `bookwalker/10-cdn-fetch.js` | BookWalker CDN base candidates and signed fetch |
| `bookwalker/11-auth-policy.js` | auth policy signature and refresh budget |
| `bookwalker/20-auth-lifecycle.js` | auth refresh against the viewer's own endpoints |
| `bookwalker/21-trial-zip.js` | BookWalker sample/trial (plaintext config) pipeline |
| `bookwalker/22-run.js` | BookWalker full-edition pipeline |
| `bookwalker/23-config.js` | decode and validate configuration_pack.json |
| `bookwalker/24-preview.js` | BookWalker book-card preview from the manifest |
| `bookwalker/30-adapter.js` | registers the BookWalker adapter |
| `bookwalker/40-availability.js` | BookWalker availability adapter (module `feature/availability`, combined build only) |

### `src/sites/ebookjapan/` ([protocol notes](sites/ebookjapan/README.md))

| File | Purpose |
| --- | --- |
| `ebookjapan/00-state.js` | ebookjapan page detection, the viewer URL and the book manifest |
| `ebookjapan/01-glue.js` | the viewer's wasm core and glue, embedded and pinned as base64 |
| `ebookjapan/02-descramble.js` | page-realm canvases, the portable encoder and the tile descrambler |
| `ebookjapan/04-worker.js` | off-thread descrambling on the shared pool |
| `ebookjapan/05-run.js` | ebookjapan run pipeline and adapter registration |
| `ebookjapan/40-availability.js` | ebookjapan availability adapter (module `feature/availability`, combined build only) |

### `src/sites/cmoa/` ([protocol notes](sites/cmoa/README.md))

| File | Purpose |
| --- | --- |
| `cmoa/00-state.js` | CMOA metadata: state, token pool, quality ladder, viewer/reader access, content info, title |
| `cmoa/01-fetch.js` | CMOA sbcGetImg URL building, lane fetch and canvas descramble |
| `cmoa/02-run.js` | CMOA run pipeline and adapter registration |
| `cmoa/03-worker.js` | CMOA off-thread page reassembly: descramble pool, job envelope, decode gate |
| `cmoa/40-availability.js` | CMOA availability adapter (module `feature/availability`, combined build only) |

### `src/sites/kindle/` ([protocol notes](sites/kindle/README.md))

| File | Purpose |
| --- | --- |
| `kindle/00-state.js` | Kindle reader detection and the `#bookInfo` state (asin, revision, token, resources) |
| `kindle/01-tar.js` | the ustar reader for the render response |
| `kindle/02-decrypt.js` | the page cipher: plain bytes or the base64 AES-GCM frame, and resource URL building |
| `kindle/03-run.js` | Kindle run pipeline and adapter registration |
| `kindle/40-availability.js` | Amazon Kindle availability adapter (module `feature/availability`, combined build only) |

### `src/sites/kmanga/` ([protocol notes](sites/kmanga/README.md))

| File | Purpose |
| --- | --- |
| `kmanga/00-state.js` | k-manga viewer detection and the WebSocket page-list and key state |
| `kmanga/01-protocol.js` | the BCP000 wire format, the LCG block permutation and title-page parsing |
| `kmanga/02-ws.js` | the viewer WebSocket transport and its request queue |
| `kmanga/04-descramble.js` | the canvas descrambler and page decoding |
| `kmanga/05-run.js` | k-manga run pipeline and adapter registration |
| `kmanga/40-availability.js` | k-manga availability adapter (module `feature/availability`, combined build only) |

### `src/sites/dmm/` ([protocol notes](sites/dmm/README.md))

| File | Purpose |
| --- | --- |
| `dmm/00-state.js` | DMM viewer detection, URL parsing and panel metadata |
| `dmm/01-protocol.js` | auth, CloudFront signing, manifest parsing, the 64×64 tile unshuffle and page decoding |
| `dmm/02-run.js` | DMM page fan-out, 403 refresh, run pipeline and adapter registration |
| `dmm/40-availability.js` | DMMブックス availability adapter: server-rendered search, the Next.js flight payload's volume rows and the BFF volume list (module `feature/availability`, combined build only) |

### `src/entry/`

| File | Purpose |
| --- | --- |
| `90-boot.js` | picks the adapter, installs its hooks, brings up the shared panel |
