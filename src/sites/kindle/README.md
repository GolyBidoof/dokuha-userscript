# Kindle manga, protocol notes and how this store slots into the shared core

Findings from two captured volumes and one further capture used while porting the store (the captures themselves are not shipped in this repository). The adapter that implements §4 is pinned by `tests/test_kindle_adapter.js` against a synthetic render service; re-check §1-§3 against a fresh capture after any Amazon change to see which assumption broke. Two independent volumes matter here: the AES-GCM key offset is `expiresAt % 60`, which was **5** for one capture and **8** for the other, and in each case exactly one of the 60 candidate offsets authenticates Amazon's own GCM tag. A rule that merely happened to fit one book would not fit both.

The adapter described in §4 now exists in this directory (`00-state.js`, `01-tar.js`, `02-decrypt.js`, `03-run.js`), with `tests/test_kindle_adapter.js` driving its window walk, reading order and page cipher against a synthetic render service, and `tests/test_site_dispatch.js` / `tests/test_split_builds.js` covering dispatch and the split artifacts. §1-§3 remain the protocol record.

---

## 1. What the store actually is

The web manga reader at `https://read.amazon.co.jp/manga/<ASIN>`. It is a React-ish SPA that renders **fixed-layout** manga: `manifest.bookFormat = YJBINARY_HD_MONOLITHIC`, `bookType = FixedFormat`, `contentType = FullBook`. The reader asks a first-party "karamel" render service for a *window* of pages, and that window's manifest tells it which signed CloudFront URLs hold the page images.

## 2. The three facts that make this the easiest of the six stores

1. **No descrambling.** A CDN resource *is* the finished page JPEG, natively 1350×1920. There are no tiles, no geometry plan, no canvas reassembly.
2. **No URL signing code.** The render manifest hands back each resource's `authParameter` (`Policy=…&Signature=…&Key-Pair-Id=…`) already computed. The adapter concatenates and fetches.
3. **No wasm, no worker.** If a resource is encrypted at all, it is plain AES-GCM, which `crypto.subtle` does off the main thread natively.

Compare: BookWalker needs RC4 + tile shuffle + filename-token derivation; ebookjapan needs a pinned wasm core, a canvas realm ladder and its own descrambler; CMOA needs a token/quality retry ladder. Kindle needs a tar reader and one WebCrypto call.

## 3. Protocol

### 3.1 State comes out of the DOM, not an API

The viewer embeds everything needed in a `<script type="application/json" id="bookInfo">` element:

| field | use |
| --- | --- |
| `asin` | cache id, archive naming |
| `title` | `splitSeriesVolume()` → series + volume |
| `contentGuid` | **the content revision** (e.g. `21fca44e`), required by `/renderer/render` |
| `seriesAsin` | series identity for the availability cross-check |
| `karamelToken.{token,expiresAt}` | the render bearer token *and* the image key |
| `cdnPrefetchInfo` | JSON **string**: the first pages' already-signed CDN descriptors |
| `bookAccessMethod` | `LIMITED_TIME_FREE` / purchase |
| `isSample`, `bookContentType` | trial detection (`bookContentType: "managedManga"`) |

`karamelToken.token` is byte-identical to the `x-amz-rendering-token` request header the viewer sends, so **no extra API call is needed** to start: `GET /api/manga/open-book?asin=…` exists and returns the same token plus `cdnPrefetchInfo`, but the embedded copy is enough.

### 3.2 Enumerating pages: `/renderer/render`

**The window size is free: it does not affect image resolution.** This was checked directly, because it is the obvious suspicion when a downloader picks its own `numPage`/`width`. Across **397 distinct page images** in two captures, the raster size reported for a given `imageReference` *never* differed between renders, not between the viewer's own requests (`numPage=2`, `width=1186`, `theme=dark`) and the adapter's (`numPage=6`, `width=1333`, `theme=default`), and not within either. The page's `rect` is the source raster's intrinsic pixel size (760×1200 / 764×1200 for one volume, with two 880/884×1200 inserts; 1350×1920 for the other volume, different books, different native sizes), and the render settings only supply a `transform` that scales it into the view.

So `numPage` may be raised to cut the number of renders without any quality cost, and `width`/`height`/`dpi`/`rasterScale` need not match the viewer's session.

```
GET /renderer/render
      ?version=3.0
      &asin=<ASIN>
      &contentType=FullBook
      &revision=<contentGuid>
      &dpi=160&fontFamily=Bookerly&fontSize=4.95&lineHeight=1.4
      &height=1270&width=1333&marginTop=0&marginBottom=0&marginLeft=9&marginRight=9
      &maxNumberColumns=2&theme=dark&locationMap=true
      &packageType=TAR&encryptionVersion=NONE&rasterScale=2
      &numPage=<count>&skipPageCount=<offset>&startingPosition=<anchor>&bundleImages=false
x-amz-rendering-token: <karamelToken.token>
```

* Response is `application/x-tar`, ~25 KB regardless of window size, holding:

  | member | content |
  | --- | --- |
  | `page_data_<lo>_<hi>.json` | one entry per page in the window: `sectionId`, `startPosition`/`endPosition`, and `children[]`, each child an `{type:"image", imageReference:"resource/rsrcXXXX", transform, clipPath, rect}` |
  | `manifest.json` | `cdn.baseUrl`, `cdn.isEncrypted`, **`cdnResources[]` = `{url, type, authParameter}`**, `revision`, `bookFormat`, `acr` |
  | `metadata.json` | `bookTitle`, `authors`, `lang`, `direction`/`progressionDirection: "rtl"`, `firstPositionId`/`lastPositionId` |
  | `location_map.json` | `locations[]`; **the number of source page images is `locations.length - 1`** (244 here), see the scale note below |
  | `toc.json` | chapter labels + positions |
  | `layout.json`, `layout_data_*.json`, `tokens_*.json`, `panels_*.json`, `glyphs.json` | layout/geometry; not needed to download |

* **Pagination is three parameters, and none of them is simply "the page".** The bundle builds them in `BookProvider.fetch` as:

  | parameter | source in the bundle | meaning |
  | --- | --- | --- |
  | `startingPosition` | `navigationOptions.startPositionId`, from `stuccoBookInformation.startReadingPosition` | the reader's **resume anchor**, where the book was opened, *not* the book's first page |
  | `skipPageCount` | `navigationOptions.skipPageCount` | window offset from the anchor, in **view slots** |
  | `numPage` | `readAheadPageCount` (default `renderBatchSize`) | window size; **signed**, negative walks backwards, and `skipPageCount` then shifts backwards too |

  The two captures prove the anchor is per-volume reader state, not a constant: capture 1 was opened at the start (`startingPosition=1`, first page `endPositionId=1`), capture 2 was opened at `startingPosition=18`, whose lowest window is `sectionId=837` at positions 16-18, mid-volume, with the cover only reachable by paging backwards (which the capture also contains, and which is why `sectionId=833..836` at position 1 are present too).

  **A downloader wants the beginning, so it sends `startingPosition=1`.** That is validated by both captures: in each, the book's first page sits at position `firstPositionId + 1` = 1. Note the failure mode if the anchor is ever unusable, it is *not* a 400: the bundle's own client throws `No pages returned for asin: …, startingPosition: N` after a **200** carrying metadata and no pages, so the adapter retries once with the parameter omitted rather than reporting an empty book as success.

* **`numPage` is capped by the service, and a refusal is a hard 400.** `400 {"message":"Unexpected number of pages"}`, captured live in capture 2, where the adapter's probe asked for `numPage=24` on the same volume and token whose viewer's own `numPage=2` request succeeded. The service does **not** clamp a window it dislikes. The adapter therefore starts high (24) and halves on a 400 (24 → 12 → 6 → 3 → 2), remembering the size that worked in `windowBatch` for the rest of the walk and for later runs.

  The ceiling is a real service limit, but **it is not 6**, 6 was a workaround for a 400 that later turned out to be the missing `contentType`, and the cost of believing it was steep: the walk is one render per window at ~1.1s each, so 209 pages at 6 per window is 35 serial renders (~38s) before a single page is fetched. Larger windows are safe on quality (see §3.2) and are the biggest lever on how long a run appears frozen. Paying two 400s once to discover the ceiling is worth it.

  Signed `numPage` also means the walk can in principle run backwards; a downloader only needs forward, so it always sends a positive count with a non-negative `skipPageCount`.

* **Four quantities are easy to confuse here, and two of them are counts of different things:**

  | quantity | unit | value in the capture |
  | --- | --- | --- |
  | `pageIndex` | **window-relative** view slot | cycles `0,1` in every bundle |
  | `sectionId` | global view id, offset from zero | 826, 827, … (view *n* = 826 + *n*) |
  | `startPositionId` / `endPositionId` | a position cursor | advances **~7 per 2-up view**, ≈3.5 per source page |
  | `location_map.locations` | position map | 245 entries, values 0…850 |

  `locations.length - 1` = 244 is the **source page image** count, the right total for a downloader and for the progress bar, and it is *not* the number of views. `metadata.lastPositionId` = 851 sits on the position-cursor scale: 851 ≈ 3.5 × 243, i.e. the same 244 pages, while the views number ≈ 123.

  So **termination must use the reader's own test**, stop when a page's `endPositionId >= metadata.lastPositionId`, *not* a count of windows against `locations.length - 1`. Using the location count as a view budget would walk roughly twice as far as the book is long (harmless but wasteful), and using it as a *progress total* is correct only because it counts images, which is exactly what gets archived. Both are implemented that way in `03-run.js`.

* `page_data` order is **authoritative** for reading order: sort pages by `sectionId`, then walk `children[]` in array order. Verified against the capture: 22 pages → 43 images, every `imageReference` resolving to a resource in that window's manifest, page 0 the single-image cover and later pages 2-up spreads (right page first, RTL). The `rsrc` suffix is an obfuscated ordinal, it *happens* to sort lexicographically here, but that is derived from a 16-char digit alphabet (`13579BDFHKNRTVXZ`) and must not be relied on.

### 3.3 Fetching a page

```
url = manifest.cdn.baseUrl + '/' + resource.url
    + '?' + <the signature>
    + '&token='      + bookInfo.karamelToken.token        // 1244 chars
    + '&expiration=' + bookInfo.karamelToken.expiresAt    // epoch milliseconds
```

**Which extra parameters to send is decided by the signature's own policy, and the two distributions want OPPOSITE requests.** Read `Statement[0].Resource` out of the base64url `Policy`; do not infer it from a host name:

| policy `Resource` | who uses it | `token` + `expiration` | without them |
| --- | --- | --- | --- |
| `…/fullbook/*` (prefix wildcard) | the encrypted host, serving AES-GCM | **required** | **502** |
| `…/resource/rsrc9X` (one exact object) | every plain host, and every sample URL | **must be absent** | 200 |

Getting it wrong in either direction costs every page, and both mistakes were made here for real. Sending only the signature made the encrypted host answer **502** for 313 of 349 pages (the plain-host pages saved, which is why exactly 10 of 174 appeared). Sending the token with an exact-resource policy made the *entire* sample fail, **all 109 fetches 403** while the viewer's 18 token-less requests to the same resources succeeded. The adapter therefore decides from the policy and keeps the other form as a single retry, since the failure modes are opposite and unambiguous.

**A valid signature is not sufficient: the encrypted host also demands the reading-session token, and refuses its absence with `502`, not `403`.** Measured by diffing a real viewer request against the adapter's for the same resource on the same host, the two URLs differ only in these two parameters, and the viewer's own requests are the ones that return 200:

| | viewer's accepted URL | adapter's refused URL |
| --- | --- | --- |
| `Policy` / `Signature` / `Key-Pair-Id` | present, valid (same resource, same key pair) | present, valid |
| `renderingOrigin` | `KRS` | `KRS` |
| `token` | `AgV4ZYAjXNTZ…` | **absent** |
| `expiration` | `1790335574119` | **absent** |

The `token` value is **byte-identical to `bookInfo.karamelToken.token`** and `expiration` **is** `karamelToken.expiresAt`, both already parsed from the page, so no new source of truth is needed. (`tokens_*.json` inside the render tar is unrelated: it is per-page word-position data for text selection.)

Do not read a 502 here as CDN throttling, pacing was slowed down once in pursuit of that phantom, which cost throughput and a global stall on every bad gateway, and cured nothing.

**Reporting.** The outcome rule is `kindleRunOutcome(saved, walked)`: any saved page is a download, zero saved pages is never one. The previous test was `missing === total`, which is wrong for exactly the case it was meant to catch - a sample's `total` is the *full* book's location_map count while only the sample's pages were walked, so a completely failed run still reported success with a progress bar and an empty archive.

**Which field holds the signature is a per-volume accident, and the two captures are exact opposites.** This was got wrong once, so it is written out plainly:

| | capture 1 | capture 2 and the third capture |
| --- | --- | --- |
| `cdnResources[].authParameter` | `Policy=…&Signature=…&Key-Pair-Id=…` | the literal string `null&renderingOrigin=KRS` |
| `cdn.authParameter` | `null` | one `Policy=…&Signature=…&renderingOrigin=KRS` |

In the capture-2 case the CDN-level policy's `Resource` is the *prefix* `https://d2qpunf64f4a6d.cloudfront.net/<asin>/<rev>/fullbook/*`, so it authorizes every page. Measured across the third capture's 37 manifests: **260 junk per-resource values against 10 genuine ones**, so the resource field cannot be trusted. Take whichever field is actually a signature (`kindleLooksSigned` / `kindlePickAuth`), and pair it with the `baseUrl` from the **same manifest** so host and policy always agree.

Getting this wrong is exactly what shipped once: reading the junk field produced `…/resource/rsrc1MT?null&renderingOrigin=KRS`, which CloudFront answers **403**. The adapter now fails with a named error rather than emitting `?null` if neither field is a signature.

**A 401/403 mid-book is not necessarily expiry.** Both captures show the signature good for **exactly 60 minutes** (`DateLessThan` = render time + 60.0 min, uniform across all 37 manifests of the third capture, matching `karamelToken.expiresAt`). In the third capture all 1200 403s fell inside a 12-second window while 200s continued for another two minutes, that is the junk signature, not an expired one. The adapter still re-renders a page's own window once on a 401/403 (`kindleRefreshWindow`), because a 60-minute run is possible and the signature is only minted by a render; the guard that the refreshed URL actually differs stops it becoming a retry loop.

**CORS works from the page.** The CDN answers `access-control-allow-origin: https://read.amazon.co.jp` (an exact origin, with no `access-control-allow-credentials`), so `fetch(url, { credentials: 'omit' })` from the reader page succeeds without GM_xmlhttpRequest and without a proxy port. The reader page's CSP is `Content-Security-Policy-Report-Only` and allows `https:`, so nothing is blocked either way. The shared lane pool is therefore *optional* for this store, an optimisation, not a requirement.

### 3.4 Decrypting a page (only when `cdn.isEncrypted`)

The same page can arrive two ways depending on which distribution host the manifest names:

* `isEncrypted: false` → `application/octet-stream`, raw JPEG bytes.
* `isEncrypted: true` → `text/plain`, an **ASCII base64 body with fixed framing**:

  ```
  chars  0..23   base64( salt )        16 bytes
  chars 24..47   base64( iv )          16 bytes
  chars 48..end  base64( ciphertext )  AES-GCM, 16-byte tag appended
  ```

  So offsets 22-23 and 46-47 are always `==`; that is the tell.

Reconstructed from the deobfuscated reader bundle and pinned by the cipher case in `tests/test_kindle_adapter.js`:

```js
// The reader calls this imageCipherKeyProvider.getKey(karamelToken).
const key = token.substring(expiresAt % 60, expiresAt % 60 + 40);   // 40 chars

const base = await crypto.subtle.importKey('raw', utf8(key), { name: 'PBKDF2' },
                                           false, ['deriveBits', 'deriveKey']);
const aes  = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 128 }, false, ['decrypt']);

const jpeg = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(key.slice(0, 9)), tagLength: 128 },
    aes, ciphertext);
```

The verifier proves the offset rather than assuming it: it tries all 60 values of `expiresAt % 60`, and exactly one authenticates the GCM tag. It then checks the plaintext for the `ff d8 ff` SOI and the trailing `ff d9` EOI.

### 3.5 Free-trial volumes

`bookAccessMethod: LIMITED_TIME_FREE` with `limitedFreeTrialEndDate`, the capture is exactly this case, and 244 pages were available. `isSample: true` (sample/preview) would be the analogue of BookWalker's trial path and needs its own test.

## 4. Slotted into the shared core

### 4.1 Where it plugs in

The adapter contract is already store-agnostic (`core/70-site.js`): `id, label, panelTitle, matches(), ownsHost(), install(), refresh(), getBook(), getPreview(), getCid(), run(ui, mode, options)`, plus the optional `headlessMatches()` (the explicit product-page claim used only under `window.__BWDD_HEADLESS__`), `afterBoot()`, `archiveDefault()`, `state`, `debug`, `debugGlobals`. `matches()` is reader-only, so Kindle claims `read.amazon.co.jp/manga/<ASIN>` and nothing else on the host. The run harness (`core/61-run-harness.js`) already owns bars, page accounting, the page cache, the Mokuro session and ZIP assembly, and is driven by calling `notePage(idx, blob, crc, ext)` / `noteFailure(idx, msg)` per page. Kindle needs no new core capability, it is a `run()` that resolves a page list, then maps each page to bytes.

Reused verbatim: `createRunHarness`, `normalizeRunOptions`, `reportRunProgress`, `getCachedPage`/`cachePage`, `splitSeriesVolume`, `zipBaseName`, `archiveDefaultName`, `fsSafePath`, `renderBookCard`, `fetchAndRenderStats`, `IMAGE_CODEC`/`resolveImageCodec`, `laneFetch`/`proxyCanServe`/`recordLane`, `buildUI`/`bootSharedPanel`.

### 4.2 New fragments

Mirroring `sites/cmoa/`'s split (state → fetch → run+register), with one extra file because Kindle has two separable non-trivial pieces (tar, crypto):

| file | contents |
| --- | --- |
| `src/sites/kindle/00-state.js` | `KINDLE_BASE`, `#bookInfo` parsing, `kindleState` (`asin`, `revision`, `token`, `expiresAt`, `title`, `seriesAsin`, `pageCount`, `resources`, `order`), `kindleRefreshState()` behind a single-flight guard, `kindleIsViewerPage()`, `kindleLog()` |
| `src/sites/kindle/01-tar.js` | the ~40-line ustar reader for the render body (`readTar`) |
| `src/sites/kindle/02-decrypt.js` | `kindleImageKey(token, expiresAt)`, `kindleDecodePayload(bytes, isEncrypted, key)` for both the plain and base64-framed forms, `kindleResourceUrl(manifest, resource)` |
| `src/sites/kindle/03-run.js` | `kindleWalkRenderWindows()` (the `skipPageCount` loop), `kindleBuildPageList()`, `kindleFetchPage()`, `kindleRun()` on the harness, and `registerSite({ id: 'kindle', … })` |

Learned from the existing modules and worth carrying over:

* **Single-flight the state resolve.** The browser's boot poll and a run can both ask for the probe at the same moment, and without a shared promise each caller opens its own session and they race over the same state object; ebookjapan learned this the hard way. Kindle's `refresh()` is called by both, so `kindleRefreshState()` memoises the in-flight promise, keyed by ASIN.
* **Register last.** `build.mjs` asserts no fragment calls `registerSite()` before `core/70-site.js`; keeping the call in `03-run.js` and placing the whole module group after `sites/cmoa` satisfies that and keeps the shared hosts first-match-wins order intact.
* **Do not re-encode for nothing.** The CDN already hands over the final JPEG. Emit a re-encoded page only when `IMAGE_CODEC.ext !== 'jpg'` (`notePage(idx, blob, undefined, 'jpg')` otherwise), the same way CMOA keeps raw bytes when it cannot descramble.
* **Keep the original extension honest.** `notePage`'s 4th argument exists for exactly this; without it the archive extension would claim JPEG bytes are WebP.

### 4.3 Bookkeeping edits (every place a store id appears)

| file | change |
| --- | --- |
| `src/manifest.json` | four `sites/kindle` fragments, placed after `sites/cmoa/02-run.js` and before `entry/90-boot.js` |
| `src/targets.json` | add `"sites/kindle"` to `both.modules`; add `read.amazon.co.jp` to `both.matches`, `read.amazon.co.jp` + `*.cloudfront.net` to `both.connects`; add a `kindle` target (`kindle-only.user.js`, modules `_meta core feature/unified-link sites/kindle entry`) |
| `src/core/32-availability.js` | optional: a `kindle` row (link-only, amazon.co.jp search) so the cross-store panel knows the shop |
| `src/core/34-unified-link.js` | the "get the combined script" wording still says "three stores" |
| `tests/test_site_dispatch.js` | a `read.amazon.co.jp/manga/…` probe asserting the kindle adapter, its branding and that no other store leaks onto it |
| `tests/test_split_builds.js` | the host→adapter table, and the binary `carriesBw ? … : (carriesCmoa ? … : 'ebookjapan')` inference needs a fourth branch |
| `tests/test_kindle_adapter.js` | new: drives the tar reader and the decrypt ladder against a fixture (the two facts that would rot silently) |
| `README.md`, `src/README.md`, `CHANGELOG.md`, `RELEASING.md`, `docs/greasyfork/*.html` | the store tables, the artifact list, and the greasyfork pages |
| `tools/sync-urls.mjs` | check only, it reads `targets.json` |

`build.mjs` itself needs no change: it is driven entirely by `manifest.json` + `targets.json`.

### 4.4 Match pattern

`https://read.amazon.co.jp/manga/*`, that is the URL the capture was taken from. `read.amazon.com` / `.co.uk` / `.de` are the same application on other marketplaces and are worth confirming against a second capture before being added, since `@match` is what decides whether the panel appears at all. Unlike BookWalker, whose viewer sits on its own host, there is no separate viewer host here: `/manga/<ASIN>` *is* the viewer. k-manga is the same in that respect, serving its reader from the same host as its series pages.

## 5. Open risks

1. **RESOLVED, `numPage` is capped.** Confirmed against capture 2: the service answers `400 {"message":"Unexpected number of pages"}` rather than clamping, so the adapter starts at 6 (the bundle's own default `renderBatchSize`), halves on a 400, and remembers the accepted size for the rest of the walk. The ladder starts at 24 and is not restricted to sizes the bundle happens to use; scenario B covers the halving, and §3.2 covers why a large window costs nothing in image quality.
2. **Render settings influence view grouping, not resolution.** The capture's exact settings are listed in §3.2. Neither `rasterScale` nor `numPage` nor `width`/`height` changes CDN resolution, verified over 397 page images, see §3.2. `width`/`height`/`maxNumberColumns` do change how many source pages share one view, but grouping does not change the resource set, so pinning a setting block is safe; pin it rather than inheriting whatever the viewer last used.

   **Pipelining note.** The walk and the page fetches deliberately run at the same time (`kindleRun` starts `kindleWalkWindows` without awaiting it, and the fetch workers consume pages as they appear). The walk is ordered, so page indices only grow and a worker can wait for the next one. Anything that consumes `kindleBuildPageList()` *after* the walk must rebuild it, the list captured before the walk is only the probe's first window.
3. **Two encryption modes coexist.** The same page name was served raw JPEG by `d38frjzegwsvig.cloudfront.net` / `d1wni8hbjtvcd0.cloudfront.net` and AES-GCM base64 by `d2qpunf64f4a6d.cloudfront.net`, with `cdn.isEncrypted` as the switch. Sniff defensively: if a supposedly-plain body does not start with `ff d8`, base64-decode it once before giving up.
4. **Token expiry mid-run.** `karamelToken.expiresAt` is 60 minutes past the request in both captures (`expiresAt` 10:47:34Z against a 09:47:34Z request; capture 2 the same shape), and `cdn.expirationDate` is a separate, slightly later clock. Both can expire during a 244-page run; a cached token must be dropped and state re-read (`open-book`, or reload the page) and the failed window retried, the way CMOA evicts a stale `p` token.
5. **Seller/format variants.** `bookContentType: "managedManga"` is what this book reports. Other Kindle content types on the same route (magazines, `isVerticalScroll: true`, `isASR: true`) are a different render shape and should fall through to a clear "unsupported content type" error rather than silently producing a partial archive.
