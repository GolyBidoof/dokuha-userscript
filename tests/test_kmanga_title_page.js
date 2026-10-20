#!/usr/bin/env node
'use strict';
/*
 * Reading a k-manga title page's reading offers.
 *
 * The markup is lifted from the live page, and the distinction it pins is the
 * one that made samplers invisible: a **free** volume is rendered as a real
 * link, while a **sample** or campaign volume is rendered as a button with no
 * href at all -- title.js fills the href in on DOMContentLoaded from the page's
 * own settings plus the button's data-chapter-* attributes. A parser that only
 * follows hrefs therefore reports two volumes for a title that offers ten, and
 * calls the other eight non-existent rather than merely not free.
 *
 * The attribute casing is pinned too, because it differs by source: the live
 * page writes data-chapter-readType, and a browser-saved copy writes
 * data-chapter-readtype, since serialising a DOM lowercases names.
 */
const { launch, reporter } = require('./_kmanga');

const TITLEJS = '<script data-src="/js_new/sp_page/title/title.js" id="titlejs"'
    + ' data-book="100007" data-format-type="pv" data-fcipath="1" data-viewer-id-html="0"'
    + ' data-viewer-id-pc="3" data-quality-default="1" data-quality-normal="0" data-quality-high="1"></script>';

const FREE_LINK = '<a href="/viewer-launcher/3/1/100007/pv/1/1/4/0/0"'
    + ' class="book-chapter--btn book-chapter--btn__jikuri gaevent-detail-notlogin-btn-free"'
    + ' target="_blank" rel="nofollow">無料で読む</a>';

const SAMPLE_BUTTON = '<a class="btn book-chapter--btn__sample x-invoke-viewer--btn__selector gaevent-detail-chapter-read-sample"'
    + ' data-chapter-exid="3" data-chapter-fcipath="1" data-chapter-readType="0" data-chapter-fcid="0"'
    + ' data-chapter-fcupdated="0" rel="nofollow">試し読み</a>';

const NAME_LD = '<script type="application/ld+json">{"@type": "ProductGroup", "name": "サンプル作品",'
    + ' "url": "https://comic.k-manga.jp/title/100007/pv"}</script>';

(async () => {
    const { check, finish } = reporter();
    const { browser, page, ready } = await launch();
    try {
        check('the k-manga adapter boots and publishes its protocol surface', ready, 'window.__bwddKmangaProtocol');

        const got = await page.evaluate((titlejs, freeLink, sampleButton, nameLd) => {
            const P = window.__bwddKmangaProtocol;
            const out = {};

            // A button with no href still has to become a usable launcher.
            const sample = P.parseTitlePage(titlejs + sampleButton);
            out.sampleCount = sample.volumes.length;
            out.sampleVolume = sample.volumes[0] ? sample.volumes[0].volume : null;
            out.sampleIsSample = sample.volumes[0] ? sample.volumes[0].sample : null;
            out.sampleReadType = sample.volumes[0] ? sample.volumes[0].readType : null;
            out.sampleLauncher = sample.volumes[0] ? sample.volumes[0].launcher : null;

            // A rendered link is used as-is, and is a whole free read.
            const free = P.parseTitlePage(titlejs + freeLink);
            out.freeLauncher = free.volumes[0] ? free.volumes[0].launcher : null;
            out.freeIsSample = free.volumes[0] ? free.volumes[0].sample : null;

            // A browser-saved copy: lowercased attributes and the href the
            // browser wrote in. Both spellings have to read the same.
            const saved = '<a class="btn book-chapter--btn__sample x-invoke-viewer--btn__selector gaevent-detail-chapter-read-sample"'
                + ' data-chapter-exid="4" data-chapter-fcipath="1" data-chapter-readtype="0" data-chapter-fcid="0"'
                + ' data-chapter-fcupdated="0" rel="nofollow" href="https://comic.k-manga.jp/viewer-launcher/3/1/100007/pv/4/1/0/0/0"'
                + ' target="_blank"> 試し読み </a>';
            const savedPage = P.parseTitlePage(titlejs + saved);
            out.savedReadType = savedPage.volumes[0] ? savedPage.volumes[0].readType : null;
            out.savedIsSample = savedPage.volumes[0] ? savedPage.volumes[0].sample : null;
            out.savedLauncher = savedPage.volumes[0] ? savedPage.volumes[0].launcher : null;

            // A whole page: every offer listed, sorted by volume, with the free
            // read winning over a sample of the same volume.
            const html = nameLd + titlejs + freeLink + sampleButton
                + '<a class="btn book-chapter--btn__sample x-invoke-viewer--btn__selector" data-chapter-exid="1"'
                + ' data-chapter-fcipath="1" data-chapter-readType="0" data-chapter-fcid="0" data-chapter-fcupdated="0">試し読み</a>'
                + '<a href="/viewer-launcher/3/1/100007/pv/2/1/4/0/0" class="gaevent-detail-notlogin-chapter-img" rel="nofollow">無料で読む</a>';
            const whole = P.parseTitlePage(html);
            out.name = whole.name;
            out.volumes = whole.volumes.map(v => v.volume);
            out.firstSample = whole.volumes[0] ? whole.volumes[0].sample : null;
            out.firstReadType = whole.volumes[0] ? whole.volumes[0].readType : null;
            out.secondSample = whole.volumes[1] ? whole.volumes[1].sample : null;
            out.thirdSample = whole.volumes[2] ? whole.volumes[2].sample : null;

            // Without the settings element, the prefix comes off a rendered free
            // link; with neither, the button is skipped rather than guessed at.
            const noSettings = P.parseTitlePage(freeLink + sampleButton);
            out.fallbackLauncher = noSettings.volumes[1] ? noSettings.volumes[1].launcher : null;
            const orphan = P.parseTitlePage(sampleButton);
            out.orphanCount = orphan.volumes.length;

            // Anchors that are not reading offers must not become volumes.
            const noise = titlejs + '<a class="btn" href="/title/100007/vol/1">サンプル作品(1)</a>'
                + '<a href="/register/" class="btn">会員登録</a>';
            out.noiseCount = P.parseTitlePage(noise).volumes.length;

            const parsed = P.parseLauncherUrl('/viewer-launcher/3/1/100007/pv/5/1/0/0/0');
            out.lBookId = parsed ? parsed.bookId : null;
            out.lVolume = parsed ? parsed.volume : null;
            out.lReadType = parsed ? parsed.readType : null;
            out.lNotLauncher = P.parseLauncherUrl('/title/100007/vol/5');
            return out;
        }, TITLEJS, FREE_LINK, SAMPLE_BUTTON, NAME_LD);

        const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected),
            'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));

        eq('a button with no href is still found', got.sampleCount, 1);
        eq('its volume comes from data-chapter-exid', got.sampleVolume, 3);
        check('it is classified as a sample', got.sampleIsSample === true, String(got.sampleIsSample));
        eq('its read type is read from the capital-T attribute', got.sampleReadType, 0);
        eq('its launcher is rebuilt the way the page\u2019s script would build it', got.sampleLauncher,
            'https://comic.k-manga.jp/viewer-launcher/3/1/100007/pv/3/1/0/0/0');

        eq('a rendered link is used verbatim', got.freeLauncher,
            'https://comic.k-manga.jp/viewer-launcher/3/1/100007/pv/1/1/4/0/0');
        check('read type 4 is a whole free read', got.freeIsSample === false, String(got.freeIsSample));

        eq('a lowercased read type reads the same', got.savedReadType, 0);
        check('and is still a sample', got.savedIsSample === true, String(got.savedIsSample));
        eq('and keeps the href the browser wrote', got.savedLauncher,
            'https://comic.k-manga.jp/viewer-launcher/3/1/100007/pv/4/1/0/0/0');

        eq('the series name comes from the structured data', got.name, 'サンプル作品');
        eq('every offer is listed, sorted by volume', got.volumes, [1, 2, 3]);
        check('the free read wins over a sample of the same volume', got.firstSample === false, String(got.firstSample));
        eq('the free read keeps its own read type', got.firstReadType, 4);
        check('volume 2 is a free read too', got.secondSample === false, String(got.secondSample));
        check('volume 3 is a sample', got.thirdSample === true, String(got.thirdSample));

        eq('the fallback reads the prefix off a rendered link', got.fallbackLauncher,
            'https://comic.k-manga.jp/viewer-launcher/3/1/100007/pv/3/1/0/0/0');
        eq('a button with neither is skipped, not invented', got.orphanCount, 0);
        eq('ordinary links are not volumes', got.noiseCount, 0);

        eq('the book id is the fourth segment', got.lBookId, '100007');
        eq('the volume is the sixth', got.lVolume, 5);
        eq('the read type is the eighth', got.lReadType, 0);
        eq('a non-launcher path is refused', got.lNotLauncher, null);
    } finally {
        await browser.close().catch(() => {});
    }
    finish();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
