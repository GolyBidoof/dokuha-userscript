# ebookjapan protocol notes

The ebookjapan adapter claims `https://ebookjapan.yahoo.co.jp/viewer/*`. It is the heaviest module in the repository because the page has to be rebuilt by the viewer's own wasm, not by a transcription of it.

## Where the protocol lives

| File | What it does |
| --- | --- |
| `00-state.js` | viewer page detection, the viewer URL, the book manifest and the page names |
| `01-glue.js` | the viewer's wasm core and its JavaScript glue, embedded as pinned base64 and decoded on demand |
| `02-descramble.js` | page-realm canvas handling, the portable encoder and the tile descrambler driven by the wasm |
| `04-worker.js` | off-thread descrambling on the shared worker pool |
| `05-run.js` | the run pipeline and adapter registration |
| `40-availability.js` | the "also available on" search and price reader, combined build only |

## The details that matter

- **The wasm draws into a page-realm canvas.** `drawImage` output only lands on a canvas created in the page's realm, which is where `makeCanvas()` builds it.
- **The page removes its own encoders.** It deletes `getImageData`, `toBlob` and `convertToBlob` from its prototypes, so pixels are read and images encoded through a hidden `about:blank` iframe whose prototypes are untouched. WebIDL brand checks are per interface, not per realm, so its methods can still read a page-realm canvas. If no canvas encoder exists in any realm, the module writes the PNG itself.
- **The glue is pinned.** A changed wasm build would silently change what a rebuilt page looks like, so `01-glue.js` carries the exact build and checksums it; `tests/test_ebookjapan_adapter.js` fails when the embedded core and the code that consumes it disagree.
- **The page's CSP forbids plain loopback.** `connect-src` allows `self`, `https:` and `wss:`, so a page fetch to the local mokuro-bridge ports is refused there even though it works on the other stores. The shared bridge client falls back to `GM_xmlhttpRequest`, which the userscript manager issues outside the page CSP; `tests/test_ebookjapan_gm_lane.js` covers that path.

## What pins it

- `tests/test_ebookjapan_adapter.js` runs without a browser and is the glue tripwire: it catches a changed wasm build or a mismatch between the glue and its consumer before a real run descrambles anything.
- `tests/test_ebookjapan_gm_lane.js` proves the bridge accelerator is reachable from a page that forbids loopback fetches.
- `tests/test_site_dispatch.js` and `tests/test_split_builds.js` pin the reader-only claim and the split artifacts.
