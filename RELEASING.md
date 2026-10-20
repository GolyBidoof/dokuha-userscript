# Releasing

## The short version

```bash
npm run bump minor     # patch | minor | major | x.y.z; bumps the core version,
                       # README title and package.json, then rebuilds every artifact
# add the "## vX.Y.Z" section to CHANGELOG.md
npm test               # the whole userscript suite (31 files, browser fixtures)
git add -A && git commit -m "Release vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

Two things about that last line, both learned the hard way:

- **The tag push is what starts the release.** If the tag goes up in the same push that introduces `.github/workflows/release.yml` for the first time, GitHub does not run it for that push. `gh workflow run release.yml` publishes from the default branch instead, which is why that file also has a `workflow_dispatch` trigger.
- **Never delete a release tag.** Deleting a tag that a published release points at silently turns the release into a **draft**. `releases/latest/download/...` then stops resolving, so installed scripts stop finding updates. Re-pushing the tag does not repair it either, because the workflow's "already released?" guard skips the publish step. `gh release edit vX.Y.Z --draft=false` is the fix, and `gh release view vX.Y.Z --json isDraft,assets` is the check: `draft=false` and six assets.

**Pushing to `main` publishes nothing.** `ci.yml` builds every artifact, proves the committed files match `src/` and compile, and runs the full suite, and that is all it does. Work in progress can sit on `main` for as long as you like.

**Tagging publishes.** `release.yml` runs on a `v*` tag: it checks the tag against the version in `src/core/00-identity.js`, runs the same build-and-test gate, publishes a GitHub Release with every artifact attached (the `CHANGELOG.md` section for that tag is the body), and then refreshes the `release` branch.

A tag that disagrees with the core version fails rather than mislabelling a release, and re-running for an already-published version is a no-op. `workflow_dispatch` runs it by hand if you need to re-publish. How the artifacts themselves are assembled is covered in [docs/architecture.md](docs/architecture.md); this file covers only how a release is cut.

## The `release` branch, and why GreasyFork reads it

GreasyFork's source sync needs a raw URL that it re-fetches periodically. A raw URL on `main` would mean **every push could become a published update** to everyone who has the script installed, which is exactly what you do not want while work is in progress. So the release workflow maintains a `release` branch holding **nothing but the built artifacts**, refreshed only when a release is cut.

One rule follows: *`main` is what you are working on, `release` is what the world has.* Push to `main` freely; the GreasyFork entries do not move until you tag.

Until the first release the `release` branch does not exist, so the sync URL 404s and GreasyFork has nothing to pull. That is the safe default: there is nothing to configure early and nothing that can leak.

The repository is `GolyBidoof/dokuha-userscript` (renamed from `bookwalker-ebookjapan-cmoa-native-downloader`, itself renamed from `bookwalker-native-downloader` at v2.0.0; GitHub redirects the old URLs, so existing installs keep working).

## Installing, and how updates arrive

Each artifact declares:

```
// @updateURL    https://github.com/GolyBidoof/dokuha-userscript/releases/latest/download/<artifact>.user.js
// @downloadURL  https://github.com/GolyBidoof/dokuha-userscript/releases/latest/download/<artifact>.user.js
```

Install once and the userscript manager checks that URL for a new `@version`. `releases/latest/download/…` is stable across releases and always resolves to the newest published one, a release asset rather than a raw branch URL, for the same reason GreasyFork reads `release`: un-published work must not become somebody's update.

A manager re-reads a script **only when `@version` changes**, so a version bump is what actually ships a fix. Rebuilding without bumping is invisible to anyone who already installed it.

## GreasyFork

### Setting up source sync

GreasyFork has **no upload API**: automating an upload means logging in with account credentials plus a TOTP secret and driving the web forms, which breaks whenever the site changes and puts credentials into CI secrets. Nothing here does that. GreasyFork's own sync is the supported route, and it is one setting per script entry:

- **sync type**: `webhook`
- **sync source**: the artifact's raw URL on the `release` branch

`npm run sync-urls` prints that URL for every target. GreasyFork re-checks the URL periodically and pulls the file when `@version` changes, so after the one-time setup a release is the only thing you do. Its sync page also has a **sync now** button if you would rather not wait for the next poll.

The existing entry is [594508 · BookWalker Native Downloader](https://greasyfork.org/en/scripts/594508-bookwalker-native-downloader), currently v1.5.1. It keeps serving 1.5.1 until a release puts a newer version on the `release` branch.

### Which URL goes in which entry (read this before pasting)

At v1.5.1 there was one artifact, `bookwalker-native-downloader.user.js`, and entry 594508 served it. In v2.0.0 that content is the **BookWalker-only** script (`@name BookWalker Native Downloader`) and the *combined* script is a different file with a different name. **Pointing 594508 at `dokuha-userscript.user.js` would silently turn the entry into the combined script**: it would gain `@match` rules for the other stores it was never reviewed for, and it would collide with the combined entry.

The old `bookwalker-native-downloader.user.js` name no longer exists in any release, so a 594508 still pointing at it simply stops updating. It will not silently change contents.

| GreasyFork entry | Artifact to sync | `@name` it will carry |
| --- | --- | --- |
| 594508 (existing, still serving v1.5.1) | `bookwalker-only.user.js` | BookWalker Native Downloader |
| [597313](https://greasyfork.org/en/scripts/597313-dokuha-userscript) | `dokuha-userscript.user.js` | dokuha-userscript |
| [597317](https://greasyfork.org/en/scripts/597317-cmoa-native-downloader) | `cmoa-only.user.js` | CMOA Native Downloader |
| [597318](https://greasyfork.org/en/scripts/597318-ebookjapan-native-downloader) | `ebookjapan-only.user.js` | ebookjapan Native Downloader |

The Kindle and k-manga single-store builds ship as artifacts but have no GreasyFork entry yet; `npm run sync-urls` prints their raw URLs the moment one is created.

Entry 597313 was repointed when v3.0.0 shipped and now serves the combined script: its title, code and listing are the v3 ones, and its version follows `dokuha-userscript.user.js` on the `release` branch. Later releases need nothing beyond the tag; GreasyFork pulls the new `@version` on its next poll, or immediately from the entry's **sync now** button.

All six artifacts are committed on `main` as of v3.0.0, so their raw `main` URLs resolve. GreasyFork should still sync from the `release` branch, which only ever carries published versions.

### Listing copy

Each entry's description is **not** synced either: GreasyFork replaces code only. Paste it by hand when it changes. The paste-ready copy lives in `docs/greasyfork/`, one file per entry:

| Entry | Listing copy |
| --- | --- |
| 597313 dokuha-userscript | `docs/greasyfork/dokuha-userscript.html` |
| 594508 BookWalker Native Downloader | `docs/greasyfork/bookwalker-native-downloader.html` |
| 597317 CMOA Native Downloader | `docs/greasyfork/cmoa-native-downloader.html` |
| 597318 ebookjapan Native Downloader | `docs/greasyfork/ebookjapan-native-downloader.html` |

The files are HTML, because that is what the description field takes. Every tag in them is on [GreasyFork's allowed-markup list](https://greasyfork.org/en/help/allowed-markup) (`p`, `ul`, `li`, `strong`, `code`, `a href`), and nothing else is used.

The combined build and the single-store builds advertise different things: the "also available on" store pills exist only in the combined script, and each single-store script instead carries a pill linking to it. Do not paste the combined copy into a single-store entry.

### Size

GreasyFork's limit is 2 MB. The combined artifact is the largest at ~872 KB and the splits run 291-527 KB, so all six fit.

### The changelog

Source sync replaces the **code**; the per-version changelog is a separate field on GreasyFork, and sync does not fill it. That matches what is already on the entry: v1.5.1 carries a pasted `CHANGELOG.md` section (heading and all) and v1.1.0 a hand-written line. Two ways to keep it:

- **Paste it.** `node tools/release-notes.mjs v3.0.0` prints the section with the `## vX.Y.Z` heading stripped, which is what the field wants: GreasyFork already shows the version above it, so the heading in the v1.5.1 paste is redundant. One paste per entry per release.
- **Do not duplicate it.** Put a link to the [releases page](https://github.com/GolyBidoof/dokuha-userscript/releases) in each entry's description and let the release carry the notes. Nothing recurring, at the cost of bare version numbers in GreasyFork's version list.

Either way there is one wrinkle: all six artifacts share a version and a changelog, so a BookWalker-only reader gets notes about the CMOA build and the cross-store card. Trimming those lines while pasting is the cheap answer; splitting `CHANGELOG.md` per target is the expensive one.

Unverified: GreasyFork's *additional-info* sync might carry the changelog automatically (the field names in its form suggest a raw URL plus a `##<lang>` suffix, but the settings page renders client-side and I could not read it). Worth a look on the entry's settings after the first sync.

## CI prerequisites, and two rough edges

- **`package-lock.json` is gitignored**, so CI runs `npm install` rather than `npm ci`. That means dependency versions float between runs. Committing the lockfile would make CI reproducible; it is left alone here because ignoring it was deliberate.
- **Chrome**: `npm install` fetches it through puppeteer, and the workflows also run `npm run browser` as a no-op safety net. The browser tests run headless on `ubuntu-latest` with `--no-sandbox`.
- `tests/tls/*.pem` are committed, so the local HTTPS storefront fixtures work in CI without generating certificates.
