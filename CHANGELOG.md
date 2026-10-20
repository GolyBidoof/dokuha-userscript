# Changelog

## v3.0.0

**The combined script is now dokuha-userscript, and series downloads live in dokuha-cli.** The combined artifact is `dokuha-userscript.user.js` (`@name dokuha-userscript`), its home is github.com/GolyBidoof/dokuha-userscript, and the panel header carries a small `dokuha-userscript` mark linking there. The per-store artifacts keep their names and banners because they already have users. GreasyFork entry 597313 still serves the earlier Omnimanga Native Downloader 2.0.0 (BookWalker, CMOA, ebookjapan) until this release is published and the listing is repointed; `docs/greasyfork/dokuha-userscript.html` is the paste-ready description for that update.

### Added
- **k-manga is the fifth store.** `sites/kmanga` downloads the volume open in the k-manga viewer over the viewer's own WebSocket: it opens the session through the launcher's redirect, pipelines BCP000 data requests, matches every reply by its scene number, and unscrambles each page on a canvas. Title and volume come from the viewer or launcher URL and the page's own structured data, so no REST scrape is involved.
- **k-manga joins the "also available on" card**, which now asks five shops. Its title page states each volume's amount in points rather than yen, so that pill reads `718pt` where the others read `¥810`. A free volume keeps its regular point price on the row, so free is read from its 無料で読む button and never from the amount, and the page paginates its ten-row volume list, so page two is followed before the series size and the free count are believed.
- The card's grid grows a six-column variant for the five-pill case: two wide cells over three narrow ones, so five shops still occupy exactly two rows and no store name is ellipsized away.
- **The "also available on" card appears as soon as one shop answers.** The first shop to confirm the book is painted at once, with a placeholder pill for every shop whose search is still in flight; each placeholder is replaced as its answer lands, and a shop that turns out not to carry the book simply loses it. The card is never painted from placeholders alone, so it claims nothing before a shop has actually answered.

### Changed
- **Every script loads only on reader pages now.** The `@match` lists name the viewers and nothing else: BookWalker's `viewer`, `viewer-trial`, `viewer-ptrial` and `viewer-subscription` hosts, CMOA's `/bib/speedreader/` and `/reader/`, ebookjapan's `/viewer/`, Kindle's `/manga/` and k-manga's `/viewer/`. Series, title, product and search pages are no longer matched, so the panel, the bridge probe, the traffic capture and the debug globals no longer run on the way to a book, and a copy injected on a storefront page finds no adapter and does nothing. The adapter contract follows: `matches()` is reader-only, `ownsHost()` names the store host so a storefront page cannot fall through to another store, and the optional `headlessMatches()` is the explicit claim for the headless product-page path. Headless CLI injection is the one deliberate non-reader path: the CLI opens a BookWalker `/de<uuid>/` or ebookjapan `/books/<id>/<code>/` product page and injects the script itself with `window.__BWDD_HEADLESS__`, which keeps the viewer-free licence exchange working, while a normal page load on those URLs does nothing.
- **CMOA volumes no longer need a live viewer to be descrambled.** The BinB scramble protocol, its four tables and the tiled permutation are read offline, and the page list can come from the `ttx` document instead of the reader, so a free volume downloads with no SpeedBinb and no `#content`.
- **The BookWalker viewer-free licence now belongs to the volume store page itself.** With the series queue gone, a `/de<uuid>/` page is the only caller: the licence exchange reads the loader nonce, walks the three reader-host calls in one session, and hands the ordinary pipeline its auth, base URL and cti.

### Fixed
- **The mokuro-bridge hand-off now matches bridge 0.9.** A page the bridge already holds is no longer reported as a failure. Re-sending identical bytes comes back as a `200` with `already_present`, and a `409` reading `already has completed OCR` or `already queued or present` is a cache hit; a `409` for a page still being OCR'd or ingested is retried with backoff, and only a real conflict such as a filename stem collision fails the page. Health and capability discovery already read `fetchProxyPorts`, `fetchUpstreams` and `fetchPathUpstream` from `/health`, so the extra browser lanes still light up with the bridge running and downloading still works without it.
- **The finalize request carries what bridge 0.9 accepts.** It sends the `overwrite` policy when an automation caller asks for one (a panel run keeps the bridge's safe `fail` default), still supports the legacy `upload_to_mega` flag when there is no method to name, and reports a rejected finalize (unknown upload account, session already finalizing) with the bridge's own `detail`. It is never retried against another destination, which used to be able to turn a bad alias into an upload to MEGA.
- **The finalize NDJSON stream is read as bridge 0.9 emits it:** `wait_ocr`, `assemble`, `pack`, `upload`, `upload_progress`, `series_json`, `cleanup`, then a terminal `done` or `error`. A `done` whose status is `partial_upload` (the volume files arrived, the series index did not) is surfaced as an incomplete run instead of a clean success, and a stream that ends without `done` is treated as a truncated upload.
- `tests/test_mokuro_client.js` pins the whole protocol against a stand-in bridge as part of `npm test`, so the next `mokuro-bridge` change that moves a field fails in CI rather than in a live run.

### Removed
- **The series/batch subsystem is deleted, not hidden.** dokuha-cli owns series downloads now, so the userscript keeps only the single-volume runner paths. Removed: the hidden-frame queue and its worker, every store's catalogue, the `batch` hook on every adapter, the batch mount in the panel, the `window.__bwddBatchVolumeUrl` marker that fed the queue, and the batch and series tests.
- **The `panelAllowed()` adapter hook is gone.** A normal page either matches a reader and gets the panel, or matches nothing and does nothing; there is no longer a matched page that installs its hooks and then withholds the UI. `bootSharedPanel` no longer consults the hook, and no adapter defines it.
- Kept, unchanged: all five stores' single-volume runners, the cross-store "also available on" pills, the combined-build pointer in the single-store builds, OCR and mokuro, ZIP, naming, the page cache and the headless automation API.

### Tests
- `tests/test_site_dispatch.js` and `tests/test_split_builds.js` pin the reader-only gate: every target's `@match` list is checked against a reader allowlist, a normal load on each storefront URL selects no adapter and leaves no panel, no `window.__bwdd` debug surface and no wrapped `fetch`, the readers still boot their panels, hosts no store owns still fall back to BookWalker, and headless injection on a product page still selects BookWalker or ebookjapan. `tests/test_ui_panel.js` drops its old "matched but paints no panel" cases along with the hook they tested.
- `tests/test_availability.js` covers the k-manga adapter (its GET search path, the point price, the free-volume button and the paginated free count) and pins the five-pill grid to exactly two rows with every store name readable.

## v2.0.0

**One script for three stores.** The combined build now handles BookWalker, CMOA
and ebookjapan from the same panel, and is published as **Omnimanga Native
Downloader** (`omnimanga-native-downloader.user.js`). Three single-store builds
sit beside it for anyone who wants only one store. All four come from the same
sources, and a single-store artifact contains no line of another store's
protocol.

The script was reorganised around a shared core - the panel, the run loop, the
Mokuro bridge, ZIP assembly and the transport pool - with each store's site
protocol isolated in its own module. There is still no bundler and no minifier:
the shipped file is the concatenated source, in manifest order, so it stays
readable and can be diffed against the repository line for line.

The "also available on" card is now part of the combined script only.

### Added
- **Single-store scripts point at the combined one.** The BookWalker-only,
  CMOA-only and ebookjapan-only builds put a small "all-in-one downloader" pill in the
  panel header, beside the version and the GitHub icon, linking to the combined
  script's latest release. It lives in its own manifest module
  (`feature/unified-link`) that the single-store targets include and `both` does
  not, because the combined script must not point at itself. Its CSS travels
  with the module, as the store card's does.
- `tests/test_artifacts.js` asserts the filename that pill links to against
  `targets.json`, so renaming the combined artifact fails the suite instead of
  shipping a dead link, and `tests/test_split_builds.js` boots every artifact to
  prove the pill renders in the single-store builds and not in the combined one.

### Changed
- **The cross-store card ships only in the combined build.**
  `core/32-availability.js` moved to its own manifest module
  (`feature/availability`), which only the `both` target includes, so the
  BookWalker-only, CMOA-only and ebookjapan-only scripts carry none of it - not
  the queries, not the markup, and not its CSS (which moved out of the shared
  stylesheet and into the module). The call site in the shared panel is guarded
  with `typeof`, because in a single-store build that identifier does not exist.
- **A single-store script no longer asks for storefront hosts it never uses.**
  BookWalker-only drops `ebookjapan.yahoo.co.jp`; CMOA-only drops both
  `bookwalker.jp` and `ebookjapan.yahoo.co.jp`. Tampermonkey may therefore ask
  for permissions once on update.
- The shared permission note no longer names the three storefronts, because
  which of them a build queries now depends on the build.

### Fixed
- **A BookWalker manifest section without `FileLinkInfo` aborted the whole run**
  before a single page was fetched, and the panel showed only
  `Cannot read properties of undefined`. It now degrades to an unknown page size
  and continues, exactly as the trial path already did.
- **A missing BookWalker manifest section marked the wrong page as failed.** The
  index of the *next* page was recorded instead of the section's, so "Saved N of
  M" and the retry rounds could be wrong; when the missing section was last, that
  phantom index was never cleared at all.
- **BookWalker's auth fallback called `/c` twice.** Operator precedence made the
  still-missing guard read as `!auth || (!baseUrl && !first)`. It now matches
  v1.5.1: `/pb` first, then `/c` once, and only if auth is still missing.
- **A run could be started while another was still in flight** on CMOA and
  ebookjapan. Only BookWalker held the panel's run lock; the shared run harness
  now takes it for the whole run and releases it in its teardown, which both
  stores run in a `finally`. The Run button and the destination controls are
  therefore disabled while a run is in progress, as they already were for
  BookWalker.
- **ebookjapan could resolve the same volume twice at once**, opening two
  `open_book` sessions and instantiating two copies of the wasm module to race
  over the same state. Resolves are now single-flight per target.

### Distribution
- **Releases are automated, but only on a tag.** `.github/workflows/ci.yml`
  proves every committed artifact matches `src/` and compiles, then runs the full
  suite; pushing to `main` publishes nothing, so work in progress can sit there
  safely. `.github/workflows/release.yml` runs on a `v*` tag, checks the tag
  against the core version, and publishes a release carrying all four userscripts
  with the `CHANGELOG.md` section as the body. A tag that disagrees with the core
  version fails instead of mislabelling a release.
- **GreasyFork reads a `release` branch, not `main`.** The release workflow also
  refreshes a branch holding nothing but the built artifacts, so a synced entry
  moves when a release is cut and never because somebody pushed work in progress.
  See `RELEASING.md`.
- **Installed scripts can update themselves.** Every artifact now declares
  `@updateURL`/`@downloadURL`, pointing at
  `releases/latest/download/<artifact>` and derived from `package.json`'s
  `repository` - a release asset rather than a raw branch URL, so a half-finished
  push to `main` cannot become somebody's update.
- `tools/release-notes.mjs` prints the CHANGELOG section for a tag and fails when
  there is none. There is no GreasyFork upload API to wire up; that stays a
  per-script source-sync setting, documented in `RELEASING.md`.

### Tests
- `tests/test_availability.js` (30 checks) skips a build that does not carry the
  module, so it can be run against every artifact rather than only the combined.
- `tests/test_artifacts.js` (39 checks, new) compiles every built artifact from
  disk with V8 and asserts it is not truncated, not stale, and not carrying a
  module it excludes. It reads its targets from `src/targets.json`, so a new
  artifact - a new store - is covered as soon as it is declared. Verified to
  catch a truncated file, a stray token (`Unexpected token ',' @ file:line`), a
  silently deleted fragment, an orphan artifact and an unsubstituted placeholder.

## v1.8.5

The availability card says less, but it says it about *your* volume.

### Changed
- **A pill is only shown for a shop that actually carries the book**, and a card
  with no pills is no longer rendered. Shops that miss are still queried, they
  are just not shown - so the "search" pills are gone, along with the frame
  around them.
- **An unnumbered volume is matched by its exact title.** A one-shot, or a first
  volume whose title carries no number, could not be found by volume number, so
  its pill fell back to a bare "available" with no price. It now matches the
  series row whose title equals the book's - BookWalker's row for
  `小春と湊 わたしのパートナーは女の子【イラスト特典付】` - and
  reports that row's price.
- **No filler word.** A pill with nothing to say about the volume now shows just
  the shop's name instead of the word "available".

### Removed
- The per-shop search link. Hiding the pill for shops that do not carry the book
  removes the "search it on X" affordance with it. It can come back as its own
  row if it is missed.

### Tests
- `tests/test_availability.js` (30 checks): only carried shops get a pill, an
  empty card is not rendered, and an unnumbered volume is matched by title and
  priced.

## v1.8.4

Fix: the BookWalker script reported every shop as "search".

### Fixed
- **A lookup that ran before the viewer published its title latched forever.**
  The panel fires the availability check on its first pass, around 500 ms in,
  when the viewer may still be reporting a placeholder title. Every shop then
  correctly answers "not found" - and because the check ran once and never again,
  the pills stayed wrong for the life of the page. It now re-runs whenever the
  title or volume changes, with the result cache and upsertCard keeping that
  cheap. This is the most likely cause of all three pills reading "search".
- **A title carrying the shop's own branding is cleaned before searching.**
  Viewer titles can end in "| BOOK☆WALKER" (and the equivalent for the other
  shops), which no shop's search will match. That suffix is now stripped from the
  query, with the original still tried as a fallback candidate.
- **Failures now say why under `?bwddDebug=1`**: the seed and volume used, a
  per-shop found/search verdict, and for a failed request whether it was a
  transport failure or a non-200 response. An unreachable shop and an absent book
  were previously indistinguishable from the panel.

### Tests
- `tests/test_availability.js` (27 checks): a brand-suffixed title still matches,
  and a placeholder title that is replaced later must not latch - the pills have
  to correct themselves once the real title arrives.

## v1.8.3

### Fixed
- **ebookjapan's free count was taken from the whole results page.** The
  `N冊無料` badge was scanned out of every card on the search page and the largest
  won, so a neighbouring title advertising a bigger badge was reported as this
  book's offer (3 where the book's own card said 2). The scan is now scoped to
  the matched result card, and if that card carries no badge no count is shown at
  all rather than another title's.
- **The free accent was inconsistent between stores.** It keyed on "this volume
  is free", which only the stores with per-volume rows can report, so
  ebookjapan's label stayed muted while BookWalker's and CMOA's went green for
  the same kind of news. The accent now means "free reading is available on this
  store" and lights all three alike. The text still separates the volume's own
  state (`free` / `¥792`) from the series count (`2 vols free`).

### Tests
- `tests/test_availability.js` (23 checks): the ebookjapan fixture now holds a
  competing card with a larger `3冊無料` badge, so a page-wide scan fails, and a
  check asserts the accent is applied consistently across all stores.

## v1.8.2

Fix: CMOA reported every volume in a series as free.

### Fixed
- **CMOA's `GA_free` class was treated as the free marker, and it is not one.**
  Every volume row also carries an empty placeholder,
  `<div class="title_vol_each_free_btn GA_free"></div>`, so matching the class
  alone marked the whole series free - a title with 7 volumes free until 9/27 was
  reported as "10 vols free". A volume now counts as free only when its free
  button actually says something (`無料で読む`) or its row shows a `¥0` price
  mark. Checked against the live page: the old rule gave 10, the new rule 7.
- The ebookjapan count is now attributed in the tooltip to the store's own
  campaign badge, rather than implying the panel counted those volumes itself.

### Tests
- `tests/test_availability.js` (21 checks) gained a CMOA row whose only free
  evidence is the empty placeholder, so a class-only match fails the suite. The
  fixture was too clean, which is why this reached a live panel.

## v1.8.1

The pills now report the series free-volume count even when the volume you are
reading is itself the free one.

### Fixed
- **A free volume discarded the free-volume count.** `storeMetaText` returned
  `free` immediately when the current volume was free, throwing away a count that
  had already been read off the store page. That is why ebookjapan showed
  `3 free` - it has no per-volume state to short-circuit on - while BookWalker
  and CMOA showed a bare `free`. The volume's own state and the series count are
  two independent facts and are now both reported: `free - 2 vols free`,
  `¥810 - 2 vols free`, or plain `free` when this volume is the only free one.

### Changed
- The tooltip spells out the ratio from the distinct volume numbers seen in the
  page rows: `2 of 3 volumes can be read free`, or `all 3 volumes can be read free`.

### Tests
- `tests/test_availability.js` (20 checks) now has two free volumes in the
  BookWalker fixture, so the free-and-counted case is actually exercised rather
  than only the paid one - the gap that let this ship.

## v1.8.0

The "also available on" pills now say what each shop charges.

### Added
- **Price and free-volume detail per store.** Each pill reports, for the volume
  you are actually reading: `free` when that volume can be read free, otherwise
  its price, plus how many volumes in the series are free (`¥792 · 2 free`). The
  store page we already link to is parsed for this, so it is a second request
  per matched store and one lookup per title per page.
- A free volume is highlighted in the pill, and CMOA's time-limited free
  readings surface their expiry in the tooltip (`this volume is free (9/27まで)`).

### Notes
- What each shop exposes differs, so the pills report only what is really there:
  - **BookWalker** gives each edition its own card with a price, and marks a free
    volume with a 0 price plus 無料で読む; its series page also carries a price
    facet (`価格-0円 (2)`) that independently agrees with the counted rows.
  - **CMOA** keeps the *regular* price on a free volume's row and marks free only
    with a 無料で読む block, so free is read from that block and never from the
    price. Volumes with several editions (通常版 / 特装版) report the cheapest.
  - **ebookjapan** is a Vue app with no server-rendered prices or per-volume rows
    at all, so it contributes only the campaign badge from its search card
    (`2冊無料` -> `2 free`) and no price, rather than a guess.
- When the volume number is unknown, or the volume is not in the page, the free
  count is still shown and **no price is claimed**.

### Tests
- `tests/test_availability.js` (19 checks, up from 15) stubs the real series-page
  markup for all three shops, including CMOA's free-row-keeps-its-price trap and
  the ebookjapan badge, and asserts the unknown-volume case invents no price.

## v1.7.1

Build hardening, after an installed `cmoa-only` failed to parse.

### Fixed
- **Artifacts are now written atomically.** `writeFileSync` truncates before it
  writes, so a reader that opens the file mid-build - Tampermonkey re-reading a
  local install - can get a truncated script. That fails as
  `Failed to execute 'appendChild' on 'Node': Unexpected token ...` at whatever
  line the truncation landed on, naming nothing in `src/`. The artifact is now
  written to a temp path and renamed into place.
- **Every artifact is compiled during the build.** `build.mjs` runs each
  rendered artifact through `node:vm` before it is compared or written, so a
  truncated or mis-concatenated fragment now fails the build and reports the
  generated line plus the offending fragment text. Previously the only syntax
  check was a manual `node --check` on a single artifact - which is exactly how
  a break could reach an install unnoticed.

### Notes
- No behaviour change: the sources are identical to v1.7.0 apart from the
  version. If you installed 1.7.0 from a file that was mid-rewrite, reinstall
  1.7.1. Tampermonkey keys updates on `@version`, so a same-version file is
  never re-read.

## v1.7.0

"Also available on" - the panel now says which other shops carry the series you
are reading, and links to their store pages rather than their viewers.

### Added
- **A cross-store availability card** (`src/core/32-availability.js`). Under the
  book details, one small pill per shop - **CMOA**, **BookWalker**,
  **ebookjapan** - lit when that shop carries the series and linking to its
  series/title page, dimmed and labelled `search` when no match was found and
  linking to that shop's search instead. It never asserts availability it has
  not confirmed.
- The shops are a **core catalog**, not an adapter concern, so a build shipping
  a single store module still checks all three. `ebookjapan` is link-only
  (`siteId: null`) until a downloader exists; setting that id is all a future
  adapter needs to count as "the store you are reading on".
- CMOA gets its store link **exactly**, for free: the speed-reader URL carries
  the store page it was opened from as `rurl`. It is used when present and
  valid, and a hostile `rurl` on another host is ignored.
- New `@connect` grants: `bookwalker.jp` (the storefront, which `*.bookwalker.jp`
  does not cover) and `ebookjapan.yahoo.co.jp`.

### Notes
- Matching is scored in tiers - exact, then prefix, then contains - because shop
  search pages differ wildly: BookWalker appends the imprint in brackets
  (`...(ビッグガンガンコミックス)`) and also exposes single-volume `/de<uuid>`
  pages, while ebookjapan wraps the whole result card (price, genres, awards) in
  a single anchor. Series pages outrank single-volume pages; the tightest anchor
  wins ties.
- "Not found" is a real answer rather than a silent failure:
  `tests/test_availability.js` records every URL the script requests and asserts
  each shop was genuinely searched, so a failed fetch cannot masquerade as a
  confident negative.

### Tests
- `tests/test_availability.js` (15 checks): stub storefronts reproducing the
  real HTML shapes above, including decoys a naive "first product link wins"
  matcher would pick; the not-carried path; the CMOA `rurl` path; and rejection
  of an `rurl` pointing at another host. Test suite is now 12 files.

## v1.6.5

The version now has one source, and there is a script that releases it.

### Added
- `node tools/bump.mjs <patch|minor|major|x.y.z>` (also `npm run bump`) bumps the
  version and regenerates every target; `--dry-run` prints the plan without
  writing. It keeps the README title and `package.json` in step, and leaves
  CHANGELOG.md alone - its `## vX.Y.Z` headings are history, and stubbing them
  automatically would be guessing at your prose. It prints the reminder instead.

### Changed
- **`@version` is derived, not hand-kept.** The single source of truth is the
  `BWDD_VERSION` literal in `src/core/00-identity.js`. `src/_meta/00-header.txt`
  now carries `{{VERSION}}`, which build.mjs substitutes into all three
  artifacts, so the number the manager keys updates off is the same number the
  panel prints. Previously these were two copies with a build-time check between
  them - and the drift was real: `package.json` was three releases behind at
  1.5.1.
- build.mjs now fails on an unsubstituted or unknown `{{PLACEHOLDER}}` in the
  header template rather than shipping it.

### Tests
- `test_split_builds.js` asserts every artifact's `@version` equals the core
  literal and that no placeholder survived rendering, so the derivation is
  enforced rather than assumed.

## v1.6.4

Two installable scripts instead of one, and the metadata block can no longer lie.

### Added
- **Per-store builds.** `src/targets.json` selects which modules go into each
  artifact, so `node build.mjs` now writes three: the combined
  `bookwalker-native-downloader.user.js` plus `bookwalker-only.user.js` and
  `cmoa-only.user.js`. Each split script carries exactly one `src/sites/` module
  and its own `@name`, `@match` and `@connect`, so neither can match or reach a
  host belonging to the other store. Install the combined script OR the pair,
  never both - they match the same hosts and you would get two panels.
- `tests/test_split_builds.js`: metadata per target, fragment-level absence of
  every excluded module, and in a browser the adapter that actually boots plus
  the absence of the other store's internals from `window.__bwdd`.

### Changed
- **The shared core no longer depends on a store module.** `BWDD_DEBUG` lived in
  `src/sites/bookwalker/` while seven core fragments logged through it, which
  meant the CMOA module already imported a BookWalker file. It now lives in the
  core with `JPEG_QUALITY`, and the remaining crossings go through the adapter:
  the panel asks `siteCid()`, the CLI asks `ACTIVE_SITE.install()`, the debug
  surface is composed from whatever the active adapter declares, and the
  descramble worker source is an optional global. Zero crossings remain in
  either direction.
- `src/manifest.json` records only `file`, `module` and `note`. Its derived
  `bytes`, `lines` and `totalLines` were hand-kept, nothing read them, and they
  had drifted: `totalLines` said 7,570 against an actual 9,359, 13 fragments had
  wrong byte counts and 6 had `lines: null`. `node build.mjs` now verifies the
  list against the tree instead, so an unlisted, duplicated or target-less
  fragment is a build error.

### Tests
- `test_image_codec.js` skips instead of crashing when pointed at an artifact
  without BookWalker's `A9p`, since it builds its reference page with it.

## v1.6.3

Console tidy-up after the first fast run.

### Fixed
- **The manga-kotoba lookup used a plain page fetch and was CORS-blocked.**
  manga-kotoba.com no longer reflects the Origin, so the request failed with
  "No 'Access-Control-Allow-Origin' header is present" and logged an error on
  every page load, leaving no card. It now goes through the same GM transport as
  LearnNatively, which bypasses CORS and degrades quietly if the site is
  unreachable (it is currently answering 502 to some networks).

### Changed
- The informational console lines are now behind `?bwddDebug=1`: the light/dark
  scheme notice, the trailing-dot lane probe result, the `lanes=… sockets=…`
  readout on both stores, `Page cache cleared`, and the best-effort stats lookup
  errors. A normal page now logs only the one-line load banner; real problems
  (a failed run, a retired lane, a disabled GM transport) still warn.

## v1.6.2

CMOA was downloading at roughly one page per round-trip because it was pinned to
six sockets. It now uses the mokuro bridge's fetch-proxy ports like BookWalker
does, and reaches 256-way parallelism.

### Fixed
- **CMOA downloads were stuck on a single origin.** The CDN answers HTTP/1.1
  only, so Chrome allows six connections and no more, which made six the hard
  ceiling regardless of how many workers were running - the HAR showed exactly
  6 connections with 7-8 requests in flight and ~3 pages/s. CMOA now opts into
  the bridge's fetch-proxy ports (48 ports x 6 sockets) and the worker count is
  sized from the real socket budget, capped at 256. Lower it with
  `window.__bwddMaxInflight = 32` on a low-memory machine.
- **The trailing-dot probe never succeeded on a free volume.** It asked for the
  head of the quality ladder, which a free/trial volume refuses with 403, so the
  extra origin was switched off exactly where most reading happens. It now
  probes the least-restricted rung.
- **A request could be sent to a proxy port configured for another store.** The
  bridge's proxy is not a transparent forwarder: it fetches the host named in
  `x-bwdd-upstream` and refuses anything outside its allowlist. Proxy lanes are
  therefore only used for a CDN the bridge says it will fetch, and the host is
  named in that header; a bridge still hardcoded to BookWalker is treated as
  BookWalker-only and CMOA falls back to the page and trailing-dot lanes.

### Added
- The trailing-dot lane for CMOA. The dotted hostname is the same server but a
  separate origin, worth 6 more sockets, and needs nothing running locally.

### Changed
- The test suite is hermetic. It pointed the bridge URL at a dead port
  (`tests/_userscript.js`), because a developer with the real bridge running had
  its 48 ports discovered by every test page and mixed into the lane pool, which
  silently turned distribution assertions into measurements of the bridge.

### Requires
- A mokuro bridge that advertises `fetchUpstreams` and accepts the
  `x-bwdd-upstream` header for full CMOA acceleration. Older bridges still work;
  they are simply treated as BookWalker-only, and CMOA runs on the page and
  trailing-dot lanes.

### Tests
- CMOA lane coverage: the proxy ports are used when the bridge is generic, the
  upstream is named correctly, and a BookWalker-only bridge is never used for
  CMOA pages.

## v1.6.1

First round of fixes from testing against the live CMOA reader.

### Fixed
- **The volume was named after the reader, not the book.** On the real site the
  viewer rewrites `document.title` to its own label ("BinB Speed Reader"), and
  the store's SEO title advertises whichever volume the page is optimised for.
  The content-info request that carries the trustworthy `SubTitle` was only made
  when the contents server or token were still unknown, and on a live page the
  resource-timing timeline has supplied both long before the panel appears, so
  it was skipped. It is now also made while the title is unknown, and the title
  falls back through the reader's own header element before `document.title`.
  A title that cleans down to a viewer/store label is rejected outright rather
  than becoming the volume's name.

### Changed
- **CMOA downloads now use the shared transport lanes.** They previously called
  `GM_xmlhttpRequest` directly, which is a single lane and gets no benefit from
  the bridge's fetch-proxy ports, so a CMOA download stayed at roughly one page
  per request round-trip no matter how many ports the mokuro bridge advertised.
  Pages now go through `laneFetch()` like the BookWalker path, the proxy ports
  are discovered before a run, and the page worker count is sized from
  `fetchSocketBudget()` instead of a hardcoded six.
- **The CMOA image quality ladder was inverted and out of range.** The reader's
  own `getImageUrl()` sets `q` as `this.bt ? "0" : "1"` for the non-direct server
  types: `q=0` when high-quality images are requested, `q=1` for the ordinary
  viewer default, and it never requests `2` or `3` at all. The ladder was
  `['3','2','1']`, i.e. it started at the worst rung, never attempted the best
  one, and burned a refused request on every page of the first batch. It is now
  `['0','1']`, overridable with `window.__bwddCmoaQualityOrder`.

### Tests
- Added `tests/test_cmoa_ocr.js` (16 checks): a stub mokuro bridge over the real
  protocol plus a local HTTPS storefront reached as `www.cmoa.jp` via Chrome's
  host resolver, asserting the CMOA OCR path end to end: the session opens with
  the shared archive name, pages arrive once each in reading order as
  `page-NNNN.jpg`, the cover goes early, finalize is consumed, and the bytes the
  bridge receives are pixel-verified as *descrambled* pages. The title checks
  reproduce the live condition (viewer-renamed `document.title`, contents server
  and page token already known) and are confirmed to fail against the previous
  logic.
- Corrected `tests/test_cmoa_adapter.js` to the real quality ladder.

## v1.6.0

### Added

- **BookWalker pages are named after the manifest source they came from.** A page rebuilt from `OEBPS/text/cover.xhtml` is now `0001 cover.jpg` instead of `page-0001.jpg`, in the ZIP, in the filename sent to mokuro-bridge and in the page cache, with the four-digit ordinal kept first so a plain name sort is still reading order. Merged from PR #1 by [@ChristopherFritz](https://github.com/ChristopherFritz); the trial ZIP keeps manifest-derived names for multiple images from one source file. Covered by `tests/test_bookwalker_naming.js`.
- **CMOA support.** The script now also runs on `cmoa.jp/bib/speedreader/` pages
  and downloads the open volume as a ZIP, with the same panel, controls, ZIP
  naming, reading-stat cards and mokuro-bridge OCR/upload pipeline as
  BookWalker. Pages are re-fetched at the best quality the CDN accepts and
  reassembled with the viewer's own tile geometry.
- A site-adapter layer: `src/core/` is shared by both stores, and only the
  store-specific protocol lives in `src/sites/bookwalker/` and `src/sites/cmoa/`.
- A shared run harness (`src/core/61-run-harness.js`) that owns the bars,
  progress reporting, the Mokuro session lifecycle, ZIP assembly and run
  outcomes, so the two stores cannot drift apart.
- `npm run build` / `npm run check:build`, and `src/README.md` documenting the
  layout and the adapter contract.

### Changed

- **The userscript is now built from `src/`.** The checked-in `.user.js` is
  generated by `build.mjs`; edit the sources, not the artifact. The first
  split was verified byte-identical to the previous hand-maintained file.
- Script renamed to **BookWalker + CMOA Native Downloader** and the metadata
  block now matches `cmoa.jp/bib/speedreader/*`, with `@connect` entries for the
  CMOA image CDN.
- Panel branding follows the store it is running on.

### Fixed

- The CMOA image fetch no longer sends credentials to the image CDN. The CDN URL
  is self-signed and needs no cookies, and sending them made the request fail
  CORS preflight.

### Tests

- New `tests/test_cmoa_adapter.js` (14 checks): drives a full ZIP download on a
  synthetic `cmoa.jp` speed-reader page: adapter detection, panel branding,
  clean-title extraction, shared archive naming, the quality/token retry ladder,
  flat `page-NNNN.jpg` entries, and pixel-level verification that a shuffled page
  is reassembled correctly.
- New `tests/test_site_dispatch.js` (11 checks): pins adapter selection per host,
  that each adapter still installs its own network capture, and that a host no
  adapter claims falls back to BookWalker.

## v1.5.1

### Changed

- Descrambling now batches two JPEG pages per worker (up to 16 workers), while
  lossless WebP and PNG retain a one-page queue.
- Prefetched page Blobs are handed to workers instead of being downloaded twice;
  ZIP CRCs are calculated in a worker and single-flight cache pruning keeps the
  page cache bounded.
- The transport pipeline is bounded by active transport capacity plus a small
  Blob-to-worker handoff margin. Discovered proxy ports are source-aware,
  parked/recovered safely, and no longer count after their local transport
  disappears.
- The GitHub link in the panel is clickable again, and the bridge destination
  default no longer reads the popover element by mistake.

### Performance

A real 1,099-page / 637.4 MB run completed in **24.8s** with the bridge's default
48 ports. A 64-port run took 27.3s, so 48 remains the default; 64 remains an
opt-in upper bound. The userscript release does not change the mokuro-bridge
repository or its configuration.

### Maintenance

- The default test suite is hermetic; the live bridge end-to-end check is now
  opt-in because it requires a separate bridge checkout and running service.
- Removed duplicate assertions and dead test fixtures while retaining coverage
  for lane fallback, parking, codec equivalence, ZIP/CRC, UI behavior and the
  header link.

## v1.5.0

Chrome allows 6 concurrent HTTP/1.1 connections per *origin*, and BookWalker's
page CDN is a single HTTP/1.1 host, so a page lane alone is pinned at 6 for the
whole run. This release routes page requests through every other origin the
browser will accept, and roughly doubles descrambling speed.

### Added

- **Transport lanes.** Requests go to the least-utilised of:
  - **page**: the page's own `fetch()` (6 sockets).
  - **gm**: `GM_xmlhttpRequest`, which runs in Tampermonkey's background context
    and keeps its own pool (6 more).
  - **dot**: a trailing-dot host, which Chrome treats as a separate site and so a
    separate pool (6 more). Self-verifying: it enables only when a real page
    returns 200 through it, so a refusal costs one request.
  - **px:N**: one lane per fetch-proxy port exposed by mokuro-bridge. A port is
    part of the origin, so each is another 6-socket pool. This is the lane that
    scales, and the source of the 294-socket figure below.
  - **edge**: an optional HTTP/2 mirror lane, strictly opt-in because it routes
    the signed URL through a third party.
- **Connection readout.** The `?` beside the bridge row reports how many ports,
  sockets and decode workers the next run will use, and where the numbers come
  from. It also works with the bridge down, and says so.
- **Image format picker.** JPEG (default, q0.92), WebP, lossless or PNG, behind a
  collapsed **Image format** row that shows the active setting. Quality is hidden
  for the lossless settings rather than offered pointlessly.
- **Prefetch window tied to the real socket budget.** The previous fixed clamp of
  64 meant that with 32 proxy ports, and so 192 available sockets, only 64
  requests could ever be in flight.

### Changed

- **Descrambling is about 2x faster** (100 to 208 pages/s on a 14-core machine).
  Profiling showed 83% of the cost was JPEG decode and encode rather than the
  tile copy, so tiles are now drawn straight onto the output canvas instead of
  being read back and written out through `getImageData`/`putImageData`. Output
  is byte-identical to the previous descrambler across six tile geometries.
- **Worker pool sizing** is derived from the CPU count by one shared helper,
  raised from a cap of 24 to 32.
- **A failed helper port is parked rather than deleted.** A wide burst can fail
  every port at once, and deleting them cascaded into a collapse back onto the
  page lane.

### Fixed

- **The GM lane never worked.** `@connect` listed only the reading-stats hosts
  and not the page CDN, so every `GM_xmlhttpRequest` was refused and the lane was
  dead weight. Both the CDN and `*.bookwalker.jp` are now declared. Tampermonkey
  captures grants at install time, so this one needs a reinstall rather than an
  update.
- **The bridge row claimed "online" with no bridge running.** The health check
  forgives missed polls so the OCR button does not flap, which meant a cold page
  load advertised "Mokuro online" for the first couple of polls. Misses are now
  forgiven only once the bridge has answered at least once.
- **Tooltips were cut off.** The `?` popovers opened from inside the scrolling
  panel column, whose `overflow` clipped them; the bridge popover is taller than
  the column it lives in. They are now positioned against the viewport, so they
  extend past their card instead of being truncated, and flip above the anchor
  when there is no room below.
- **Port discovery re-probed a dead helper** every ten seconds, each attempt
  logged by the browser as a console error.
- **The socket readout contradicted itself**, quoting "6 connections" beside a
  count that already included the GM lane. Both now derive from one number.
- **The panel reported a hardcoded version** rather than the one the userscript
  manager has installed.

### Performance

Measured on a 1600x2400 manga page with 70 tiles, 14 cores:

| | before | after |
| --- | --- | --- |
| Descramble | 100 pages/s | **208 pages/s** |
| Concurrent sockets, bridge up | 6 | **294** |
| Concurrent sockets, bridge down | 6 | 12 to 18 |

With no bridge at all, a run still uses the page, GM and trailing-dot lanes at
once, and picks up the remaining sockets as soon as mokuro-bridge is started.
