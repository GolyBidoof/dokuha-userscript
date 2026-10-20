# DMMブックス (`book.dmm.com`)

This is the protocol record for the sixth store. It is deliberately kept next
to the code: the next person to compare the adapter with the viewer should not
have to rediscover that DMM's JPEG is a tile shuffle.

## Reader URL

The real viewer is one of two same-origin pages:

```
https://book.dmm.com/product/<series>/<content>/free_streaming/?cid=<opaque>&lin=0&sd=0
https://book.dmm.com/product/<series>/<content>/tachiyomi/?cid=<opaque>&lin=1&sd=0
```

`free_streaming` is a volume that is free in full for a limited window.
`tachiyomi` is a 試し読み sampler. The `cid` is an opaque, short-lived viewer
token, not the volume id; the stable id used for the page cache and the archive
is the `<content>` path segment.

The `lastpage_web` iframe on the product page is only a promotional "last page"
overlay. It is not the reader.

## Authorization

```
GET https://book.dmm.com/viewerapi/auth/?cid=<cid>&lin=<0|1>
Referer: the viewer URL
```

The answer is JSON:

```json
{
  "status": "200",
  "url": "https://ebook04.dmm.com/bb/st_comic/b/b999/b999b/b999bsqex22127st/",
  "caa": "https://book.dmm.com/product/605237/b999asqex01885/",
  "cti": "サンプル作品 1巻【無料お試し版】",
  "cty": 1, "lpd": 1, "bs": 0, "lin": 1
}
```

The two routes then diverge:

- **`free_streaming`** returns no `auth_info`. The response sets three
  non-HttpOnly cookies on `.dmm.com`:

  ```
  CloudFront-Policy=...
  CloudFront-Signature=...
  CloudFront-Key-Pair-Id=...
  ```

  The CDN host is `ebook04.dmm.com`.

- **`tachiyomi`** returns an `auth_info` object with the same three names, and
  the CDN host is `trial.book.dmm.co.jp`:

  ```json
  "auth_info": { "Policy": "...", "Signature": "...", "Key-Pair-Id": "..." }
  ```

Both are CloudFront signed access, not DRM. The user script's shared
`laneFetch` deliberately sends `credentials: 'omit'`, so the free route appends
the three cookie values to every CDN URL as query parameters. The names change:
the cookies are `CloudFront-Policy`, `CloudFront-Signature` and
`CloudFront-Key-Pair-Id`, while signed-URL query parameters are `Policy`,
`Signature` and `Key-Pair-Id`. Sending the cookie names as query parameters is a
403 from CloudFront even when the values are valid. CloudFront also sends
`Signature` percent-encoded (for example `%7E` for `~`); a cookie header wants it
verbatim, but a signed URL must carry the decoded value or `URLSearchParams`
encodes the `%` again. The CLI sends the cookies as a `Cookie` header and sends
`auth_info` as query parameters.

The signature is short-lived. A 403 on the manifest or a page is treated as a
signature rollover: the adapter re-runs `/viewerapi/auth/` once (single-flight
across page workers) and retries the request against the replacement session.

## The page manifest

```
GET <auth.url>configuration_pack.json
```

This is plain JSON, not an encrypted BookWalker pack. `configuration.contents`
is the ordered page list. Each entry names an item such as
`item/xhtml/p-011.xhtml`, whose `FileLinkInfo.PageLinkInfoList[].Page` carries
`No`, `DummyWidth`, `DummyHeight` and `Size`.

The page URL is:

```
<auth.url><file>/<Page.No>.<type>
```

`type` is `bmp` or `jpeg`; `bmp` is fetched as `.jpeg`. Entries with
`Linear === 0` are skipped, exactly as the viewer skips them. A 250-page volume
with a cover is 249 config items plus `configuration`.

## The 64×64 tile shuffle

The CDN JPEG is **not** a finished page. It is a shuffled grid of 64×64 tiles.
The viewer's `publus-viewer.js` (observed `?20260622`) does the rearrangement in
a canvas:

- `Dl(model, path, page)` sets `dummyWidth`, `dummyHeight` and
  `pattern = sum(charCode(path)) % 4 + 1`, where `path` is
  `<file>/<Page.No>` (for example `item/xhtml/p-011.xhtml/0`).
- `Wu(imageWidth, imageHeight, pattern)` returns the tile rectangles.
- The viewer draws with
  `drawImage(image, r.destX, r.destY, ..., r.srcX, r.srcY, ...)`. Its names are
  inverted: `destX/destY` are the source in the scrambled JPEG and
  `srcX/srcY` are the destination in the clean page.

The clean page is the JPEG size minus `DummyWidth`/`DummyHeight`. In the
captured volume the JPEG is 904×1280 and `DummyWidth` is 4, so the page is
900×1280. `DummyWidth: 4, DummyHeight: 0` is not padding to ignore: the four
pixel remainder column takes part in the permutation, and the canvas clips the
result to 900 pixels.

`src/sites/dmm/01-protocol.js` ports `Wu`/`Dl`/`Vn`/`Fu`/`Qi`/`es`/`Xu` and
`dokuha-cli/src/download/dmm-descramble.js` ports the same arithmetic to a typed
array. A page that fails to decode is a failure, never a silently shuffled page:
a chessboard that looks like a successful run is worse than an honest error.

## What is supported here

- Free full volumes (`free_streaming`) and 試し読み samplers (`tachiyomi`).
- Paid or library volumes are not implemented. The adapter sends the viewer
  cookies (`credentials: 'include'`) to `/viewerapi/auth/`, so a signed-in
  browser can authorize them, but no session/cookie import path is exposed.
- The user script matches readers only. Series and product pages are storefront
  pages and deliberately show no panel. The CLI has `--series` for the whole
  volume list; the user script stays on the volume already open.

## The "also available on" card

`40-availability.js` is the adapter for the combined build's cross-store card.
Its inputs are all server-rendered and need no viewer: the search page
(`/search/?searchstr=`) returns one `m-boxSearchBookProduct` card per series,
linking to `/product/<series>/<content>/`, and that product page embeds the
per-volume rows in its Next.js flight payload (`volumeBooks`, `pager`). Each row
carries `freeStreamingUrl` (the store's own "read free" offer, not a 試し読み
sampler), `sell.campaignPrice`/`fixedPrice` in yen and `limitedFree.end`, which
the card spells as `10/22 23:59`.

The product page embeds only its first page of volumes. The `pager` states the
series total, and the adapter asks the store's own
`/ajax/bff/contents_book/?series_id=...` endpoint for pages of 100, which returns
the whole run in one request for a normal series. The endpoint answers JSON with
snake_case rows, and both shapes are read by the same normaliser.

The search is region gated, like the viewer itself: from outside Japan DMM
redirects `/search/` to its login page, and the lookup then reports no match
rather than a false one. A visitor who can open the viewer's free volume or
sampler can read the card's search too.

## Fan-out and decode

The page is downloaded whole and only then unscrambled. Those are separate
stages so one does not throttle the other:

- **Network width** follows `fetchSocketBudget(true)`: the page origin plus
  every localhost port a running mokuro-bridge advertises, then four streams per
  budget slot. The CDN is CloudFront over HTTP/2, so the browser's
  six-connections-per-origin ceiling does not apply and a wide fan-out is what
  keeps the link busy at high round-trip times. There is no fixed eight-worker
  cap, so 48 bridge ports are actually used, and a no-bridge page opens 48
  fetchers. `window.__bwddMaxInflight` and an automation `dmmConcurrency` still
  clamp it.
- **Descrambling** runs in a pool of `OffscreenCanvas` workers (2–8, sized from
  `workerPoolSize`). Each job gets precomputed tile rectangles and returns a
  finished Blob. The first probe checks that a blob worker can really create an
  `OffscreenCanvas` and call `convertToBlob`; a CSP that refuses it, or two
  consecutive worker failures, falls back to the main-thread canvas path without
  re-fetching a page.
- The main-thread fallback is limited to a few concurrent canvases, so a wide
  network window never means 250 decoded frames in memory. Worker jobs are
  compressed JPEG bytes until one of the pool slots picks them up.

Reuse a manifest and auth session within one run; do not re-probe them per page.

## Rate limits

DMM throttles with 429s. The adapter retries 429/5xx with bounded backoff per
page, and a 403 refreshes the auth once. The wide fan-out is bounded by the real
socket budget rather than a fixed small worker count; lower
`window.__bwddMaxInflight` if a run causes repeated 429s. The CLI keeps its own
modest default because it does not have the userscript's bridge lanes.
