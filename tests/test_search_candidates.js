#!/usr/bin/env node
'use strict';
/*
 * Title-candidate checks for the shared searchTitleCandidates() builder.
 *
 * Amazon/Kindle document titles carry the imprint after the volume:
 * "サンプル作品 モノクロ版 1 (サンプルコミックスDIGITAL)". Searching that
 * verbatim finds nothing on manga-kotoba or LearnNatively, so the builder has
 * to offer the label-free title as a fallback without dropping the original
 * candidate (the cross-store "search" links and the first lookup attempt use
 * it). The conservative half matters just as much: (上)/(下)/(前編) and a bare
 * volume number such as （１） are part of the title, not shop metadata, and
 * must not be stripped. This file pins both sides plus the 【...】 behaviour
 * the builder already had.
 *
 * The fragment is evaluated in a vm the way build.mjs concatenates it. Only
 * declarations are needed, so no DOM or network stubs are required.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const check = (name, pass, detail) => {
    results.push({ name, pass });
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
};
const equal = (name, got, want) => check(name,
    JSON.stringify(got) === JSON.stringify(want),
    'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));

// Just enough DOM and network for lookupMangaKotoba: a response prefixed
// "SERIES|" renders one series card, anything else renders no rows at all.
const fetched = [];
const responses = {
    ['https://manga-kotoba.com/search/series/?q='
        + encodeURIComponent('サンプル作品 20 (サンプルレーベルコミックス)')]: 'SERIES|サンプル外伝|/series/wrong',
    ['https://manga-kotoba.com/search/series/?q=' + encodeURIComponent('サンプル作品')]: 'SERIES|サンプル作品|/series/right',
    'https://manga-kotoba.com/series/right': 'EMPTY',
};
const fakeDoc = (text) => ({
    querySelectorAll(sel) {
        if (!String(text).startsWith('SERIES|') || !/\/series\//.test(sel)) return [];
        const title = String(text).split('|')[1];
        const href = String(text).split('|')[2];
        return [{
            textContent: title + '\nsome card text',
            querySelector: () => ({ textContent: title }),
            getAttribute: (name) => (name === 'href' ? href : null),
        }];
    },
});
const code = fs.readFileSync(path.join(ROOT, 'src/core/30-stats.js'), 'utf8')
    + '\n;globalThis.__candidates = searchTitleCandidates;'
    + '\nglobalThis.__lookupMk = lookupMangaKotoba;';
const sandbox = {
    console,
    BWDD_DEBUG: false,
    safeLogText: (x) => String(x),
    DOMParser: function DOMParser() { this.parseFromString = (text) => fakeDoc(text); },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
// gmFetch is a function declaration in the fragment, so it has to be replaced
// after the fragment is evaluated; a same-named sandbox property would be
// shadowed by it.
sandbox.gmFetch = async (url) => {
    fetched.push(url);
    return { status: 200, text: responses[url] != null ? responses[url] : 'EMPTY' };
};
const candidates = sandbox.__candidates;
const lookupMk = sandbox.__lookupMk;
const has = (list, want) => list.indexOf(want) !== -1;

// ---- the three reported titles --------------------------------------------
const FIRST = 'サンプル作品 モノクロ版 1 (サンプルコミックスDIGITAL)';
const SECOND = 'サンプル作品 20 (サンプルレーベルコミックス)';
const THIRD = '別作品 1 (ヤングサンプルコミックスDIGITAL)';

equal('the original first title stays the first candidate', candidates(FIRST)[0], FIRST);
equal('the original second title stays the first candidate', candidates(SECOND)[0], SECOND);
equal('the original third title stays the first candidate', candidates(THIRD)[0], THIRD);

equal('the first title yields the label-free title and then the volume-less base',
    candidates(FIRST).slice(1), ['サンプル作品 モノクロ版', 'サンプル作品']);
equal('the second title yields the volume- and label-free title',
    candidates(SECOND).filter((c) => c !== SECOND), ['サンプル作品']);
equal('the third title yields the volume- and label-free title',
    candidates(THIRD).filter((c) => c !== THIRD), ['別作品']);

// ---- the label itself never reaches a fallback -----------------------------
// The first candidate is the raw title by design; every other candidate has to
// be a real searchable name, so no imprint token may survive in them.
{
    const lookups = [[FIRST, 'サンプルコミックスDIGITAL'], [SECOND, 'サンプルレーベルコミックス'], [THIRD, 'ヤングサンプルコミックスDIGITAL']];
    const leaks = [];
    for (const [title, label] of lookups) {
        for (const c of candidates(title).slice(1)) if (c.indexOf(label) !== -1) leaks.push(c);
    }
    equal('no fallback candidate keeps the imprint label', leaks, []);
}

// ---- shape of every candidate list ----------------------------------------
{
    const all = [
        FIRST, SECOND, THIRD,
        '【期間限定】サンプル冒険譚 1【無料】',
        'サンプル冒険譚（１）',
        'サンプル英雄譚 (上)',
        'サンプル英雄譚（下）',
        'サンプル活劇 無限編 (前編)',
        'サンプル冒険譚 後編 (後編)',
        'サンプル学園録 1 (サンプル文庫)',
        'サンプル冒険譚 3 (サンプルデラックス)',
        'TITLE 1 (サンプルコミックス)',
        'TITLE (サンプルコミックス) 1',
        'テスト（新装）',
        'サンプル冒険譚 3巻',
        'TITLE(DIGITAL)',
        'サンプル作品 (公式ガイドブック)',
    ];
    const empty = [], dupes = [], firstWrong = [];
    for (const raw of all) {
        const list = candidates(raw);
        if (!list.length) empty.push(raw);
        if (list.some((c) => !String(c || '').trim())) empty.push(raw);
        if (new Set(list).size !== list.length) dupes.push(list);
        if (list[0] !== String(raw).trim()) firstWrong.push([raw, list[0]]);
    }
    equal('an empty title yields no candidates', candidates(''), []);
    equal('no candidate list is empty', empty, []);
    equal('no candidate list repeats a candidate', dupes, []);
    equal('the trimmed raw title is always first', firstWrong, []);
}

// ---- 【...】 handling is unchanged ------------------------------------------
equal('【...】 decorations are dropped without losing the original',
    candidates('【期間限定】サンプル冒険譚 1【無料】'),
    ['【期間限定】サンプル冒険譚 1【無料】', 'サンプル冒険譚 1', 'サンプル冒険譚']);

// ---- real title parts are not mistaken for a label -------------------------
equal('a bare full-width volume number is title, not metadata',
    candidates('サンプル冒険譚（１）'), ['サンプル冒険譚（１）']);
equal('（上） is not stripped', candidates('サンプル英雄譚 (上)'),
    ['サンプル英雄譚 (上)']);
equal('（下） is not stripped', candidates('サンプル英雄譚（下）'),
    ['サンプル英雄譚（下）']);
equal('（前編） is not stripped', candidates('サンプル活劇 無限編 (前編)'),
    ['サンプル活劇 無限編 (前編)']);
equal('（後編） is not stripped', candidates('サンプル冒険譚 後編 (後編)'),
    ['サンプル冒険譚 後編 (後編)']);
equal('a non-label parenthetical is not stripped',
    candidates('サンプル作品 (公式ガイドブック)'), ['サンプル作品 (公式ガイドブック)']);

// ---- volume markers still come off (existing behaviour) --------------------
equal('a trailing 巻 marker still yields the base title',
    candidates('サンプル冒険譚 3巻'), ['サンプル冒険譚 3巻', 'サンプル冒険譚']);

// ---- a volume on either side of the label ---------------------------------
check('"TITLE 1 (label)" yields TITLE',
    has(candidates('TITLE 1 (サンプルコミックス)'), 'TITLE'),
    JSON.stringify(candidates('TITLE 1 (サンプルコミックス)')));
check('"TITLE (label) 1" yields TITLE',
    has(candidates('TITLE (サンプルコミックス) 1'), 'TITLE'),
    JSON.stringify(candidates('TITLE (サンプルコミックス) 1')));
equal('a half-width (DIGITAL) label is stripped', candidates('TITLE(DIGITAL)'), ['TITLE(DIGITAL)', 'TITLE']);
equal('a（新装）edition group is stripped', candidates('テスト（新装）'), ['テスト（新装）', 'テスト']);

// ---- the old paren-edition strip used to mangle a longer label -------------
// "サンプル学園録 1 (サンプル文庫)" lost only "文庫)", leaving "… (サンプル" as a
// candidate. The label-free variant has to be the whole base title.
{
    const list = candidates('サンプル学園録 1 (サンプル文庫)');
    equal('the label-free サンプル文庫 title is generated',
        list.filter((c) => c !== 'サンプル学園録 1 (サンプル文庫)'),
        ['サンプル学園録']);
    equal('no candidate carries a half-eaten parenthetical',
        list.filter((c) => /[（(][^（）()]*$/.test(c)), []);
}

// ---- stable and side-effect free -------------------------------------------
equal('two calls return the same candidates',
    candidates(FIRST), candidates(FIRST));

// ---- the lookup walks past a wrong fuzzy hit -------------------------------
// "サンプル作品 20 (サンプルレーベルコミックス)" returns サンプル外伝 on manga-kotoba,
// and one unrelated card used to end the candidate walk, so the label-free
// title was never queried. The lookup has to reach the second candidate.
(async () => {
    try {
        const hit = await lookupMk(SECOND, 20);
        equal('the label-free title is queried after the wrong fuzzy hit',
            fetched.filter((u) => u.indexOf('/search/series/') !== -1).map((u) => decodeURIComponent(u.split('?q=')[1])),
            [SECOND, 'サンプル作品']);
        equal('the lookup resolves the real series', hit && hit.seriesUrl,
            'https://manga-kotoba.com/series/right');
    } catch (e) {
        check('the lookup walks past a wrong fuzzy hit', false, String(e && e.message));
    }
    const failed = results.filter((r) => !r.pass);
    console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
    process.exit(failed.length ? 1 : 0);
})();
