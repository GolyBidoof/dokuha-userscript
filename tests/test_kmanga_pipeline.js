#!/usr/bin/env node
'use strict';
/*
 * The k-manga pipelined page loop, against a fake socket.
 *
 * Pipelining is only safe because every reply names its own scene, so a reply
 * can be matched to the request that asked for it instead of trusting arrival
 * order. That is exactly what these checks pin: replies delivered out of order
 * must still land on the right page, a reply nobody asked for must abort rather
 * than be written somewhere, and a page that fails to rebuild must be one bad
 * page rather than a dead connection.
 *
 * No socket and no descrambler are involved: onPage here is a stub, because
 * what is under test is the scheduling, not the image work. The scenarios are
 * the same six the CLI's test_kmanga_pipeline.mjs runs.
 */
const { launch, reporter } = require('./_kmanga');

(async () => {
    const { check, finish } = reporter();
    const { browser, page, ready } = await launch();
    try {
        check('the k-manga adapter boots and publishes its protocol surface', ready, 'window.__bwddKmangaProtocol');

        const runs = await page.evaluate(async () => {
            const P = window.__bwddKmangaProtocol;
            const MAGIC = 'BCP000';

            function replyFor(sceneNo, text) {
                const payload = new TextEncoder().encode(text || ('scene-' + sceneNo));
                const body = new TextEncoder().encode(JSON.stringify({
                    version: '2.00',
                    scenes: [{ sceneNo, sceneImagePartition: 1, images: [{ format: 'jpeg', key: 0, width: 2, height: 2 }] }],
                }));
                const head = new Uint8Array(16);
                head.set(new TextEncoder().encode(MAGIC), 0);
                head.set(new TextEncoder().encode(String(body.length).padStart(10)), 6);
                const tail = new TextEncoder().encode(String(1).padStart(3) + String(payload.length).padStart(10));
                const out = new Uint8Array(head.length + body.length + tail.length + payload.length);
                out.set(head, 0);
                out.set(body, head.length);
                out.set(tail, head.length + body.length);
                out.set(payload, head.length + body.length + tail.length);
                return out;
            }

            /**
             * A socket that answers requests from a script. `order` decides which
             * waiting request is answered next; the default answers the oldest,
             * which is what the store was measured doing.
             */
            function FakeSocket(order, nameToScene) {
                this.order = order;
                this.nameToScene = nameToScene;
                this.waiting = [];
                this.outstanding = 0;
                this.maxOutstanding = 0;
                this.sent = 0;
                this.stray = null;
            }
            FakeSocket.prototype.sceneOf = function (text) {
                const name = /fn=([^&]*)/.exec(text)[1];
                if (name === 'unknown') return 999;
                const scene = this.nameToScene.get(name);
                if (scene === undefined) throw new Error('no scene for content name ' + name);
                return scene;
            };
            FakeSocket.prototype.send = function (text) {
                this.sent++;
                this.waiting.push(this.sceneOf(text));
                this.outstanding++;
                this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding);
            };
            FakeSocket.prototype.next = function () {
                if (this.stray !== null) {
                    const scene = this.stray;
                    this.stray = null;
                    return Promise.resolve({ opcode: 2, payload: replyFor(scene) });
                }
                if (!this.waiting.length) return Promise.reject(new Error('nothing outstanding to answer'));
                let index = 0;
                if (this.order === 'lifo') index = this.waiting.length - 1;
                else if (this.order === 'reverse2' && this.waiting.length > 1) index = 1;
                const scene = this.waiting.splice(index, 1)[0];
                this.outstanding--;
                return Promise.resolve({ opcode: 2, payload: replyFor(scene) });
            };

            const makeWork = (count) => Array.from({ length: count }, (_, i) => ({
                index: i,
                entry: { name: String(i), startSceneNo: i + 1 },
                sceneNo: i + 1,
            }));

            async function drain(opts) {
                const work = makeWork(opts.count);
                const socket = new FakeSocket(opts.order || 'fifo', new Map(work.map(w => [w.entry.name, w.sceneNo])));
                if (opts.stray != null) socket.stray = opts.stray;
                const seen = [];
                const errors = await P.drainPages({
                    socket,
                    session: { ticket: 'T', obfuid: 'O' },
                    manifest: { dk: 'DK' },
                    work,
                    depth: opts.depth == null ? 4 : opts.depth,
                    processLimit: opts.processLimit == null ? 4 : opts.processLimit,
                    onPage: async (item, frame) => {
                        if (opts.rejectScene === item.sceneNo) throw new Error('stub failure for scene ' + item.sceneNo);
                        seen.push({ scene: item.sceneNo, payload: new TextDecoder().decode(frame.chunks[0]) });
                    },
                });
                return {
                    seen,
                    errors: errors.map(e => ({ scene: e.item.sceneNo, message: String((e.error && e.error.message) || e.error) })),
                    maxOutstanding: socket.maxOutstanding,
                    sent: socket.sent,
                    expectedOrder: work.map(w => w.sceneNo),
                };
            }

            const out = {};

            // In order, which is what the store was measured doing.
            out.fifo = await drain({ count: 20, depth: 4 });

            // Out of order: the reply for the *second* outstanding request comes
            // back first. Matching on arrival order would put scene 7's bytes in
            // scene 6's file.
            out.reverse2 = await drain({ count: 20, depth: 4, order: 'reverse2' });

            // Last-in-first-out is the worst case for order assumptions.
            out.lifo = await drain({ count: 20, depth: 4, order: 'lifo' });

            // The pipeline bound has to hold, or "depth" means nothing.
            out.depth8 = await drain({ count: 40, depth: 8 });
            out.depth1 = await drain({ count: 5, depth: 1 });

            // A reply for a scene nobody asked for means the framing assumption
            // has broken; continuing would write it under some other page's name.
            try {
                await drain({ count: 3, depth: 3, processLimit: 3, stray: 999 });
                out.strayError = '';
            } catch (e) {
                out.strayError = String(e.message);
            }

            // One page that will not rebuild is one bad page. It must not take the
            // volume, or the connection, with it.
            out.oneBadPage = await drain({ count: 10, depth: 4, rejectScene: 5 });

            return out;
        });

        const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected),
            'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));

        eq('every page is processed', runs.fifo.seen.length, 20);
        eq('nothing fails', runs.fifo.errors.length, 0);
        eq('they arrive in scene order', runs.fifo.seen.map(s => s.scene), runs.fifo.expectedOrder);
        eq('the socket is reused rather than reopened per page', runs.fifo.sent, 20);

        eq('an out-of-order run still processes every page', runs.reverse2.seen.length, 20);
        eq('an out-of-order run fails nothing', runs.reverse2.errors.length, 0);
        eq('each page still gets its own bytes', runs.reverse2.seen.filter(s => s.payload !== 'scene-' + s.scene).length, 0);

        eq('a reversed delivery still processes every page', runs.lifo.seen.length, 20);
        eq('a reversed delivery still matches every page', runs.lifo.seen.filter(s => s.payload !== 'scene-' + s.scene).length, 0);
        eq('a reversed delivery still fails nothing', runs.lifo.errors.length, 0);

        eq('never more than `depth` requests are outstanding', runs.depth8.maxOutstanding, 8);
        eq('a depth of 1 is strictly one at a time', runs.depth1.maxOutstanding, 1);

        check('an unrequested scene aborts the volume', /cannot be matched to a request/.test(runs.strayError), runs.strayError);

        eq('the other pages still land', runs.oneBadPage.seen.length, 9);
        eq('the bad page is reported once', runs.oneBadPage.errors.length, 1);
        eq('and it is the right one', runs.oneBadPage.errors[0] && runs.oneBadPage.errors[0].scene, 5);
        check('seen pages never include the failed one', !runs.oneBadPage.seen.some(s => s.scene === 5), 'scenes=' + runs.oneBadPage.seen.map(s => s.scene).join(','));
    } finally {
        await browser.close().catch(() => {});
    }
    finish();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
