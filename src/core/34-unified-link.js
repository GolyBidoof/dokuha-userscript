    // Whoever runs this build already chose one store and is the person most
    // likely to want the other stores, so a single-store artifact puts a small
    // link in the panel header; the combined build, "dokuha-userscript",
    // omits this module entirely (it would point at itself). The
    // artifact file name also lives in src/targets.json ("both"), and
    // tests/test_artifacts.js fails if the two ever disagree, so renaming the
    // combined script cannot silently break this.
    const BWDD_UNIFIED_OUT = 'dokuha-userscript.user.js';
    // The GreasyFork install page rather than the release asset: it shows the
    // version and the install button, and it is where the script is reviewed.
    const BWDD_UNIFIED_URL = 'https://greasyfork.org/en/scripts/597313-dokuha-userscript';

    // Styling travels with the feature: a build without this module ships none.
    const UNIFIED_CSS = `
.bwdd-unified {
  display: inline-flex; align-items: center;
  flex-shrink: 0; white-space: nowrap;
  height: 17px; padding: 0 6px;
  border: 1px solid var(--bwdd-border); border-radius: 999px;
  font-size: 10px; font-weight: 600; line-height: 1;
  color: var(--bwdd-text-muted); text-decoration: none;
}
.bwdd-unified:hover { color: var(--bwdd-link); border-color: var(--bwdd-link); background: var(--bwdd-link-hover-bg); text-decoration: none; }
.bwdd-unified:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
`;
    let unifiedStylesMounted = false;
    function mountUnifiedStyles() {
        if (unifiedStylesMounted || typeof document === 'undefined') return;
        unifiedStylesMounted = true;
        try {
            const style = document.createElement('style');
            style.textContent = UNIFIED_CSS;
            (document.head || document.documentElement).appendChild(style);
        } catch (e) {}
    }

    function unifiedDownloaderLink() {
        mountUnifiedStyles();
        // 115px at 10px, which is the most the header row can take before the
        // version line starts to ellipsis; see the header budget in the tests.
        const a = el('a', 'bwdd-unified', 'all-in-one downloader');
        a.href = BWDD_UNIFIED_URL;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        const tip = 'This build handles one store. One all-in-one downloader covers BookWalker, '
            + 'ebookjapan, CMOA, Kindle and k-manga in a single script (' + BWDD_UNIFIED_OUT + ') - get it here: '
            + BWDD_UNIFIED_URL;
        a.title = tip;
        a.setAttribute('aria-label', tip);
        return a;
    }
