# k-manga protocol notes

The k-manga adapter claims `https://comic.k-manga.jp/viewer/*`. It is the only store whose pages arrive over a WebSocket rather than over HTTP page requests, so its transport and its reassembly are both unusual.

## Where the protocol lives

| File | What it does |
| --- | --- |
| `00-state.js` | viewer and launcher detection, the page list, the key state and the title page data |
| `01-protocol.js` | the BCP000 wire format, the LCG block permutation and the title page parser |
| `02-ws.js` | the viewer WebSocket transport and its request queue |
| `04-descramble.js` | the canvas descrambler and the page decoder |
| `05-run.js` | the run pipeline and adapter registration |
| `40-availability.js` | the "also available on" search, point price and free volume detection, combined build only |

## The details that matter

- **BCP000 is length framed, not JSON lines.** A message is the magic `BCP000`, then ten ASCII digits of JSON length, then the JSON. A content reply adds three digits of chunk count, one ten-digit length per chunk, then the raw chunk bytes. The chunks are raw JPEG bytes; treating them as base64 yields a 170-byte "image".
- **Pipelining is safe because every reply names its own scene.** The run sends data requests without waiting for each answer and matches each reply to the request that asked for it by scene number, instead of trusting arrival order.
- **The unscramble is a block permutation.** `01-protocol.js` carries the LCG constants exactly as the CLI's implementation found them, because recorded fixtures pin those widths and constants; `04-descramble.js` applies the permutation on a canvas.
- **The title page prices in points.** Its volume rows state an amount in points rather than yen, and a free volume is recognised from its own `無料で読む` button rather than from a zero amount, because the row keeps the regular point price. The volume list paginates, so page two is read before the series size and free count are believed.

## What pins it

- `tests/test_kmanga_protocol.js` decodes the two recorded BCP000 frames from a real capture.
- `tests/test_kmanga_pipeline.js` drives the pipelined page loop against a fake socket and proves replies are matched by scene.
- `tests/test_kmanga_descramble.js` scores seam energy on a real page, because a wrongly unshuffled page still decodes perfectly as a mosaic.
- `tests/test_kmanga_title_page.js` pins the free volume and point price reading against markup lifted from the live page.
- `tests/test_site_dispatch.js` and `tests/test_split_builds.js` pin the reader-only claim and the split artifacts.
