// test_availability.js — the cross-store "also available on" card.
//
// Store pages are stubbed with markup copied from the live ones, because that
// markup is the whole problem: BookWalker appends the imprint in brackets, also
// exposes /de<uuid> single-volume pages, and marks a free volume with a 0 price
// plus 無料で読む; CMOA keeps the REGULAR price on a free volume's row, marks
// free only with a 無料で読む block, and paginates its volume list ten rows at a
// time; ebookjapan states no price in its markup at all - only in the Nuxt
// payload, and only on a volume page; Amazon's results are per volume and its
// card shows the Kindle Unlimited zero, so the yen charge comes off the volume's
// own page; k-manga states its prices in points rather than yen, keeps the point
// price on a free volume's row, and paginates its volume list as well; DMMブックス
// serves one server-rendered search card per series and carries the per-volume
// rows in its product page's Next.js flight payload, with the rest of the run
// read from the store's own BFF volume list.
//
// A pill is only rendered for a shop that actually carries the book, and a card
// with no pills is not rendered at all. A shop that misses is still *queried*
// (the hits assertion proves that), it is just not shown. The grid keeps six
// pills to exactly two rows of three, with every store name ellipsis-free, and
// the layout is computed from the pill count rather than a per-count rule.
'use strict';
const puppeteer = require('puppeteer');
const { loadUserscript } = require('./_userscript');
const fs = require('fs');
const path = require('path');
const https = require('https');

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

const SERIES = 'サンプル作品';
const SKIP = 'サンプル跳躍作品';
const ABSENT = 'この本は存在しませんXYZ';

const BW_SEARCH = `<html><body>
  <a href="https://bookwalker.jp/decf5c400b-42c7-4c7f-af26-7181721d9f5e/">${SERIES} 3 (単巻)</a>
  <a href="https://bookwalker.jp/series/900001/list/">サンプル月刊誌</a>
  <a href="https://bookwalker.jp/series/900002/list/">${SERIES}（サンプルコミックス）</a>
  <a href="https://bookwalker.jp/series/999001/list/">１２３サンプル作品（１）</a>
</body></html>`;

// The same title is spelled １２３… (full width) on BookWalker and 123… (half
// width) on k-manga, and the 分冊版 suffix only exists on some stores. The card
// has to reach the base series through a candidate, fold the width, and read the
// volume from the trailing （１） rather than the leading 123.
const BW_DIGITS_SERIES = `<html><body>
  <div class="m-book-item">
    <a class="m-book-item__title" href="https://bookwalker.jp/deaa11bb22-0000-4000-8000-000000000001/" title="１２３サンプル作品（１）">１２３サンプル作品（１）</a>
    <div class="m-book-item__price"><span class="m-book-item__price-num">792</span> 円 (税込) 試し読み</div>
  </div>
</body></html>`;

// Vols 1 and 2 are the free 無料お試し版 (0 yen + 無料で読む), vol 3 costs 810, and
// the last row is the unnumbered edition (no volume in its title at all), which
// is the one an unnumbered, bonus-included edition has to be matched against by title.
const BW_SERIES = `<html><body>
  <div class="m-book-item">
    <a class="m-book-item__title" href="https://bookwalker.jp/def5a49973-58a0-44b0-a6ce-41abdc306335/" title="${SERIES} 1巻【無料お試し版】">${SERIES} 1巻【無料お試し版】</a>
    <div class="m-book-item__price"><span class="m-book-item__price-num">0</span> 円 (税込) 無料で読む</div>
  </div>
  <div class="m-book-item">
    <a class="m-book-item__title" href="https://bookwalker.jp/def14c212d-df22-4e6c-b300-e9bfe3de010e/" title="${SERIES} 2巻【無料お試し版】">${SERIES} 2巻【無料お試し版】</a>
    <div class="m-book-item__price"><span class="m-book-item__price-num">0</span> 円 (税込) 無料で読む</div>
  </div>
  <div class="m-book-item">
    <a class="m-book-item__title" href="https://bookwalker.jp/decf5c400b-42c7-4c7f-af26-7181721d9f5e/" title="${SERIES} 3巻">${SERIES} 3巻</a>
    <div class="m-book-item__price"><span class="m-book-item__price-num">810</span> 円 (税込) 試し読み</div>
  </div>
  <div class="m-book-item">
    <a class="m-book-item__title" href="https://bookwalker.jp/de9705d0bc-0e2a-4459-beb5-4e472c87683e/" title="${SERIES}【特典付】">${SERIES}【特典付】</a>
    <div class="m-book-item__price"><span class="m-book-item__price-num">500</span> 円 (税込) 試し読み</div>
  </div>
</body></html>`;

const CMOA_SEARCH = `<html><body>
  <a href="/title/100003/">【単話】サンプル単話作品</a>
</body></html>`;

// vol 1 is free until 9/27 but STILL shows 720pt/792円(税込); vol 2 is paid.
const CMOA_TITLE = `<html><body>
  <div class="title_vol_vox_vols_i clearfix">
    <div class="title_vol_btn_box_w">
      <a href="/reader/sample/?title_id=100004&amp;content_id=100001000040001" rel="nofollow" class="position_r">
        <div class="GA_free btn free"><span>無料で読む</span><span>9/27まで</span></div>
        <span class="mark">&yen;<span class="em">0</span></span>
      </a>
    </div>
    <div class="title_vol_text_box_w">
      <h3 class="title_details_title_name_h2"><a href="/title/100004/">${SKIP}（１）</a></h3>
      <div class="valueArea"><p class="price"><span class="point">720pt/792円(税込)</span></p></div>
    </div>
  </div>
  <div class="title_vol_vox_vols_i clearfix">
    <div class="title_vol_btn_box_w">
      <a href="/reader/sample/?title_id=100004&amp;content_id=100001000040003" rel="nofollow">
        <div class="title_vol_each_free_btn GA_free"></div>
      </a>
    </div>
    <div class="title_vol_text_box_w">
      <h3 class="title_details_title_name_h2"><a href="/title/100004/vol/3/">${SKIP}（3）</a></h3>
      <div class="valueArea"><p class="price"><span class="point">720pt/792円(税込)</span></p></div>
    </div>
  </div>
  <div class="title_vol_vox_vols_i clearfix">
    <div class="title_vol_btn_box_w">
      <a href="javascript:void(0)" class="cart_into_btn registBtn"><p class="title">会員登録して購入</p></a>
    </div>
    <div class="title_vol_text_box_w">
      <h3 class="title_details_title_name_h2"><a href="/title/100004/vol/2/">${SKIP}（２）</a></h3>
      <div class="valueArea"><p class="price"><span class="point">720pt/792円(税込)</span></p></div>
    </div>
  </div>
</body></html>`;

// The series card carries badges and review noise, so its anchor text is long;
// the spin-off card right after it is a bare title. Scoring the whole anchor
// makes the shorter spin-off look like the better match.
const EBJ_SEARCH = `<html><body>
  <a href="/books/999999/"><span class="badge-label">3冊無料</span> 関係ないタイトル 1</a>
  <a href="/books/716241/"><span class="badge-label">1冊無料</span> お得 <p class="title-content__title">${SERIES}</p> サンプル作者 2,477 漫画賞受賞 レビュー 1件 2件 3件</a>
  <a href="/books/888888/"><p class="title-content__title">${SERIES}愛</p></a>
</body></html>`;

// CMOA renders ten volumes per page and paginates the rest, so page one alone
// reports a 16-volume series as ten volumes with eight free. Page two carries
// the remaining six, which are not free.
const CMOA_SERIES_ROW = (vol, free, until) => `<div class="title_vol_vox_vols_i clearfix">
  <div class="title_vol_btn_box_w">
    <a href="/reader/sample/?title_id=100005&amp;content_id=1000010000500${vol}" rel="nofollow">
      <div class="${free ? 'GA_free btn free' : 'title_vol_each_free_btn GA_free'}">${free ? '<span>無料で読む</span><span>' + until + '</span>' : ''}</div>
    </a>
  </div>
  <div class="title_vol_text_box_w">
    <h3 class="title_details_title_name_h2"><a href="/title/100005/vol/${vol}/">${SERIES} ${vol}巻</a></h3>
    <div class="valueArea"><p class="price"><span class="point">564pt/620円(税込)</span></p></div>
  </div>
</div>`;
const CMOA_SERIES_P1 = `<html><body>` +
  [1, 2, 3, 4, 5, 6, 7, 8].map(v => CMOA_SERIES_ROW(v, true, '9/30まで')).join('') +
  [9, 10].map(v => CMOA_SERIES_ROW(v, false, '')).join('') +
  `<div class="pagination"><ul class="pages clearfix">
     <li class="selected"><span>1</span></li>
     <li><a href="/title/100005/?order=up&amp;page=2#buyarea"> 2 </a></li>
   </ul></div></body></html>`;
const CMOA_SERIES_P2 = `<html><body>` +
  [11, 12, 13, 14, 15, 16].map(v => CMOA_SERIES_ROW(v, false, '')).join('') +
  `</body></html>`;

// サンプル作品, the series from the live report: 27 volumes and NO free marker on
// any of them. The list still renders ten rows a page, so page one alone reports
// ten volumes and only following the pager reaches the real size. Page two states
// its amount on a bare .point with no .price wrapper, which is the shape the
// live page was described with; the parse must not depend on that wrapper.
const CMOA_AONO_ROW = (vol, pt, yen, bare) => `<div class="title_vol_vox_vols_i clearfix">
  <div class="title_vol_btn_box_w">
    <a href="/reader/sample/?title_id=100001&amp;content_id=1000022584${String(vol).padStart(3, '0')}" rel="nofollow">
      <div class="title_vol_each_free_btn GA_free"></div>
    </a>
  </div>
  <div class="title_vol_text_box_w">
    <h3 class="title_details_title_name_h2"><a href="/title/100001/vol/${vol}/">サンプル作品 ${vol}</a></h3>
    <div class="valueArea">${bare
      ? `<span class="point">${pt}pt/${yen}円(税込)</span>`
      : `<p class="price"><span class="point">${pt}pt/${yen}円(税込)</span></p>`}</div>
  </div>
</div>`;
const CMOA_AONO_P1 = `<html><body>` +
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => CMOA_AONO_ROW(v, 440, 484, false)).join('') +
  `<div class="pagination"><ul class="pages clearfix">
     <li class="selected"><span>1</span></li>
     <li><a href="/title/100001/?page=1&amp;order=up&amp;disp_mode=easy#buyarea"> 1 </a></li>
     <li><a href="/title/100001/?order=up&amp;page=2#buyarea"> 2 </a></li>
     <li><a href="/title/100001/?order=up&amp;page=3#buyarea"> 3 </a></li>
   </ul></div></body></html>`;
const CMOA_AONO_P2 = `<html><body>` +
  [11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map(v => CMOA_AONO_ROW(v, 480, 528, true)).join('') +
  `</body></html>`;
const CMOA_AONO_P3 = `<html><body>` +
  [21, 22, 23, 24, 25, 26, 27].map(v => CMOA_AONO_ROW(v, 520, 572, false)).join('') +
  `</body></html>`;
// The store's easy layout for the same series: the featured volume's amount is
// stated in the page's own .point block and none of the .title_vol_vox_vols_i
// rows the adapter reads are rendered. A price with no series size is the honest
// answer, so this page must not come back as an empty pill.
const CMOA_AONO_HERO = `<html><body>
  <div class="valueArea"><p class="price"><span class="point">440pt/484円(税込)</span></p></div>
</body></html>`;

// The same series in the store's easy layout, which the title page serves to a
// session that has it switched on. It renders 20 rows a page, states points
// rather than yen, and puts the 無料立読み button on every row; only the first
// nine carry the 今だけ無料で読める！ caption, so that caption is the free
// marker. Reading only the detailed rows is what left the pill empty on the
// live page the report came from.
const CMOA_AONO_EASY_ROW = (vol, free, pt) => `<li class="title_vol_easy_box_in_th">
  <div class="thum_box3_wra"><div class="thum_box3">
    <a href="/title/100002/vol/${vol}/" class="thum_img3_a"><img src="cover.jpg" alt="サンプル作品 ${vol}"></a>
  </div></div>
  <div class="easy_area_btn"><a href="/reader/sample/?title_id=100002&amp;content_id=10000100002${String(vol).padStart(3, '0')}" rel="nofollow"><img src="free2_btn_easy.png" alt="無料" class="buy_btn_img GA_free"></a></div>
  <div class="title_check_box"><h3><a href="/title/100002/vol/${vol}/">サンプル作品 ${vol}</a></h3></div>
  ${free ? '<div class="book_last_cam">今だけ無料で読める！</div>' : ''}
  <div class="book_cam_value">${pt}pt</div>
</li>`;
const CMOA_AONO_EASY_P1 = `<html><body><div class="title_vol_vox_vols_w volume_simple"><ul class="title_vol_easy_box clearfix">` +
  Array.from({ length: 20 }, (_, i) => CMOA_AONO_EASY_ROW(i + 1, i + 1 <= 9, 440)).join('') +
  `</ul></div><div class="pagination"><ul class="pages clearfix">
     <li class="selected"><span>1</span></li>
     <li><a href="/title/100002/?order=up&amp;page=2#buyarea"> 2 </a></li>
   </ul></div></body></html>`;
const CMOA_AONO_EASY_P2 = `<html><body><ul class="title_vol_easy_box clearfix">` +
  [21, 22, 23, 24, 25, 26, 27].map(v => CMOA_AONO_EASY_ROW(v, false, 520)).join('') +
  `</ul></body></html>`;

// ebookjapan prices exist only in the Nuxt payload, so the fixture is a real
// devalue flat array rather than readable markup - which is the whole point.
function devalueEncode(root) {
  const flat = [];
  const enc = (v) => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') { flat.push(v); return flat.length - 1; }
    if (Array.isArray(v)) { const i = flat.length; flat.push(null); flat[i] = v.map(enc); return i; }
    const i = flat.length; flat.push(null);
    const o = {};
    for (const k of Object.keys(v)) o[k] = enc(v[k]);
    flat[i] = o;
    return i;
  };
  enc(root);
  return JSON.stringify(flat);
}
// The real payload nests the store under `data` and leaves a null placeholder
// for the same key under `_errors`; a lookup that walks the payload can meet
// the placeholder first and come back empty-handed.
const ebjPage = (store) => `<!doctype html><html><head><script type="application/json">` +
  devalueEncode(['ShallowReactive', {
    data: { 'books-title_pc:test': store },
    state: {},
    _errors: { 'books-title_pc:test': null },
  }]) +
  `</script></head><body></body></html>`;
const EBJ_VOLS = [];
for (let v = 1; v <= 8; v++) {
  EBJ_VOLS.push({
    publicationCd: 'A00162470' + v,
    name: `${SERIES}\u3000${v}巻`,
    goods: { price: v <= 4 ? 620 : 660, isFree: false, isBrowserSpecialFree: false, saleEndDatetime: null },
  });
}
// The title page names one publication only; the volume page carries the run.
const EBJ_TITLE_STORE = { titleInfo: { titleId: '716241' }, firstPublication: { publicationCd: 'A001624701' } };
// Volume 1 is also on a limited-time free campaign. That offer lives in its own
// list, so a reader that only looks at `purchasablePublications` sees the paid
// offer for the same volume and reports it as costing money.
const EBJ_VOL1_FREE = {
  publicationCd: 'A001624701',
  name: `${SERIES}\u30001巻`,
  goods: { price: 0, isFree: true, isBrowserSpecialFree: true, saleEndDatetime: '2026/10/01 23:59' },
};
// The volume page has no `titleInfo` at all, exactly like the live one.
const EBJ_VOLUME_STORE = {
  publication: EBJ_VOLS[2],
  purchasablePublications: EBJ_VOLS,
  sameTitlePublications: [EBJ_VOL1_FREE].concat(EBJ_VOLS.slice(1)),
  freePublications: [EBJ_VOL1_FREE],
};

// Amazon states the charge in yen on the card, but a Kindle Unlimited title
// shows a zero there instead, so vol 3's charge only exists on its own page.
const AMZ_PRICE = (kind, yen) => {
  if (kind === 'charge') return '<div><span class="a-size-base a-color-secondary">JPY ' + yen + 'が請求されます</span></div>';
  // A Kindle Unlimited card leads with the KU zero. In the Japanese locale that
  // zero is "￥0", which must not be mistaken for the book's price; the real
  // price rides along second.
  if (kind === 'ku-jp') return '<span class="a-price"><span class="a-offscreen">￥0</span></span>' +
    '<span>Kindle Unlimited会員は無料</span><span>または <span class="a-color-price">￥' + yen + ' (62pt)</span>で購入</span>';
  return '<span class="a-price"><span class="a-offscreen">EUR 0.00</span></span><span>Kindle Unlimited会員は無料</span>';
};
const AMZ_OFFER = (asin, vol, kind, yen) => `<div data-asin="${asin}" data-index="${vol}" data-component-type="s-search-result" class="s-result-item s-asin">
  <h2><a class="a-link-normal" href="/slug/dp/${asin}/ref=sr_1_${vol}"><span>${SERIES} ${vol} (花とゆめコミックススペシャル)</span></a></h2>
  <div class="a-row">全16巻中第${vol}巻: ${SERIES} | 斉木久美子</div>
  ${AMZ_PRICE(kind, yen)}
</div>`;
// A spin-off ("...愛") is a four-volume series that shares the title prefix, so
// it matches the same volume number and, without the series marker, hands its
// own price to a volume of the main run.
const AMZ_SPINOFF = `<div data-asin="B000000099" data-index="9" data-component-type="s-search-result" class="s-result-item s-asin">
  <h2><a class="a-link-normal" href="/slug/dp/B000000099/ref=sr_1_9"><span>${SERIES}愛 2 (スピンオフコミックススペシャル)</span></a></h2>
  <div class="a-row">全4巻中第2巻: ${SERIES}愛 | 別の人</div>
  <div><span class="a-size-base a-color-secondary">JPY 500が請求されます</span></div>
</div>`;
const AMZ_SEARCH = `<html><body>
  ${AMZ_OFFER('B000000002', 2, 'ku-jp', 620)}
  ${AMZ_OFFER('B000000003', 3, 'ku-eu', 0)}
  ${AMZ_OFFER('B000000004', 4, 'charge', 620)}
  ${AMZ_SPINOFF}
</body></html>`;
const AMZ_VOL3 = `<html><body>
  <span id="productTitle">${SERIES} 3 (花とゆめコミックススペシャル)</span>
  <div>全16巻中第3巻</div>
  <div><span>ご請求額:JPY 620</span></div>
  <div><span>Kindle Unlimited会員は無料</span></div>
</body></html>`;

// k-manga states every amount in points, never yen, and a free volume keeps its
// regular point price on the row: vol 1 costs 700pt and is still readable free
// through its 無料で読む button, so free has to come from the button and never
// from the amount. The list shows ten rows a page and paginates the rest, so
// page one alone reports a 12-volume series as ten volumes with one free one.
const KM_SEARCH = `<html><body>
  <ul class="book-list book-list__one-column">
    <li class="book-list--target"><a class="book-list--item" href="/title/100006/pv">
      <img src="https://cf.image-cdn.k-manga.jp/cover_200/19/100006/b100006_1_200.jpg" class="book-list--img" alt="${SERIES}">
      <h2 class="book-list--title">${SERIES}</h2>
      <div class="book-list--repo-num"><span class="icon-text">巻</span>718pt</div>
      <div class="btn-mini btn--grade">無料で試し読み</div>
    </a></li>
  </ul>
</body></html>`;
const KM_ROW = (vol, price, free, until) => `<li class="book-chapter--target book-chapter--target__cover book-chapter--target__cover-pv">
  <div class="book-chapter--num">${vol}巻</div>
  <div class="book-chapter--item" chapter-exid="${vol}">
    <div class="book-chapter--item-inner">
      <div class="book-chapter--description">
        <h3 class="book-chapter--title"><a href="https://comic.k-manga.jp/title/100006/vol/${vol}">${SERIES} ${vol}巻</a></h3>
        <div class="book-chapter--page-price"><span class="book-chapter--page">200ページ | </span><span class="book-chapter--pt">${price}pt</span></div>
      </div>
      <div class="f14 pc-detail-btn-group">
        <div class="book-chapter--bottom">${free ? '<span class="f-bold">' + until + '</span>まで<span class="book-chapter--pt">1冊無料</span>' : ''}</div>
        ${free
            ? `<a class="btn book-chapter--btn__jikuri x-invoke-viewer--btn__selector gaevent-detail-chapter-read-jikkuri" data-chapter-exid="${vol}" data-chapter-readType="1" rel="nofollow">無料で読む</a>`
            : `<a class="btn book-chapter--btn__sample x-invoke-viewer--btn__selector gaevent-detail-chapter-read-sample" data-chapter-exid="${vol}" data-chapter-readType="0" rel="nofollow">試し読み</a>`}
        <a class="btn book-chapter--btn__buy x-book-chapter--btn__buy float-r" href="/login/" rel="nofollow">購入する</a>
      </div>
    </div>
  </div>
</li>`;
const KM_TITLE_P1 = `<html><body>` +
  [2, 3, 4, 5, 6, 7, 8, 9, 10].map(v => KM_ROW(v, v === 3 ? 718 : 700, false, '')).join('') +
  KM_ROW(1, 700, true, '10/22 23:59') +
  `<div class="paging paging__title">
    <span class="paging--item active"><a href="https://comic.k-manga.jp/title/100006/pv#title-chapter-list">1</a></span>
    <span class="paging--item"><a href="https://comic.k-manga.jp/title/100006/pv/2#title-chapter-list">2</a></span>
  </div></body></html>`;
const KM_TITLE_P2 = `<html><body>` +
  KM_ROW(11, 700, true, '10/29 23:59') +
  KM_ROW(12, 700, false, '') +
  `</body></html>`;

// DMMブックス is server-rendered: the search page carries one card for the
// series, and the product page embeds its volume list in the React flight
// payload. The flight state is a sequence of JSON string literals pushed by
// self.__next_f; the fixture splits the JSON mid-object on purpose, because the
// store's own pages split it wherever the stream happens to break.
function dmmFlight(payload) {
  const text = '3a:' + JSON.stringify(payload);
  const half = Math.floor(text.length / 2);
  return `<script>self.__next_f.push([1,${JSON.stringify(text.slice(0, half))}])</script>` +
    `<script>self.__next_f.push([1,${JSON.stringify(text.slice(half))}])</script>`;
}
const DMM_SEARCH = `<html><body>
  <ul class="m-boxSearchBookProduct">
    <li class="m-boxSearchBookProduct__item" data-product-id="b9000000001" data-content-id="b9000000001" data-price="660">
      <div class="m-boxSearchListTmb">
        <a href="https://book.dmm.com/product/900001/b9000000001/" class="fn-addI3Parameters">
          <div class="m-boxSearchListTmbImg"><div class="m-boxSearchListTmbImg__box"><div class="m-boxSearchListTmbImg__box__img"><div class="m-bookImage"><img class="m-bookImage__img" src="cover.webp" alt="${SERIES}"></div></div></div></div>
          <span class="m-boxSearchListTmb__ttl">${SERIES}</span>
        </a>
      </div>
    </li>
  </ul>
</body></html>`;
function dmmVolume(vol, price, free, end) {
  return {
    contentId: 'b9000000' + String(vol).padStart(3, '0'),
    title: SERIES + ' ' + vol + '巻',
    volumeNumber: vol,
    freeStreamingUrl: free
      ? ['https://book.dmm.com/product/900001/b9000000' + String(vol).padStart(3, '0') + '/free_streaming/?cid=X&lin=0']
      : '$undefined',
    tachiyomiUrl: 'https://book.dmm.com/product/900001/b9000000' + String(vol).padStart(3, '0') + '/tachiyomi/?cid=X&lin=1',
    sell: { productId: 'b9000000' + String(vol).padStart(3, '0'), fixedPrice: price, campaignPrice: '$undefined' },
    // DMM states the campaign end as an ISO timestamp in JST.
    limitedFree: { end: free ? end : '' },
    productUrl: '/product/900001/b9000000' + String(vol).padStart(3, '0') + '/',
  };
}
const DMM_PRODUCT = `<html><body><div id="root"></div>` + dmmFlight({
  state: {
    volumeBooks: [
      dmmVolume(1, 660, true, '2026-10-22T23:59:59+09:00'),
      dmmVolume(2, 660, true, '2026-10-22T23:59:59+09:00'),
      dmmVolume(3, 810, false, ''),
    ],
    pager: { page: 1, perPage: 10, totalCount: 12 },
    totalFreeCount: 2,
  },
}) + `</body></html>`;
// The BFF endpoint the product page itself calls for the volumes it does not
// embed. Its rows are snake_case, and its price fields are the same values.
const DMM_BFF = JSON.stringify({
  volume_books: Array.from({ length: 12 }, (_, i) => ({
    content_id: 'b9000000' + String(i + 1).padStart(3, '0'),
    title: SERIES + ' ' + (i + 1) + '巻',
    volume_number: i + 1,
    free_streaming_url: i < 2 ? ['https://book.dmm.com/x'] : null,
    tachiyomi_url: 'https://book.dmm.com/product/900001/x/tachiyomi/?cid=X',
    sell: { fixed_price: i === 2 ? 810 : 660, campaign_price: null },
    limited_free: { end: i < 2 ? '2026-10-22T23:59:59+09:00' : '' },
  })),
  pager: { page: 1, per_page: 100, total_count: 12 },
  total_free_count: 2,
});

// host -> { path prefix -> html }
const PAGES = {
  'bookwalker.jp': { '/search/': BW_SEARCH, '/series/900002/list/': BW_SERIES, '/series/999001/list/': BW_DIGITS_SERIES },
  'www.cmoa.jp': {
    '/search/result/': CMOA_SEARCH, '/title/100004/': CMOA_TITLE,
    '/title/100005/?order=up&page=2': CMOA_SERIES_P2, '/title/100005/': CMOA_SERIES_P1,
    '/title/100001/?order=up&page=3': CMOA_AONO_P3, '/title/100001/?order=up&page=2': CMOA_AONO_P2,
    '/title/100001/': CMOA_AONO_P1, '/title/100008/': CMOA_AONO_HERO,
    '/title/100002/?order=up&page=2': CMOA_AONO_EASY_P2, '/title/100002/': CMOA_AONO_EASY_P1,
  },
  'ebookjapan.yahoo.co.jp': {
    '/search/': EBJ_SEARCH,
    '/books/716241/A001624701/': ebjPage(EBJ_VOLUME_STORE),
    '/books/716241/': ebjPage(EBJ_TITLE_STORE),
  },
  'www.amazon.co.jp': { '/dp/B000000003/': AMZ_VOL3, '/s': AMZ_SEARCH },
  'comic.k-manga.jp': {
    '/search/word/': KM_SEARCH,
    '/title/100006/pv/2': KM_TITLE_P2, '/title/100006/pv': KM_TITLE_P1,
  },
  'book.dmm.com': {
    // The SERIES queries are the only ones this stub says DMM carries, so every
    // other scenario keeps its pre-DMM pill set and the "no pill" case still
    // proves a miss.
    ['/search/?searchstr=' + encodeURIComponent(SERIES)]: DMM_SEARCH,
    '/product/900001/b9000000001/': DMM_PRODUCT,
    '/ajax/bff/contents_book/': DMM_BFF,
  },
};

const tls = { key: fs.readFileSync(path.join(__dirname, 'tls/key.pem')), cert: fs.readFileSync(path.join(__dirname, 'tls/cert.pem')) };

// The late-title scenario models the BookWalker viewer, whose document.title
// arrives after the first pass. CMOA's adapter never falls back to
// document.title (cmoa/02-run.js getBook() returns null without its own state)
// and latches its viewer title once, so the scenario is meaningless for a build
// with no BookWalker adapter.
const HAS_BW_ADAPTER = loadUserscript().includes('installNetworkCapture');

// The cross-store card ships in the combined build only, so a single-store
// artifact has nothing here to test.
const HAS_AVAILABILITY = loadUserscript().includes('AVAILABILITY_STORES');

// The page itself is served locally. Store URLs carry no port, so they are
// served through a GM_xmlhttpRequest stub - also the transport the script
// prefers in production, and it needs no CORS.
const srv = https.createServer(tls, (req, res) => {
  const url = new URL(req.url, 'https://x');
  const title = url.searchParams.get('t') || '';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>' + title.replace(/[<>&]/g, '') + '</title><body></body>');
});

const results = [];
const check = (n, pass, d) => { results.push({ n, pass, d }); console.log((pass ? 'PASS  ' : 'FAIL  ') + n + '  — ' + d); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!HAS_AVAILABILITY) {
    console.log('SKIP  test_availability.js \u2014 this artifact does not carry the cross-store card (combined build only)');
    console.log('\nALL 0 CHECKS PASSED');
    process.exit(0);
  }
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--ignore-certificate-errors',
      '--host-resolver-rules=MAP viewer.bookwalker.jp 127.0.0.1, MAP * 127.0.0.1'],
  });

  async function installGmStub(page) {
    // Record every URL the script asks for, so "no match" can be told apart
    // from "the fetch never happened".
    await page.evaluateOnNewDocument((pages) => {
      window.__bwddTestHits = [];
      // The card is painted as each shop answers, so a placeholder can exist only
      // for a moment. Watch the DOM from the start and remember the largest
      // placeholder set and whose names were in it.
      window.__bwddSkeleton = { seen: 0, names: [] };
      try {
        new MutationObserver(() => {
          const pend = document.querySelectorAll('.bwdd-store-pending');
          if (!pend.length) return;
          window.__bwddSkeleton.seen = Math.max(window.__bwddSkeleton.seen, pend.length);
          for (const p of pend) {
            const nm = p.querySelector('.bwdd-store-name');
            const t = nm ? nm.textContent : '';
            if (t && window.__bwddSkeleton.names.indexOf(t) === -1) window.__bwddSkeleton.names.push(t);
          }
        }).observe(document, { childList: true, subtree: true });
      } catch (e) {}
      window.GM_xmlhttpRequest = (opts) => {
        const url = String(opts && opts.url || '');
        let host = '', p = '', search = '';
        try { const u = new URL(url); host = u.hostname; p = u.pathname; search = u.search || ''; } catch (e) {}
        window.__bwddTestHits.push(url);
        const routes = pages[host] || {};
        const full = p + search;
        // Longest match wins, and a key carrying a query is only usable against
        // the full path+query, so a paginated page and page one stay distinct.
        const key = Object.keys(routes)
          .filter(k => (k.indexOf('?') === -1 ? p.startsWith(k) : full.startsWith(k)))
          .sort((x, y) => y.length - x.length)[0];
        setTimeout(() => {
          if (key) { try { opts.onload({ status: 200, responseText: routes[key], responseHeaders: '' }); } catch (e) {} }
          else { try { opts.onerror({ error: 'stub: no route for ' + host + p }); } catch (e) {} }
        }, 0);
      };
    }, PAGES);
  }

  async function openPage(query) {
    const page = await browser.newPage();
    await installGmStub(page);
    await page.goto('https://viewer.bookwalker.jp:' + port + '/?bwddDebug=1&' + query, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: loadUserscript() });
    return page;
  }

  const readPills = (page) => page.evaluate(() => [...document.querySelectorAll('.bwdd-store-link')].map(a => {
    const r = a.getBoundingClientRect();
    const name = a.querySelector('.bwdd-store-name');
    return {
      href: a.href, text: a.textContent, found: a.classList.contains('is-found'),
      free: a.classList.contains('is-free'), ku: a.classList.contains('is-ku'), tip: a.title,
      top: Math.round(r.top), left: Math.round(r.left), span: a.style.gridColumn,
      nameFits: name ? name.scrollWidth <= name.clientWidth + 1 : true,
    };
  }));

  // The card is painted as each shop answers, so "the card exists" is no longer
  // a completion signal. Wait for every answer to have landed (the debug marker
  // the module sets on the cards container), with the query count as a fallback,
  // then give the final render a moment.
  async function settle(page) {
    try {
      await page.waitForFunction(() => {
        if (document.querySelector('.bwdd-cards[data-stores-done="1"]')) return true;
        const h = window.__bwddTestHits || [];
        return h.filter(u => /bookwalker\.jp|cmoa\.jp|ebookjapan\.yahoo|amazon\.co\.jp|k-manga\.jp|book\.dmm\.com/.test(u)).length >= 6 &&
          !document.querySelector('.bwdd-store-pending');
      }, { timeout: 15000 });
    } catch (e) {}
    await sleep(800);
  }

  async function scenario(query) {
    const page = await openPage(query);
    await settle(page);
    const pills = await readPills(page);
    const hits = await page.evaluate(() => window.__bwddTestHits || []);
    const hasCard = await page.evaluate(() => !!document.querySelector('.bwdd-card[data-card="stores"]'));
    const skeleton = await page.evaluate(() => window.__bwddSkeleton || { seen: 0, names: [] });
    const pendingLeft = await page.evaluate(() => document.querySelectorAll('.bwdd-store-pending').length);
    const rowClass = await page.evaluate(() => {
      const r = document.querySelector('.bwdd-store-row');
      return r ? r.className : '';
    });
    await page.close();
    return { pills, hits, hasCard, skeleton, pendingLeft, rowClass };
  }

  const pick = (pills, label) => pills.find(p => p.text.includes(label));
  const url = q => 't=' + encodeURIComponent(q);
  const shown = pills => pills.map(p => p.text.replace(/^./, '')).join(' | ');

  const a = await scenario(url(SERIES + ' 3巻'));
  const bw = pick(a.pills, 'BookWalker'), cm = pick(a.pills, 'CMOA');
  const eb = pick(a.pills, 'ebookjapan'), am = pick(a.pills, 'Kindle'), km = pick(a.pills, 'k-manga');
  const dm = pick(a.pills, 'DMM');
  check('only shops that carry it get a pill', a.pills.length === 5, `pills=${a.pills.length}: ${shown(a.pills)}`);
  check('a missing shop leaves no empty frame behind', !cm, cm ? cm.text : 'no CMOA pill');
  check('CMOA: the search parameter the shop actually filters on is used',
    a.hits.some(u => u.includes('cmoa.jp/search/result/?header_word=')), a.hits.filter(u => u.includes('cmoa.jp/search')).join(' '));
  check('every store was really queried (no match cannot mean no fetch)',
    a.hits.some(u => u.includes('bookwalker.jp/search')) && a.hits.some(u => u.includes('cmoa.jp/search')) &&
    a.hits.some(u => u.includes('ebookjapan.yahoo.co.jp/search')) && a.hits.some(u => u.includes('www.amazon.co.jp/s?k=')) &&
    a.hits.some(u => u.includes('comic.k-manga.jp/search/word/')) &&
    a.hits.some(u => u.includes('book.dmm.com/search/?searchstr=')),
    a.hits.map(u => { try { return new URL(u).hostname; } catch (e) { return '?'; } }).join(' '));
  check('BookWalker: series page wins over the single-volume decoy and the magazine',
    !!bw && bw.href === 'https://bookwalker.jp/series/900002/list/', bw ? bw.href : 'none');
  check('BookWalker: shows this volume\'s price and the series free count',
    !!bw && /¥810/.test(bw.text) && /2\/3 free/.test(bw.text), bw ? bw.text : 'none');
  check('BookWalker: the series page was fetched to read the rows',
    a.hits.some(u => u.includes('/series/900002/list/')), a.hits.length + ' requests');
  check('BookWalker: a paid volume states its price instead of claiming "free"',
    !!bw && /¥810/.test(bw.text) && /this volume is ¥810/.test(bw.tip), bw ? bw.tip : 'none');
  check('ebookjapan: the series card wins over a shorter spin-off card',
    !!eb && eb.href === 'https://ebookjapan.yahoo.co.jp/books/716241/', eb ? eb.href : 'none');
  check('ebookjapan: reads its OWN card badge, not a bigger one from another card',
    !!eb && /1\/8 free/.test(eb.text) && !/3\//.test(eb.text), eb ? eb.text : 'none');
  check('ebookjapan: this volume\'s price is read from the Nuxt payload',
    !!eb && /¥620/.test(eb.text), eb ? eb.text : 'none');
  check('ebookjapan: the title page is opened for the list that carries the whole run',
    a.hits.some(u => u === 'https://ebookjapan.yahoo.co.jp/books/716241/A001624701/'),
    a.hits.filter(u => u.includes('ebookjapan')).join(' | ') || 'no ebookjapan requests');
  check('Amazon: the charge the card hides behind Kindle Unlimited comes from the volume page',
    !!am && /KU · ¥620/.test(am.text) && am.href === 'https://www.amazon.co.jp/dp/B000000003/',
    am ? am.text + ' -> ' + am.href : 'none');
  check('Amazon: the subscription and the purchase price are named separately',
    !!am && /¥620/.test(am.text) && /KU/.test(am.text) && /included with Kindle Unlimited/.test(am.tip),
    am ? am.tip : 'none');
  check('Amazon: the volume is matched by its own number, not the first result',
    a.hits.some(u => u === 'https://www.amazon.co.jp/dp/B000000003/'), a.hits.filter(u => u.includes('amazon.co.jp/dp')).join(' '));
  check('k-manga: the search is a GET on the path the site POSTs to',
    a.hits.some(u => u.includes('comic.k-manga.jp/search/word/')),
    a.hits.filter(u => u.includes('k-manga.jp')).join(' '));
  check('k-manga: links to the series page the search matched',
    !!km && km.href === 'https://comic.k-manga.jp/title/100006/pv', km ? km.href : 'none');
  check('k-manga: a point price is stated in points, never rendered as yen',
    !!km && /718pt/.test(km.text) && !/¥/.test(km.text) && /this volume is 718pt/.test(km.tip), km ? km.text + ' | ' + km.tip : 'none');
  check('k-manga: the pager\'s second page is followed for the free count',
    !!km && /2\/12 free/.test(km.text) && a.hits.some(u => u === 'https://comic.k-manga.jp/title/100006/pv/2'),
    km ? km.text : 'none');
  check('k-manga: the whole run is counted, not the ten rows of page one',
    !!km && /2 of 12 volumes can be read free/.test(km.tip), km ? km.tip : 'none');
  check('DMMブックス: the search is the store\'s own server-rendered GET',
    a.hits.some(u => u.includes('book.dmm.com/search/?searchstr=')),
    a.hits.filter(u => u.includes('dmm.com')).join(' '));
  check('DMMブックス: links to the series product page the search matched',
    !!dm && dm.href === 'https://book.dmm.com/product/900001/b9000000001/', dm ? dm.href : 'none');
  check('DMMブックス: this volume\'s price comes from the product page payload',
    !!dm && /¥810/.test(dm.text) && /this volume is ¥810/.test(dm.tip), dm ? dm.text + ' | ' + dm.tip : 'none');
  check('DMMブックス: the product page itself is fetched for the volume rows',
    a.hits.some(u => u === 'https://book.dmm.com/product/900001/b9000000001/'), a.hits.length + ' requests');
  check('DMMブックス: the BFF volume list fills the run the product page does not embed',
    !!dm && /2\/12 free/.test(dm.text) && a.hits.some(u => u.includes('book.dmm.com/ajax/bff/contents_book/')),
    dm ? dm.text : 'none');
  check('DMMブックス: the whole run is counted, not the three embedded volumes',
    !!dm && /2 of 12 volumes can be read free/.test(dm.tip), dm ? dm.tip : 'none');
  check('DMMブックス: a 試し読み-only volume still shows its own price',
    !!dm && /¥810/.test(dm.text) && dm.free, dm ? dm.text + ' free=' + dm.free : 'none');
  const eb1 = pick(a.pills, 'ebookjapan');
  check('ebookjapan: the paid offer does not hide the free campaign for the same volume',
    !!eb1 && eb1.free && /1\/8 free/.test(eb1.text), eb1 ? eb1.text : 'none');
  check('ebookjapan: the counted ratio is stated in full, not just the badge',
    !!eb1 && /1 of 8 volumes can be read free/.test(eb1.tip), eb1 ? eb1.tip : 'none');
  check('Amazon: no free-volume ratio is claimed from a search result set',
    !!am && !/vols free/.test(am.text), am ? am.text : 'none');
  check('every pill with a free offer is lit the same way, ebookjapan included',
    !!eb && eb.free && !!bw && bw.free, 'ebj=' + (eb ? eb.free : '?') + ' bw=' + (bw ? bw.free : '?'));

  const b = await scenario(url(SERIES + ' 1巻'));
  const bw1 = pick(b.pills, 'BookWalker');
  check('BookWalker: a free volume still reports the series free count',
    !!bw1 && /free · 2\/3 free/.test(bw1.text), bw1 ? bw1.text : 'none');
  check('BookWalker: a free volume is flagged for styling',
    !!bw1 && bw1.free, bw1 ? String(bw1.free) : 'none');
  check('BookWalker: free state is not also reported as a price',
    !!bw1 && !/¥/.test(bw1.text), bw1 ? bw1.text : 'none');
  check('BookWalker: the tooltip spells out the ratio for the series',
    !!bw1 && /2 of 3 volumes can be read free/.test(bw1.tip), bw1 ? bw1.tip : 'none');
  const km1 = pick(b.pills, 'k-manga');
  check('k-manga: a free volume keeps its point price on the row, so the button decides',
    !!km1 && km1.free && /free/.test(km1.text) && !/pt/.test(km1.text) && !/¥/.test(km1.text),
    km1 ? km1.text : 'none');
  check('k-manga: the free reading\'s expiry is surfaced in the tooltip',
    !!km1 && /10\/22 23:59/.test(km1.tip), km1 ? km1.tip : 'none');
  const dm1 = pick(b.pills, 'DMM');
  check('DMMブックス: a free volume is read from its free_streaming_url, not its price',
    !!dm1 && dm1.free && /free · 2\/12 free/.test(dm1.text) && !/¥/.test(dm1.text), dm1 ? dm1.text : 'none');
  check('DMMブックス: the limited-free end is surfaced in the tooltip',
    !!dm1 && /10\/22 23:59/.test(dm1.tip), dm1 ? dm1.tip : 'none');
  check('DMMブックス: the whole run is counted for a free volume too',
    !!dm1 && /2 of 12 volumes can be read free/.test(dm1.tip), dm1 ? dm1.tip : 'none');

  const c = await scenario(url(SKIP + ' 2巻') + '&rurl=' + encodeURIComponent('https://www.cmoa.jp/title/100004/'));
  const cm2 = pick(c.pills, 'CMOA');
  check('CMOA: exact rurl link is used', !!cm2 && cm2.href === 'https://www.cmoa.jp/title/100004/', cm2 ? cm2.href : 'none');
  check('CMOA: paid volume shows its price and the series free count',
    !!cm2 && /¥792/.test(cm2.text) && /1\/3 free/.test(cm2.text), cm2 ? cm2.text : 'none');
  check('CMOA: the empty GA_free placeholder does not count a volume as free',
    !!cm2 && /1\/3 free/.test(cm2.text), cm2 ? cm2.text : 'none');
  check('CMOA: the title page was fetched for the rows',
    c.hits.some(u => u === 'https://www.cmoa.jp/title/100004/'), c.hits.length + ' requests');

  const d = await scenario(url(SKIP + ' 1巻') + '&rurl=' + encodeURIComponent('https://www.cmoa.jp/title/100004/'));
  const cm3 = pick(d.pills, 'CMOA');
  check('CMOA: free is read from 無料で読む, not from the row price',
    !!cm3 && cm3.free && /free/.test(cm3.text) && !/¥/.test(cm3.text), cm3 ? cm3.text : 'none');
  check('CMOA: the free reading\'s expiry is surfaced in the tooltip',
    !!cm3 && /9\/27/.test(cm3.tip), cm3 ? cm3.tip : 'none');
  check('a free volume still states the series free count beside it',
    !!cm3 && /free · 1\/3 free/.test(cm3.text), cm3 ? cm3.text : 'none');

  const ku = await scenario(url(SERIES + ' 2巻'));
  const amKu = pick(ku.pills, 'Kindle');
  check('Amazon: a Kindle Unlimited "￥0" is not read as the book being free',
    !!amKu && /KU · ¥620/.test(amKu.text) && !/free/.test(amKu.text), amKu ? amKu.text : 'none');
  check('Amazon: and the card states the price, so no extra page is needed',
    !ku.hits.some(u => u.includes('/dp/B000000002/')), ku.hits.filter(u => u.includes('amazon.co.jp/dp')).join(' '));
  check('Amazon: a spin-off series does not supply this volume\'s price',
    !!amKu && /¥620/.test(amKu.text) && !/500/.test(amKu.text), amKu ? amKu.text : 'none');
  check('Amazon: the series size is stated, and the KU count only as far as it is known',
    !!amKu && /16 vols/.test(amKu.text) &&
    /the series has 16 volumes, and 2 of the 3 listed are on Kindle Unlimited/.test(amKu.tip),
    amKu ? amKu.text + ' | ' + amKu.tip : 'none');
  check('Amazon: a KU offer is not styled as a free volume',
    !!amKu && amKu.ku && !amKu.free, amKu ? 'ku=' + amKu.ku + ' free=' + amKu.free : 'none');

  const plain = await scenario(url(SERIES + ' 4巻'));
  const amPlain = pick(plain.pills, 'Kindle');
  check('Amazon: a book outside Kindle Unlimited shows its price and no KU token',
    !!amPlain && /^A?Kindle¥620 · 16 vols$/.test(amPlain.text), amPlain ? amPlain.text : 'none');
  check('Amazon: and states the size of the run, not only when it is on Kindle Unlimited',
    !!amPlain && /the series has 16 volumes/.test(amPlain.tip), amPlain ? amPlain.tip : 'none');

  // ---- 4b. CMOA paginates its list: the series is 16 volumes and eight of
  //          them are free, but page one alone shows ten rows and eight free,
  //          so the series size is only right once page two is followed ------
  const pg = await scenario(url(SERIES + ' 3巻') + '&rurl=' + encodeURIComponent('https://www.cmoa.jp/title/100005/'));
  const cmPg = pick(pg.pills, 'CMOA');
  check('CMOA: the pager\'s page two is followed',
    pg.hits.some(u => u.includes('/title/100005/?order=up&page=2')), pg.hits.filter(u => u.includes('100005')).join(' '));
  check('CMOA: the series size is the whole run, not the ten rows of page one',
    !!cmPg && /8\/16 free/.test(cmPg.text), cmPg ? cmPg.text : 'none');
  check('CMOA: the tooltip states the ratio against the real series size',
    !!cmPg && /8 of 16 volumes can be read free/.test(cmPg.tip), cmPg ? cmPg.tip : 'none');

  // ---- 4b2. サンプル作品 from the live report: 27 volumes, no free marker, and a
  //           pager. A page with no free markers must still state a price, and
  //           the count must be all 27 volumes rather than page one's ten -----
  const aono = await scenario(url('サンプル作品 1巻') + '&rurl=' + encodeURIComponent('https://www.cmoa.jp/title/100001/'));
  const cmAono = pick(aono.pills, 'CMOA');
  check('CMOA: a page with no free marker still states a price',
    !!cmAono && /¥484/.test(cmAono.text) && !/free/.test(cmAono.text), cmAono ? cmAono.text : 'none');
  check('CMOA: 27 volumes are counted across all three paginated pages',
    !!cmAono && /¥484 · 27 vols/.test(cmAono.text), cmAono ? cmAono.text : 'none');
  check('CMOA: page one of サンプル作品 is not mistaken for the whole run',
    aono.hits.some(u => u.includes('/title/100001/?order=up&page=2')) &&
    aono.hits.some(u => u.includes('/title/100001/?order=up&page=3')),
    aono.hits.filter(u => u.includes('100001')).join(' '));

  // A paid volume whose row states its amount on a bare .point, with no .price
  // wrapper, is still priced: the wrapper is not what carries the amount.
  const aonoPaid = await scenario(url('サンプル作品 11巻') + '&rurl=' + encodeURIComponent('https://www.cmoa.jp/title/100001/'));
  const cmAonoPaid = pick(aonoPaid.pills, 'CMOA');
  check('CMOA: the amount is read even when it sits outside a .price wrapper',
    !!cmAonoPaid && /¥528/.test(cmAonoPaid.text), cmAonoPaid ? cmAonoPaid.text : 'none');

  // The live rurl can name the volume page the reader was opened from. The whole
  // run and its pager live on the series page, so that is what gets read and
  // linked; reading the volume page alone gave one page and skipped the pager.
  const aonoVol = await scenario(url('サンプル作品 1巻') + '&rurl=' + encodeURIComponent('https://www.cmoa.jp/title/100001/vol/1/'));
  const cmAonoVol = pick(aonoVol.pills, 'CMOA');
  check('CMOA: an rurl naming a volume page reads the series page',
    !!cmAonoVol && cmAonoVol.href === 'https://www.cmoa.jp/title/100001/', cmAonoVol ? cmAonoVol.href : 'none');
  check('CMOA: and the pager is still followed, so the count is the whole run',
    !!cmAonoVol && /27 vols/.test(cmAonoVol.text), cmAonoVol ? cmAonoVol.text : 'none');

  // The easy layout renders no .title_vol_vox_vols_i rows but does state the
  // featured volume's amount: a price beats an empty pill.
  const aonoHero = await scenario(url('サンプル作品 1巻') + '&rurl=' + encodeURIComponent('https://www.cmoa.jp/title/100008/'));
  const cmAonoHero = pick(aonoHero.pills, 'CMOA');
  check('CMOA: a page whose volume list did not render still states its price',
    !!cmAonoHero && /¥484/.test(cmAonoHero.text), cmAonoHero ? cmAonoHero.text : 'none');
  check('CMOA: and that price is not dressed up as a series size',
    !!cmAonoHero && !/vols/.test(cmAonoHero.text), cmAonoHero ? cmAonoHero.text : 'none');

  // ---- 4b3. the same URL in the store's easy layout: 20 rows a page, points
  //           rather than yen, and the 無料立読み button on every row. Only the
  //           first nine rows say 今だけ無料で読める！, so that caption is the
  //           free marker and the button is not.
  const easy = await scenario(url('サンプル作品 1巻') + '&rurl=' + encodeURIComponent('https://www.cmoa.jp/title/100002/'));
  const cmEasy = pick(easy.pills, 'CMOA');
  check('CMOA: the easy layout\'s free caption is read as the free state',
    !!cmEasy && /free · 9\/27 free/.test(cmEasy.text), cmEasy ? cmEasy.text : 'none');
  check('CMOA: the 無料立読み button every easy row carries is not counted as free',
    !!cmEasy && !/20\/27 free/.test(cmEasy.text), cmEasy ? cmEasy.text : 'none');
  check('CMOA: the easy layout paginates 20 rows a page and page two is followed',
    easy.hits.some(u => u.includes('/title/100002/?order=up&page=2')), easy.hits.filter(u => u.includes('100002')).join(' '));
  const easyPaid = await scenario(url('サンプル作品 11巻') + '&rurl=' + encodeURIComponent('https://www.cmoa.jp/title/100002/'));
  const cmEasyPaid = pick(easyPaid.pills, 'CMOA');
  check('CMOA: an easy-layout amount is stated in points, never as yen',
    !!cmEasyPaid && /440pt/.test(cmEasyPaid.text) && !/¥/.test(cmEasyPaid.text), cmEasyPaid ? cmEasyPaid.text : 'none');

  // ---- 4d. the grid must still fit what it shows: the two-column layout is
  //          only compact if neither the name nor the price is ellipsized away
  const fitPage = await openPage(url(SERIES + ' 3巻'));
  await settle(fitPage);
  const fit = await fitPage.evaluate(() => [...document.querySelectorAll('.bwdd-store-link')].map(a => {
    const name = a.querySelector('.bwdd-store-name');
    const state = a.querySelector('.bwdd-store-state');
    return {
      name: name ? name.scrollWidth <= name.clientWidth + 1 : true,
      state: state ? state.scrollWidth <= state.clientWidth + 1 : true,
    };
  }));
  await fitPage.close();
  check('no pill ellipsizes its shop name', fit.length === 5 && fit.every(p => p.name),
    fit.map(p => (p.name ? 'ok' : 'clipped')).join(','));
  check('no pill ellipsizes its price or free count', fit.length === 5 && fit.every(p => p.state),
    fit.map(p => (p.state ? 'ok' : 'clipped')).join(','));

  // ---- 4c. six shops, two rows of three: the six-pill grid is three cells a
  //          row, so the pills never wrap into a third row and every store name
  //          keeps its full text ------------------------------------------------
  check('all six shops appear together', pg.pills.length === 6, `pills=${pg.pills.length}: ${shown(pg.pills)}`);
  const rowTops = [...new Set(pg.pills.map(p => p.top))];
  check('six pills occupy exactly two rows', rowTops.length === 2,
    `rows=${rowTops.length}: ${shown(pg.pills)}`);
  check('and every shop name stays readable in the six-pill grid',
    pg.pills.length === 6 && pg.pills.every(p => p.nameFits),
    pg.pills.map(p => (p.nameFits ? 'ok' : 'clipped')).join(','));
  // Every cell spans two of the six tracks, and the span comes from the count
  // rather than a per-count CSS rule: the row carries no count class at all.
  const sixSpans = pg.pills.map(p => p.span);
  check('each six-pill row is three cells of two tracks',
    sixSpans.length === 6 && sixSpans.every(s => s === 'span 2'),
    sixSpans.join(','));
  check('the card carries no hand-tuned per-count class',
    pg.rowClass === 'bwdd-store-row is-compact', 'row class=' + (pg.rowClass || 'none'));

  // ---- 4f. a seventh synthetic source: the layout is computed from the count,
  //          so a store that did not exist when the card was written still lays
  //          out. The store is registered at runtime into a detached column,
  //          which is the general path without shipping a seventh store --------
  const sixthPage = await openPage(url(SERIES + ' 3巻'));
  const sixth = await sixthPage.evaluate(() => {
    const A = window.__bwddAvailability;
    if (!A) return { error: 'no availability debug surface' };
    const synthetic = {
      id: 'synthetic-seventh', siteId: 'synthetic-seventh', label: 'Shinjuku Books', pill: 'Shinjuku',
      short: 'S', color: '#6b7280', origin: 'https://example.test', hosts: ['example.test'],
      search: () => 'https://example.test/search', product: () => true, rank: () => 0,
      volumes: () => [],
    };
    A.register(synthetic);
    const results = A.stores.map((store, i) => ({
      store: store, available: true, url: 'https://example.test/' + store.id, why: 'match',
      freeMine: false, freeCount: 0, volTotal: 0, price: 100 + i, priceUnit: '',
      ku: false, kuCount: 0, kuSeen: 0, volFound: true, rows: 1, matchUrl: '',
    }));
    const host = document.createElement('div');
    host.className = 'bwdd-cards';
    document.body.appendChild(host);
    A.render(host, results, []);
    const row = host.querySelector('.bwdd-store-row');
    const pills = [...host.querySelectorAll('.bwdd-store-link, .bwdd-store-pending')];
    const out = {
      count: pills.length,
      rowClass: row ? row.className : '',
      spans: pills.map(p => p.style.gridColumn),
      rows: row ? [...new Set(pills.map(p => Math.round(p.getBoundingClientRect().top)))].length : 0,
      fits: pills.every(p => {
        const n = p.querySelector('.bwdd-store-name');
        return n ? n.scrollWidth <= n.clientWidth + 1 : true;
      }),
      layout4: A.layout(4), layout5: A.layout(5), layout6: A.layout(6), layout7: A.layout(7),
    };
    A.stores.pop();
    host.remove();
    return out;
  });
  await sixthPage.close();
  check('a seventh source is laid out from the count, not from a per-count rule',
    !sixth.error && sixth.count === 7 &&
    JSON.stringify(sixth.spans) === JSON.stringify(['span 3', 'span 3', 'span 3', 'span 3', 'span 2', 'span 2', 'span 2']),
    sixth.error || 'pills=' + sixth.count + ' spans=' + (sixth.spans || []).join(','));
  check('seven sources make three rows of two, two and three and no name is clipped',
    sixth.rows === 3 && sixth.fits === true, 'rows=' + sixth.rows + ' fits=' + sixth.fits);
  check('and a seven-pill row is compact by the same rule as the six-pill one',
    sixth.rowClass === 'bwdd-store-row is-compact' && !/--/.test(sixth.rowClass), sixth.rowClass);
  check('the layout function pins the counts the card must keep',
    !sixth.error && JSON.stringify(sixth.layout4.rows) === '[2,2]' &&
    JSON.stringify(sixth.layout5.rows) === '[2,3]' && JSON.stringify(sixth.layout5.spans) === '[3,3,2,2,2]' &&
    JSON.stringify(sixth.layout6.rows) === '[3,3]' && JSON.stringify(sixth.layout6.spans) === '[2,2,2,2,2,2]' &&
    JSON.stringify(sixth.layout7.rows) === '[2,2,3]',
    sixth.error || JSON.stringify({ l4: sixth.layout4, l5: sixth.layout5, l6: sixth.layout6, l7: sixth.layout7 }));

  // ---- 4e. the card is painted as answers land: the first shop to carry the
  //          book shows at once, under placeholders for the shops still being
  //          asked, and every placeholder is replaced once the answers are in --
  check('the card paints with placeholders while the later shops are still being asked',
    pg.skeleton.seen >= 1 && pg.skeleton.names.length >= 1,
    'placeholders=' + pg.skeleton.seen + ' names=' + (pg.skeleton.names.join(',') || 'none'));
  check('no placeholder is left once every shop has answered',
    pg.pendingLeft === 0 && pg.pills.length === 6, 'pending=' + pg.pendingLeft + ' pills=' + pg.pills.length);

  const e = await scenario(url(ABSENT));
  check('a title no shop carries shows no pills at all',
    e.pills.length === 0, `pills=${e.pills.length}: ${shown(e.pills)}`);
  check('and the empty card is not rendered', !e.hasCard, e.hasCard ? 'card present' : 'no card');

  const f = await scenario(url(SERIES));
  const bwNoVol = pick(f.pills, 'BookWalker');
  check('no volume number: free count still shown, no price claimed',
    !!bwNoVol && !/¥/.test(bwNoVol.text) && /2\/3 free/.test(bwNoVol.text), bwNoVol ? bwNoVol.text : 'none');

  const h = await scenario(url(SERIES + ' 3巻 | BOOK☆WALKER'));
  const bwNoisy = pick(h.pills, 'BookWalker');
  check('a title suffixed with the shop brand still matches',
    !!bwNoisy && bwNoisy.found, bwNoisy ? bwNoisy.href : 'none');
  check('and still reports the price off the matched page',
    !!bwNoisy && /¥810/.test(bwNoisy.text), bwNoisy ? bwNoisy.text : 'none');

  // An unnumbered, bonus-included edition has no volume number,
  // so numbering cannot find its row - the title has to. Without that the pill
  // used to fall back to a bare "available" with no price.
  const u = await scenario(url(SERIES + '【特典付】'));
  const bwUn = pick(u.pills, 'BookWalker');
  check('an unnumbered volume is matched by title and priced',
    !!bwUn && /¥500/.test(bwUn.text), bwUn ? bwUn.text : 'none');
  check('and no pill is left showing a filler word like "available"',
    !!bwUn && !/available/i.test(bwUn.text), bwUn ? bwUn.text : 'none');

  // ---- 8b. a title that opens with a number, sold as a 分冊版 on k-manga --
  // k-manga reports "123サンプル作品 分冊版(1)" while BookWalker spells
  // the base series "１２３サンプル作品（１）". Three things had to hold
  // or the store disappeared from the card: the 分冊版 suffix had to come off
  // without the trailing 話 being eaten as a volume marker, the full-width card
  // had to fold to the half-width seed, and the volume had to come from the
  // trailing （１） rather than the leading 123.
  const digits = await scenario(url('123サンプル作品 分冊版(1)'));
  const bwD = pick(digits.pills, 'BookWalker');
  check('a half-width seed still reaches a full-width store card',
    !!bwD && bwD.href === 'https://bookwalker.jp/series/999001/list/', bwD ? bwD.href : 'none');
  check('the base title survives a 分冊版 suffix that ends in 話',
    !!bwD, bwD ? bwD.text : 'none');
  check('the volume comes from the title\'s trailing marker, not its leading number',
    !!bwD && /¥792/.test(bwD.text), bwD ? bwD.text : 'none');

  // The viewer publishes its title asynchronously, so the first lookup can run
  // against a placeholder and come back "not found" everywhere. That must not
  // latch: when the real title lands the pills have to correct themselves.
  if (!HAS_BW_ADAPTER) {
    console.log('SKIP  late-metadata self-correction — this artifact has no BookWalker adapter');
  } else {
    const late = await openPage(url('読み込み中'));
    await sleep(2500);
    const beforeLate = await readPills(late);
    await late.evaluate((t) => { document.title = t; }, SERIES + ' 3巻');
    let corrected = true;
    try {
      // Wait for BookWalker's own price, not merely for some pill: the card now
      // appears as soon as the first shop answers, and that may be another shop.
      await late.waitForFunction(() =>
        [...document.querySelectorAll('.bwdd-store-link')].some(a => /¥810/.test(a.textContent)), { timeout: 20000 });
    } catch (e) { corrected = false; }
    const afterLate = await readPills(late);
    await late.close();
    check('a placeholder title does not latch a permanent "not found"',
      beforeLate.length === 0, shown(beforeLate));
    check('the pills correct themselves once the real title arrives',
      corrected && afterLate.some(p => /¥810/.test(p.text)), shown(afterLate));
  }

  const g = await scenario(url(SKIP + ' 1巻') + '&rurl=' + encodeURIComponent('https://evil.example/title/100004/'));
  const cm4 = pick(g.pills, 'CMOA');
  check('CMOA: an rurl on another host is ignored, so nothing is claimed',
    !cm4 || !cm4.href.includes('evil.example'), cm4 ? cm4.href : 'no CMOA pill');

  await browser.close(); srv.close();
  const failed = results.filter(r => !r.pass);
  console.log(failed.length ? '\n' + failed.length + ' FAILED' : '\nALL ' + results.length + ' CHECKS PASSED');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
