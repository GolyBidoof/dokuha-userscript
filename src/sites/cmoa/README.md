# CMOA protocol notes

The CMOA adapter claims `https://www.cmoa.jp/bib/speedreader/*` and `https://www.cmoa.jp/reader/*`. CMOA is the one store that can be rebuilt with no live viewer at all: the BinB scramble is data, and the adapter carries the viewer's own algorithm over that data.

## Where the protocol lives

| File | What it does |
| --- | --- |
| `00-state.js` | reader and viewer detection, the content metadata, the `p` token pool, the quality ladder and the content info request |
| `01-fetch.js` | builds `sbcGetImg.php` URLs, fetches through the shared lanes and reassembles a page on a canvas |
| `02-run.js` | the run pipeline and adapter registration |
| `03-worker.js` | off-thread page reassembly: the worker pool, the job envelope and the decode gate |
| `05-protocol.js` | the viewer-free descramble engine: `cmoaGenerateK`, the four XOR-scrambled tables recovered from the content info response, and the fixed permutation over them |
| `40-availability.js` | the "also available on" search and price reader, combined build only |

## The details that matter

- **Lower `q` is better.** The viewer requests `q=0` for its high-quality setting and `q=1` otherwise, and never `2` or `3`. The retry ladder is `['0','1']`, overridable for development with `window.__bwddCmoaQualityOrder`.
- **The content info request needs the viewer's own `k`.** `bibGetCntntInfo.php` only returns a `p` token when the request carries a valid `k` parameter; the adapter reads the viewer's request first and mints its own only as a fallback, so a late injection can lose the token and turn every page into a 403. This is why the live acceptance harness injects at document start and lets the viewer settle before starting.
- **A free volume can be rebuilt with no reader.** The four scramble tables live in the content info response, so `05-protocol.js` can unscramble a volume when the viewer never comes up, which is what a series worker needs.
- **A refusal can look like success.** CMOA's `/free/` and `/trial/` pages answer HTTP 200 with the site's own error page, so discovery has to check the body, not the status.

## What pins it

- `tests/test_cmoa_adapter.js` drives a full ZIP run against a synthetic speed reader and CDN.
- `tests/test_cmoa_ocr.js` proves the same pipeline drives the shared OCR hand-off, with the pages the bridge receives verified as descrambled.
- `tests/test_cmoa_offline_descramble.js` and `tests/test_cmoa_scramble_tables.js` pin the viewer-free engine against a real content info response.
- `tests/test_cmoa_descramble_required.js` refuses to call an undescrambled page a success, and `tests/test_cmoa_pagecache_stall.js` / `tests/test_cmoa_tail_hedge.js` cover the tail behaviour of a real run.
