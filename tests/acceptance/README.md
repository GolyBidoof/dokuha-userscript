# Acceptance tests (live stores)

These check the thing the hermetic suite cannot: that the built userscript still downloads a real book from a real store and that the pages come out descrambled. They are the only tests here that touch the network.

```sh
npm run test:acceptance                              # every store, userscript only
node tests/acceptance/run.js --cli ../dokuha-cli     # + CLI, adds the descramble check
node tests/acceptance/run.js --stores cmoa --keep    # one store, keep the downloads
```

`npm test` deliberately excludes this directory. CI (`ci.yml`) stays hermetic; these run from the `Acceptance (live stores)` workflow, which is `workflow_dispatch` only. The architecture they exercise is described in [docs/architecture.md](../../docs/architecture.md).

## Why there is no pinned test volume

Pinning a volume id would guarantee the test starts failing for a reason that has nothing to do with the downloader: what is free on these stores rotates. Every target is instead discovered at run time from the store's own server-rendered listing, then re-checked against the store before it is handed to a downloader (`lib/discover.js`).

| Store | Discovered from | Confirmed by |
| --- | --- | --- |
| BookWalker | `https://bookwalker.jp/free/`, one `?sample=2` link per free title | the entry URL must 302 to `viewer.bookwalker.jp` |
| CMOA | `https://www.cmoa.jp/search/result/?free_cam_flg=1`, server-side free filter | `bibGetCntntInfo.php` must answer `result: 1` |
| ebookjapan | `https://ebookjapan.yahoo.co.jp/free/`, the `__NUXT_DATA__` devalue payload | the viewer publication API must report it free with pages |

No account, no cookie and no secret is involved: every target is free to read anonymously. Discovery failure is reported as its own outcome, so "the store has nothing free today" never looks like "our downloader broke".

Two traps worth knowing, both hit during development:

* CMOA's `/free/` and `/trial/` return **HTTP 200 with the site's error page**. A status check alone would pass and parse nothing.
* BookWalker's `無料で読む` never appears as contiguous text, it is `<span>無料で</span>読む`. Match the `t-c-read-free-button` class instead.

## What is actually checked

For each store:

1. **the userscript**, driven in headless Chrome through `window.__bwddAutomation`, after which the archive it produced is parsed and every page decoded.
2. **the CLI** (with `--cli`), the same volume through browserless dokuha-cli, which is an independent implementation of the same store protocols.
3. **agreement**, the two page sets are compared in pixels.

The agreement step is the descramble check. Two independently written descramblers landing on the same pixels is strong evidence the tiles were put back in order; a page left shuffled cannot match a correct one.

The CLI is invoked as `<checkout>/bin/manga-dl.mjs`, which is the entry point name this runner was written against. dokuha-cli now ships `bin/dokuha.mjs`, so that path has to be reconciled before the agreement step can run against the current CLI; without `--cli` the run still downloads and decodes every page, it just skips the comparison.

### Injection timing is load-bearing

The userscript is injected at document-start and the run waits for the viewer to settle before starting. This is not a detail. CMOA's `bibGetCntntInfo.php` only returns a `p` token when the request carries a `k` parameter, which only the viewer's own call has; the script's self-minted fallback omits `k` (`src/sites/cmoa/00-state.js`, `cmoaContentInfoUrl`). Inject late and it misses that request, falls back, gets no token, and every page is 403. Measured on one free volume:

| Injection | Result |
| --- | --- |
| after load | 0 pages, every request an error |
| document-start, start immediately | flaky: a full run once, nothing the next run |
| document-start plus settle | every page, zero errors, reproducible |

A harness that injects late would report a downloader failure that is really its own artefact.

### Why not just look for scrambled tiles

The obvious single-image heuristic is to look for the periodic seam a tile permutation leaves behind. It was implemented and **measured against a counter-example**: on a synthetic manga page with ordinary panel borders it scored a *clean* page as more scrambled than a genuinely shuffled one, because manga is full of legitimate periodic structure. `tests/test_acceptance_oracle.js` keeps the counter-example so the heuristic is not reintroduced.

The comparison also tolerates two real differences between the implementations, because either one reported as a descrambling fault would be a false alarm:

* **offset**, the userscript's headless run drops the cover, the CLI keeps it;
* **reversal**, a partial match clustering around the middle of a long run is the signature of the two sequences running in opposite directions.

Both are searched and reported. A transform only counts if it compares the large majority of the pages, so a one-page coincidence cannot pass as agreement.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `--stores` | `bookwalker,cmoa,ebookjapan` | which stores to check |
| `--cli` | unset | path to a dokuha-cli checkout; without it there is no agreement check |
| `--script` | `dokuha-userscript.user.js` | which built artifact to drive |
| `--min-pages` | `5` | fewest pages that counts as a working download |
| `--min-psnr` | `25` | dB at which two pages count as the same image |
| `--settle` | `7000` | ms to let the viewer initialise before starting |
| `--keep` | off | keep the downloads instead of deleting them |
| `--json` | `tests/acceptance_result.json` | where to write the report |

Downloads go to a temp directory and are deleted unless `--keep` is passed.

## Kindle and k-manga are not covered

The live suite discovers free volumes on BookWalker, CMOA and ebookjapan, the three stores that serve a readable target anonymously. `read.amazon.co.jp` needs a signed-in Amazon session and the k-manga reader is not wired into the discovery layer, so neither is part of the run rather than being added as a known-broken job.
