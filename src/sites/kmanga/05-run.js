    // The shared harness owns the bars, the Mokuro session, the ZIP assembly and
    // the reporting; what is left here is k-manga's own shape: one WebSocket
    // pool, a pipelined request loop that matches every reply by its scene
    // number, and one canvas descramble per page.
    //
    // Ported from dokuha-cli src/download/kmanga.js (drainPages, downloadKmanga
    // and the socket-pool measurement notes). The CLI wrote a folder and a
    // volume marker; here the shared harness builds the ZIP and the page cache
    // is the resume mechanism, so the index/marker plumbing has no counterpart.

    // Ported from dokuha-cli src/download/kmanga.js (openKmangaSession,
    // fetchKmangaIndex). The Node version fetched the launcher with
    // redirect:'manual' and read the Location header. A browser cannot: a manual
    // redirect is handed back as an opaque response with status 0 and no readable
    // headers, even same-origin. The browser therefore repeats the redirect the
    // tab itself would have followed and reads the final viewer URL off the
    // response, which is the one place this port genuinely departs from the CLI.
    function kmangaBookIdFromPath(pathname) {
        const m = /\/title\/(\d+)/.exec(String(pathname || ''));
        return m ? m[1] : null;
    }

    // The store publishes the work name in several places. On the reader page the
    // authoritative one is the toolbar the viewer fills in itself (#ic-title); the
    // structured data, og:title and heading only exist on the store pages. The
    // viewer's own document.title is "まんが王国NextViewer" for every book, so it is
    // not a title and must never be used as one.
    function kmangaTitleFromDocument() {
        try {
            const toolbar = document.querySelector('#ic-title');
            const shown = toolbar && toolbar.textContent.replace(/\s+/g, ' ').trim();
            if (shown) return shown;
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of scripts) {
                const m = /"@type"\s*:\s*"ProductGroup"[\s\S]{0,300}?"name"\s*:\s*"([^"]+)"/.exec(script.textContent || '');
                if (m) return kmangaDecodeEntities(m[1]);
            }
            const og = document.querySelector('meta[property="og:title"]');
            if (og && og.content) return kmangaDecodeEntities(og.content);
            const h1 = document.querySelector('h1');
            if (h1 && h1.textContent.replace(/\s+/g, ' ').trim()) return h1.textContent.replace(/\s+/g, ' ').trim();
            const doc = document.title || '';
            return /viewer/i.test(doc) ? '' : doc;
        } catch (e) { return ''; }
    }

    // The same three sources, read out of a fetched title page rather than the
    // current document. The reader never names the book, so this is the only
    // same-origin place the series name exists.
    function kmangaTitleFromHtml(html) {
        const text = String(html || '');
        const ld = /"@type"\s*:\s*"ProductGroup"[\s\S]{0,300}?"name"\s*:\s*"([^"]+)"/.exec(text);
        if (ld) return kmangaDecodeEntities(ld[1]);
        const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(text)
            || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(text);
        if (og) return kmangaDecodeEntities(og[1]);
        const h1 = /<h1[^>]*>([\s\S]{1,200}?)<\/h1>/i.exec(text);
        if (h1) {
            const plain = kmangaDecodeEntities(h1[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
            if (plain) return plain;
        }
        return '';
    }

    // Fetch the store's own title page, awaited by refresh() so the name exists
    // before the panel reads it. The reader page carries no book name at all: its
    // toolbar slot is empty in the served markup, and the only requests it makes
    // are the page manifest and the viewer socket.
    //
    // The first request can come back as the launcher gate, which sets the isIPad
    // cookie and redirects back to the same URL instead of serving the page. That
    // response has no title, so a few polls are allowed and the cookie from the
    // first one lets the next succeed. A slow or blocked request resolves empty
    // rather than holding the panel open.
    function kmangaFetchSeriesTitle(bookId) {
        if (!bookId) return Promise.resolve('');
        const attempts = kmangaState.titleAttempts || (kmangaState.titleAttempts = {});
        if ((attempts[bookId] || 0) >= 3) return Promise.resolve('');
        attempts[bookId] = (attempts[bookId] || 0) + 1;
        let request;
        try {
            request = fetch('https://comic.k-manga.jp/title/' + encodeURIComponent(bookId) + '/pv', {
                credentials: 'same-origin',
            }).then(res => (res && res.ok ? res.text() : ''))
                .catch(() => '');
        } catch (e) { return Promise.resolve(''); }
        const timeout = new Promise(resolve => setTimeout(() => resolve(''), 4000));
        return Promise.race([request, timeout]).then(html => (html ? kmangaTitleFromHtml(html) : ''));
    }

    // The panel calls this before it reads getBook()/getPreview(), so metadata
    // settles as soon as the viewer URL or the title page has been seen.
    async function kmangaRefreshState() {
        const viewer = kmangaParseViewerUrl(location.href);
        if (viewer.ticket && viewer.obfuid) {
            kmangaState.session = viewer;
            if (viewer.bookId) kmangaState.bookId = viewer.bookId;
            // The reader URL carries the volume in p4, and that is the only place it
            // exists on this page: the title page names the series without one.
            const p4 = viewer.params && viewer.params.get ? viewer.params.get('p4') : null;
            if (!Number.isInteger(kmangaState.volume) && p4 && /^\d{1,4}$/.test(p4) && Number(p4) > 0) {
                kmangaState.volume = Number(p4);
            }
            kmangaState.launcher = null;
        } else {
            kmangaState.session = null;
            const launcher = kmangaParseLauncherUrl(location.href);
            if (launcher) {
                kmangaState.launcher = launcher.url;
                if (launcher.bookId) kmangaState.bookId = launcher.bookId;
                if (Number.isInteger(launcher.volume)) kmangaState.volume = launcher.volume;
            } else if (!kmangaState.bookId) {
                kmangaState.bookId = kmangaBookIdFromPath(location.pathname);
            }
        }
        kmangaState.rawTitle = kmangaState.rawTitle || kmangaTitleFromDocument();
        // Nothing on the reader names the book, so ask the store's title page for it
        // before the panel reads the metadata.
        if (!kmangaState.rawTitle) {
            const fetched = await kmangaFetchSeriesTitle(kmangaState.bookId);
            if (fetched) kmangaState.rawTitle = fetched;
        }
        // The title page names the series but not the volume, so put the volume on
        // it in the store's own "(n)" form unless the name already carries one.
        if (kmangaState.rawTitle && Number.isInteger(kmangaState.volume) && kmangaState.volume > 0
            && !/\(\s*\d+\s*\)\s*$/.test(kmangaState.rawTitle)) {
            kmangaState.rawTitle = kmangaState.rawTitle + '(' + kmangaState.volume + ')';
        }
        if (!kmangaState.title) {
            const cleaned = cleanTitle(kmangaState.rawTitle);
            if (cleaned) kmangaState.title = cleaned;
        }
        // A title page names the series but not a volume; take the volume from
        // whatever the address or the launcher says, never by guessing.
        if (!Number.isInteger(kmangaState.volume)) {
            const sv = splitSeriesVolume(kmangaState.title || kmangaState.rawTitle || '');
            if (sv && isFinite(sv.volNum) && sv.volNum) kmangaState.volume = sv.volNum;
        }
        kmangaState.ready = !!kmangaState.bookId;
        return kmangaState.ready;
    }

    async function kmangaOpenSession() {
        const viewer = kmangaParseViewerUrl(location.href);
        if (viewer.ticket && viewer.obfuid) {
            return { viewerUrl: location.href, session: viewer };
        }
        if (!kmangaState.launcher) {
            const launcher = kmangaParseLauncherUrl(location.href);
            kmangaState.launcher = launcher ? launcher.url : kmangaState.launcher;
        }
        if (!kmangaState.launcher) {
            kmangaRefreshState();
        }
        if (!kmangaState.launcher) {
            throw new Error('This is not a k-manga viewer page: open a volume (無料で読む / 試し読み) and start the download there.');
        }
        const response = await fetchWithTimeout(kmangaState.launcher, {
            credentials: 'include',
            redirect: 'follow',
            headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ja,en;q=0.8' },
        }, 45000);
        if (!response || !response.ok) {
            throw new Error('k-manga launcher answered HTTP ' + (response ? response.status : '0') + ': ' + kmangaState.launcher);
        }
        const viewerUrl = response.url || '';
        const session = kmangaParseViewerUrl(viewerUrl);
        if (!session.ticket || !session.obfuid) {
            throw new Error('k-manga launcher did not land on a viewer URL carrying a ticket and an obfuid: ' + viewerUrl);
        }
        return { viewerUrl: viewerUrl, session: session };
    }

    // The index is a second HTTP round trip whose only product is the chapter
    // list. This project has no volume marker to store it in, so it is fetched
    // for its own sake (and its failures are ignored), never on the critical path.
    async function kmangaFetchIndex(session) {
        const url = KM_API_URL + '?t=' + encodeURIComponent(session.ticket) + '&fn=index.csv'
            + '&o=' + encodeURIComponent(session.obfuid) + '&type=index&callback=cb&u=' + Date.now();
        try {
            const response = await laneFetch(url, 45000, { allowProxy: proxyCanServe(hostOf(url)) });
            if (!response || !response.ok) return null;
            return kmangaParseIndexJsonp(await response.text());
        } catch (e) {
            return null;
        }
    }

    // The greeting belongs to the *connection*: a reconnect must read it again
    // even when the manifest it already holds is still valid. The header reply
    // belongs to the *ticket*, so a retry reuses it rather than spending another
    // round trip on an answer that cannot have changed.
    async function kmangaGreetSocket(socket) {
        const hello = await socket.next(KM_READ_TIMEOUT_MS);
        const greeting = kmangaParseFrame(hello.payload);
        if (!greeting.hello) throw new Error('k-manga socket did not greet with a bare BCP000 frame');
    }

    async function kmangaReadManifest(socket, session) {
        socket.send(kmangaBuildHeaderRequest({
            ticket: session.ticket,
            obfuid: session.obfuid,
            profile: KM_PROFILES[0],
        }));
        const reply = await socket.next(KM_READ_TIMEOUT_MS);
        const frame = kmangaParseFrame(reply.payload);
        if (frame.chunks !== null) throw new Error('k-manga header reply unexpectedly carried image data');
        const body = frame.body || {};
        if (!Array.isArray(body.contentInfos) || !body.contentInfos.length) {
            throw new Error('k-manga header reply listed no pages: ' + JSON.stringify(body).slice(0, 200));
        }
        return body;
    }

    async function kmangaDrainPages(args) {
        const socket = args.socket;
        const session = args.session;
        const manifest = args.manifest;
        const work = args.work;
        const depth = args.depth;
        const processLimit = args.processLimit;
        const onPage = args.onPage;

        const outstanding = new Map();
        const processing = new Set();
        const errors = [];
        let cursor = 0;

        const fill = function () {
            while (outstanding.size < depth && cursor < work.length) {
                const item = work[cursor++];
                outstanding.set(item.sceneNo, item);
                socket.send(kmangaBuildDataRequest({
                    ticket: session.ticket,
                    obfuid: session.obfuid,
                    name: item.entry.name,
                    decryptKey: manifest.dk,
                }));
            }
        };

        fill();
        while (outstanding.size) {
            // Pipelining is only safe because every reply names its own scene, so
            // a reply is matched to the request that asked for it rather than
            // trusted to arrive in order.
            const reply = await socket.next(KM_READ_TIMEOUT_MS);
            const frame = kmangaParseFrame(reply.payload);
            const scenes = frame.body && frame.body.scenes;
            const sceneNo = Array.isArray(scenes) && scenes.length ? scenes[0].sceneNo : undefined;
            const item = outstanding.get(sceneNo);
            if (!item) {
                // A reply nobody asked for means the framing assumption broke.
                // Continuing would write it under some other page's name.
                throw new Error('k-manga answered scene ' + sceneNo + ' while ' + outstanding.size
                    + ' other page(s) were outstanding, so the reply cannot be matched to a request');
            }
            outstanding.delete(sceneNo);
            fill();

            const task = onPage(item, frame).catch(function (error) {
                errors.push({ item: item, error: error || new Error('page failed') });
            });
            processing.add(task);
            task.finally(function () { processing.delete(task); });
            if (processing.size >= processLimit) await Promise.race(processing);
        }
        await Promise.all(processing);
        return errors;
    }

    async function kmangaOpenManifest(session) {
        const socket = await kmangaConnectSocket(KM_WS_URL);
        try {
            await kmangaGreetSocket(socket);
            const manifest = await kmangaReadManifest(socket, session);
            return { socket: socket, manifest: manifest };
        } catch (e) {
            try { socket.close(); } catch (e2) {}
            throw e;
        }
    }

    async function kmangaRun(ui, mode, options) {
        const runOptions = normalizeRunOptions(options, mode);
        const runResult = runOptions.automation
            ? (runOptions.result || newAutomationResult(mode, kmangaState.bookId || '', runOptions.deferFinalize))
            : null;
        if (runResult) {
            runOptions.result = runResult;
            runOptions.errors = runResult.errors;
        }

        let harness = null;
        try {
            reportRunProgress(runOptions, 'started', { mode: mode, cid: kmangaState.bookId || '' });
            kmangaState.running = true;
            if (!kmangaState.bookId) kmangaRefreshState();

            // The launcher mints the ticket the socket needs, so the session is
            // unavoidably first.
            const opened = await kmangaOpenSession();
            const session = opened.session;
            const bookId = session.bookId || kmangaState.bookId || 'unknown';

            // A viewer URL carries the volume in p4, which parseLauncherUrl does
            // not read; the launcher URL does carry it, so prefer that. Failing
            // both, the number in the page title is the last honest source.
            let volume = kmangaState.volume;
            const launcher = kmangaParseLauncherUrl(opened.viewerUrl || '');
            if (launcher && Number.isInteger(launcher.volume)) volume = launcher.volume;
            if (!Number.isInteger(volume)) {
                const listed = kmangaParseLauncherUrl(location.href);
                if (listed && Number.isInteger(listed.volume)) volume = listed.volume;
            }
            const rawTitle = kmangaState.rawTitle || kmangaTitleFromDocument();
            const name = kmangaState.title || cleanTitle(rawTitle) || ('k-manga ' + bookId);
            const title = volume ? name + ' (' + volume + ')' : name;
            const sv = splitSeriesVolume(title);
            const archiveName = ui.syncArchiveDefault(rawTitle) || zipBaseName(sv, title);
            const cid = bookId + 'vol' + (volume == null ? '' : volume);

            if (runResult) {
                runResult.cid = bookId;
                runResult.mode = mode;
                runResult.title = title;
                reportRunProgress(runOptions, 'book', { title: title, cid: bookId });
            }

            // The index is off the critical path: it is a second HTTP round trip
            // whose only product is the chapter list, which this project has no
            // marker to store. Started here so it overlaps the socket handshake.
            kmangaFetchIndex(session).then(function (index) {
                if (index) kmangaLog('index listed ' + index.chapters.length + ' chapter(s)');
            }, function () {});

            // The first socket also carries the header reply: the page list and
            // the ticket's decrypt key. It has to settle before the harness can
            // know the total, so it stands outside the attempt loop; the manifest
            // is reused by every attempt, the greeting never is.
            const first = await kmangaOpenManifest(session);
            const manifest = first.manifest;
            let spare = first.socket;

            const pages = manifest.contentInfos.slice().sort(function (a, b) {
                return Number(a.startSceneNo) - Number(b.startSceneNo);
            });
            const total = pages.length;
            if (!total) throw new Error('k-manga listed no pages for this volume.');
            kmangaState.total = total;
            kmangaState.manifest = manifest;

            harness = createRunHarness(ui, mode, runOptions, {
                title: title, archiveName: archiveName, sv: sv, total: total, cid: cid,
            });
            harness.setTotal(total);
            if (runResult) {
                runResult.total = total;
                reportRunProgress(runOptions, 'manifest', { total: total, plaintext: true });
            }
            if (!runOptions.headless) {
                renderBookCard(ui.statsEl, {
                    title: title, pages: total, resolution: kmangaState.resolution, type: 'k-manga Viewer',
                });
                if (sv.series) fetchAndRenderStats(ui.statsEl, sv.series, sv.volNum);
            }
            harness.showBars();
            if (harness.mokuro) await harness.mokuro.open();

            const depth = Math.max(1, Math.min(KM_MAX_DEPTH, Number(runOptions.kmConcurrency) || KM_DEFAULT_DEPTH));
            const processLimit = Math.max(1, Math.min(KM_PROCESS_LIMIT, depth));
            const attempts = Math.max(1, Math.min(KM_MAX_ATTEMPTS, 1 + (Number(runOptions.retries) || 0)));

            let downloaded = 0;
            let cachedCount = 0;
            let lastError = null;
            const done = new Set();
            const permanent = new Map();
            const work = pages.map(function (entry, position) {
                return { index: position, entry: entry, sceneNo: Number(entry.startSceneNo) };
            });

            // A page from a previous run needs neither a socket request nor a
            // descramble; replaying it keeps a resumed volume cheap.
            if (runOptions.usePageCache && cid) {
                for (const item of work) {
                    let cached = null;
                    try { cached = await getCachedPage(cid, item.index + 1); } catch (e) { cached = null; }
                    if (!cached) continue;
                    harness.bumpCached(1);
                    harness.noteCached(item.index + 1, cached, cachedPageCrc.get(cached));
                    done.add(item.index);
                    cachedCount++;
                }
            }

            for (let attempt = 1; attempt <= attempts; attempt++) {
                const sockets = [];
                try {
                    let socket = spare;
                    spare = null;
                    if (socket) {
                        sockets.push(socket);
                    } else {
                        socket = await kmangaConnectSocket(KM_WS_URL);
                        await kmangaGreetSocket(socket);
                        // Every socket authenticates the same way; the key is per
                        // ticket, so the reply must match the first socket's.
                        await kmangaReadManifest(socket, session);
                        sockets.push(socket);
                    }

                    const todo = work.filter(function (item) {
                        return !done.has(item.index) && !permanent.has(item.index);
                    });
                    if (!todo.length) break;

                    // One connection is rate-limited by the store no matter how
                    // deep its pipeline is, so the remaining pages are spread over
                    // a few sockets; extra sockets are only opened when the sheet
                    // is long enough to need them.
                    const count = Math.max(1, Math.min(KM_MAX_SOCKETS, Math.ceil(todo.length / KM_PAGES_PER_SOCKET)));
                    if (count > 1) {
                        const rest = await Promise.all(Array.from({ length: count - 1 }, async function () {
                            const extra = await kmangaConnectSocket(KM_WS_URL);
                            await kmangaGreetSocket(extra);
                            await kmangaReadManifest(extra, session);
                            return extra;
                        }));
                        for (const extra of rest) sockets.push(extra);
                    }

                    const shards = sockets.map(function () { return []; });
                    todo.forEach(function (item, i) { shards[i % sockets.length].push(item); });
                    // The rebuild budget is a property of the machine, not of the
                    // socket, so it is divided by the pool.
                    const perSocketProcess = Math.max(1, Math.round(processLimit / sockets.length));

                    // allSettled, not all: a socket that dies must not abandon the
                    // other shards' promises, and the retry must start from a
                    // settled page set rather than racing one still being written.
                    const settled = await Promise.allSettled(sockets.map(function (s, index) {
                        return kmangaDrainPages({
                            socket: s, session: session, manifest: manifest, work: shards[index],
                            depth: depth, processLimit: perSocketProcess,
                            onPage: async function (item, frame) {
                                harness.bumpFetched(1);
                                const out = await kmangaPageBlob(frame, item.entry);
                                downloaded++;
                                done.add(item.index);
                                harness.notePage(item.index + 1, out.blob, undefined, out.ext);
                            },
                        });
                    }));

                    let shardError = null;
                    for (const outcome of settled) {
                        if (outcome.status === 'fulfilled') {
                            for (const failure of outcome.value) {
                                const message = (failure.error && failure.error.message) || String(failure.error);
                                permanent.set(failure.item.index, message);
                                harness.noteFailure(failure.item.index + 1, message);
                            }
                        } else {
                            shardError = shardError || outcome.reason;
                        }
                    }
                    if (shardError) throw shardError;
                    if (!work.some(function (item) {
                        return !done.has(item.index) && !permanent.has(item.index);
                    })) break;
                } catch (error) {
                    lastError = error;
                } finally {
                    for (const socket of sockets) { try { socket.close(); } catch (e) {} }
                }
            }

            const unfinished = work.filter(function (item) {
                return !done.has(item.index) && !permanent.has(item.index);
            });
            if (unfinished.length) {
                throw new Error('k-manga: ' + unfinished.length + ' of ' + total + ' pages of "' + title
                    + '" were never fetched' + (lastError ? ': ' + lastError.message : ''));
            }
            if (!downloaded && !cachedCount) {
                throw new Error('k-manga: every one of the ' + total + ' pages of "' + title + '" failed to download'
                    + (lastError ? ': ' + lastError.message : ''));
            }

            if (mode === 'ocr' && harness.mokuro) {
                await harness.mokuro.settle();
                if (runOptions.deferFinalize) return harness.mokuro.deferred();
                const fin = await harness.mokuro.finalize();
                harness.markFinished();
                return harness.outcome(fin.ok);
            }
            if (mode === 'ocr' && !harness.mokuro) {
                throw new Error('Mokuro OCR is unavailable for this run');
            }

            const missing = total - harness.okIdx.size;
            if (missing === total) {
                setRunDetails(harness.details, msgAllFailedZip(), harness.errors);
                return harness.outcome(false);
            }
            return await harness.finishZip();
        } catch (e) {
            const reported = harness ? harness.reportFailure(e) : null;
            if (reported) throw reported;
            throw e;
        } finally {
            kmangaState.running = false;
            if (harness) await harness.cleanup();
        }
    }

    function kmangaOwnsHost() {
        try { return /(^|\.)k-manga\.jp$/i.test(location.hostname); } catch (e) { return false; }
    }
    registerSite({
        id: 'kmanga',
        label: 'k-manga',
        panelTitle: 'k-manga Native Downloader',
        ownsHost() {
            return kmangaOwnsHost();
        },
        matches() {
            // The reader is the only page this adapter can work on. The title page
            // and the root have no viewer session and no pages to fetch, and claiming
            // them painted the panel, and its error state, before the reader existed.
            try {
                return kmangaOwnsHost() && /^\/viewer\//.test(location.pathname);
            } catch (e) { return false; }
        },
        install() {
            // The launcher's redirect chain is gated on the isIPad cookie. The
            // store sets it for its own viewer, but a hidden frame sent straight
            // at a launcher URL can arrive before any page has; the CLI had to
            // send Cookie: isIPad=off by hand, so set it once here instead.
            try {
                if (!/(^|;\s*)isIPad=/.test(document.cookie)) document.cookie = 'isIPad=off; path=/';
            } catch (e) {}
        },
        // Returned, not dropped: the core awaits this before it reads the title, so
        // the title-page fetch has to be part of the promise it waits on.
        refresh() { return kmangaRefreshState(); },
        getBook() {
            const title = kmangaState.title || cleanTitle(kmangaState.rawTitle);
            if (!title) return null;
            const sv = splitSeriesVolume(title);
            return {
                rawTitle: kmangaState.rawTitle || title,
                title: title,
                series: sv.series,
                volNum: sv.volNum,
            };
        },
        getPreview() {
            if (!kmangaState.ready) return null;
            const title = kmangaState.title || ('k-manga ' + (kmangaState.bookId || ''));
            return {
                title: title,
                pages: kmangaState.total || 0,
                resolution: kmangaState.resolution || '',
                type: 'k-manga Viewer',
            };
        },
        getCid() { return kmangaState.bookId || ''; },
        archiveDefault(rawTitle) { return archiveDefaultName(rawTitle) || fsSafePath(kmangaState.bookId || ''); },
        run(ui, mode, options) { return kmangaRun(ui, mode, options); },
        state: kmangaState,
        debug: {
            kmangaState: kmangaState,
        },
        debugGlobals: {
            __bwddKmanga: kmangaState,
            // The wire format, so it can be checked against recorded frames with
            // no socket at all.
            __bwddKmangaProtocol: {
                parseFrame: kmangaParseFrame,
                parseIndexJsonp: kmangaParseIndexJsonp,
                parseViewerUrl: kmangaParseViewerUrl,
                parseTitlePage: kmangaParseTitlePage,
                parseLauncherUrl: kmangaParseLauncherUrl,
                buildHeaderRequest: kmangaBuildHeaderRequest,
                buildDataRequest: kmangaBuildDataRequest,
                scrambleGeometry: kmangaScrambleGeometry,
                scrambleOrder: kmangaScrambleOrder,
                readJpegSize: kmangaReadJpegSize,
                isScrambled: kmangaIsScrambled,
                descrambleJpeg: kmangaDescrambleJpeg,
                pageBlob: kmangaPageBlob,
                // The scheduler, so the scene-matching and pipeline bounds can be
                // driven from a fake socket with no network at all.
                drainPages: kmangaDrainPages,
                connectSocket: kmangaConnectSocket,
                greetSocket: kmangaGreetSocket,
                readManifest: kmangaReadManifest,
            },
        },
    });
