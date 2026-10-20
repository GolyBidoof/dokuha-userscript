# BookWalker protocol notes

BookWalker is the reference store of the six: its protocol was reverse engineered first and everything shared was tuned against it. The adapter claims the four viewer hosts (`viewer.bookwalker.jp`, `viewer-trial.bookwalker.jp`, `viewer-ptrial.bookwalker.jp`, `viewer-subscription.bookwalker.jp`) and nothing else on the domain, so series, title, product and search pages stay inert.

## Where the protocol lives

| File | What it does |
| --- | --- |
| `00-state.js` | shared protocol state, auth and codec constants |
| `01-debug-helpers.js` | the `?bwddDebug` gate and the viewer page-global walker |
| `02-capture.js` | passively reads the viewer's fetch and XHR traffic for the signed API base, auth, content id and the encrypted manifest |
| `03-crypto.js` | decrypts `configuration_pack.json`: a custom base64 envelope, an RC4-style key schedule and UTF-8 JSON; the leading 128 payload chars seed the key schedule and every later derivation |
| `04-descramble-a9p.js` | the A9p tile geometry: per-page seed triples, xorshift rounds and the destination rects for each tile |
| `05-filename-token.js` | derives the per-page filename token the CDN URL must carry |
| `06-auth-helpers.js` | CloudFront auth query building and BID handling |
| `07-worker-descramble.js` | builds the descramble worker source |
| `08-worker-main.js` | the worker body: decode one page, blit every A9p tile into place, optionally scale, re-encode only when the output format asks for it |
| `09-decode-blob.js` | decodes a prefetched blob with the volume's seeds |
| `10-cdn-fetch.js` | CDN base candidates and the signed fetch |
| `11-auth-policy.js` | auth policy parsing, signature refresh and its budget |
| `20-auth-lifecycle.js` | refreshes auth against the viewer's own endpoints |
| `21-trial-zip.js` | the sample/trial pipeline, which starts from a plaintext config |
| `22-run.js` | the full-edition pipeline |
| `23-config.js` | decodes and validates `configuration_pack.json` |
| `24-preview.js` | the book card preview read from the manifest |
| `30-adapter.js` | registers the adapter |
| `40-availability.js` | the "also available on" search and price reader, combined build only |

The full and trial pipelines predate the shared run harness and keep their own bars and bookkeeping (`22-run.js`, `21-trial-zip.js`). Moving them onto `core/61-run-harness.js` is the largest open refactor in the repository; see [docs/architecture.md](../../../docs/architecture.md).

## What pins it

- `tests/test_descramble_equivalence.js` compares the worker's output with reference pages, byte for byte.
- `tests/test_site_dispatch.js` and `tests/test_split_builds.js` prove the adapter claims the viewer hosts only and that the split artifacts boot it.
- The live acceptance run downloads a free BookWalker volume and compares it with the CLI's independent descrambler, which is the end-to-end check that the tiles really went back in order.
