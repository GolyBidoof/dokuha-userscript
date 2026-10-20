# Contributing

## The two rules

1. **Never edit a `.user.js` by hand.** Every artifact is the concatenation of the fragments in `src/` in manifest order, and the committed file is meant to be exactly what the build produces. Edit `src/`, then run `npm run build`; `npm run check:build` fails when the two disagree, and CI runs it before the tests.
2. **Keep the fragments readable.** There is no bundler and no minifier, so the shipped script can be read and diffed against the repository line for line. A change that needs a build step is a change worth not making.

## Adding or changing a store

A store is a module under `src/sites/<store>/`, listed in `src/manifest.json` and selected by `src/targets.json`. It implements the adapter contract: which hosts it matches, how it reads the viewer, how it plans the page list, how it fetches one page and how it rebuilds that page offline. The shared core around it (panel, progress, page cache, archive writer, transport lanes, bridge hand off, automation API) is not the place for a store's quirks.

When a protocol detail is non-obvious, record it in `src/sites/<store>/README.md` next to the code, and add the regression to the matching `tests/test_<store>_*.js`. Each store has a hermetic test that runs against a local stub of the viewer, so a protocol change is verifiable without downloading anything.

## Tests

```sh
npm install
npm run build        # assemble every artifact from src/
npm run check:build  # committed artifact equals what src/ builds
npm test             # the full suite, 31 files, headless Chrome plus artifact checks
```

The default suite is hermetic: local stub servers only, no network, no credentials and no real store. Tests that need the outside world are opt-in and excluded from `npm test`: `tests/acceptance/` downloads a real free volume and compares it with dokuha-cli's independent descrambler, and `npm run test:bridge` measures the fetch proxy lanes against a throwaway bridge. See [tests/README.md](tests/README.md) for the file list.

## Commits

Sentence case, imperative, no trailing period. Two prefixes are used:

- `docs: ...` for documentation only
- `vX.Y.Z: ...` for a release

A store-specific change may name the store in the subject (`kmanga: match the reply by scene number`). Large commits get a prose body explaining what changed and why, then bullets, and finish with the test count.

## Releasing

Version bumps, the tag, the GitHub Release and the `release` branch that GreasyFork syncs from are covered in [RELEASING.md](RELEASING.md). Pushing to `main` publishes nothing; a `vX.Y.Z` tag is what ships.
