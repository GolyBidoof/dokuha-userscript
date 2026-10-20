    const PANEL_POS_KEY = 'bwdd-panel-pos';
    const PANEL_COLLAPSED_KEY = 'bwdd-panel-collapsed';
    const PANEL_WIDTH_KEY = 'bwdd-panel-width';
    const PANEL_HEIGHT_KEY = 'bwdd-panel-height';

    function buildUI() {
        injectStyles();
        const root = document.createElement('section');
        root.id = 'bwdd-root';
        // A labelled region, not a modal dialog: the panel never traps focus
        // or blocks the viewer behind it, and Esc collapses rather than closes.
        root.setAttribute('role', 'region');
        root.setAttribute('aria-labelledby', 'bwdd-panel-title');

        const head = document.createElement('div');
        head.className = 'bwdd-head';
        head.setAttribute('title', 'Drag to reposition');

        const titleGroup = document.createElement('div');
        titleGroup.className = 'bwdd-title-group';

        const title = document.createElement('h2');
        title.id = 'bwdd-panel-title';
        title.className = 'bwdd-title';
        title.innerHTML = '<span class="bwdd-icon" aria-hidden="true">📖</span> ' + sitePanelTitle();

        const titleSub = document.createElement('div');
        titleSub.className = 'bwdd-title-sub';

        const sub = document.createElement('div');
        sub.className = 'bwdd-subtitle';
        sub.textContent = `v${BWDD_VERSION} by ${BWDD_AUTHOR}`;

        const ghLink = document.createElement('a');
        ghLink.className = 'bwdd-gh';
        ghLink.href = BWDD_REPO_URL;
        ghLink.target = '_blank';
        ghLink.rel = 'noopener noreferrer';
        ghLink.setAttribute('aria-label', 'Open the GitHub repository in a new tab');
        ghLink.title = 'GitHub repository: ' + BWDD_REPO_URL;
        ghLink.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
        const mark = document.createElement('a');
        mark.className = 'bwdd-mark';
        mark.href = BWDD_REPO_URL;
        mark.target = '_blank';
        mark.rel = 'noopener noreferrer';
        mark.textContent = BWDD_SCRIPT_NAME;
        mark.title = BWDD_SCRIPT_NAME + ' \u2014 the combined downloader: ' + BWDD_REPO_URL;
        mark.setAttribute('aria-label', 'Open the ' + BWDD_SCRIPT_NAME + ' repository in a new tab');
        titleSub.append(sub, mark, ghLink);

        // A single-store build also points at the combined script. The module
        // that defines this is not in every target, so check before calling.
        if (typeof unifiedDownloaderLink === 'function') {
            const unified = unifiedDownloaderLink();
            if (unified) titleSub.appendChild(unified);
        }
        titleGroup.append(title, titleSub);

        const ctrlGroup = document.createElement('div');
        ctrlGroup.className = 'bwdd-head-controls';

        const minBtn = document.createElement('button');
        minBtn.type = 'button';
        minBtn.className = 'bwdd-ctrl-btn';
        minBtn.setAttribute('aria-label', 'Minimize panel');
        minBtn.setAttribute('aria-expanded', 'true');
        minBtn.setAttribute('aria-controls', 'bwdd-body');
        minBtn.textContent = '–';
        minBtn.setAttribute('title', 'Minimize panel (Esc)');
        function setCollapsed(isCol) {
            root.classList.toggle('collapsed', isCol);
            minBtn.textContent = isCol ? '+' : '–';
            minBtn.setAttribute('aria-label', isCol ? 'Expand panel' : 'Minimize panel');
            minBtn.setAttribute('aria-expanded', String(!isCol));
            try { localStorage.setItem(PANEL_COLLAPSED_KEY, isCol ? '1' : '0'); } catch (e) {}
        }
        minBtn.onclick = () => setCollapsed(!root.classList.contains('collapsed'));

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'bwdd-ctrl-btn';
        closeBtn.setAttribute('aria-label', 'Close downloader panel');
        closeBtn.setAttribute('title', 'Close panel');
        closeBtn.textContent = '×';
        // Close tears the panel down completely: it stops the bridge-health poll
        // and removes the window-level listener + observer, so nothing keeps
        // hitting 127.0.0.1:62642 or mutating detached DOM after the user closes
        // the panel. (The edge-tab "flap" is the non-destructive alternative.)
        closeBtn.onclick = () => {
            try { if (bridgeTimer) { clearTimeout(bridgeTimer); bridgeTimer = null; } } catch (e) {}
            try { window.removeEventListener('keydown', onPanelKeydown); } catch (e) {}
            try { document.removeEventListener('click', onNameDocClick); } catch (e) {}
            try { statsObs.disconnect(); } catch (e) {}
            try { root.remove(); } catch (e) {}
            try { if (edgeTab) edgeTab.remove(); } catch (e) {}
        };

        const flapBtn = document.createElement('button');
        flapBtn.type = 'button';
        flapBtn.className = 'bwdd-ctrl-btn';
        flapBtn.setAttribute('aria-label', 'Hide the panel to the right edge');
        flapBtn.setAttribute('aria-expanded', 'true');
        flapBtn.setAttribute('title', 'Slide the panel away to the right edge of the screen');
        flapBtn.textContent = '»';

        ctrlGroup.append(flapBtn, minBtn, closeBtn);

        const dragGrip = document.createElement('span');
        dragGrip.className = 'bwdd-drag-grip';
        dragGrip.setAttribute('aria-hidden', 'true');
        dragGrip.textContent = '\u283F';   // braille dots: grab handle look
        head.append(dragGrip, titleGroup, ctrlGroup);

        const body = document.createElement('div');
        body.className = 'bwdd-body';
        body.id = 'bwdd-body';

        const bridgeRow = document.createElement('div');
        bridgeRow.className = 'bwdd-bridge-pill';
        const dot = document.createElement('span');
        dot.className = 'bwdd-indicator-dot';
        dot.setAttribute('aria-hidden', 'true');
        const bridgeText = document.createElement('span');
        bridgeText.className = 'bwdd-bridge-text';
        bridgeText.textContent = 'Looking for the Mokuro Bridge helper…';
        bridgeRow.title = 'mokuro-bridge: a small local app (github.com/GolyBidoof/mokuro-bridge) that runs mokuro OCR on the downloaded pages and can upload the results.';
        bridgeRow.append(dot, bridgeText);

        const mokuroAlert = document.createElement('div');
        mokuroAlert.className = 'bwdd-mokuro-alert';
        mokuroAlert.style.display = 'none';
        mokuroAlert.setAttribute('role', 'alert');

        // "?" dot beside the bridge status row: opens an infobox under the row.
        // Popovers open from inside `.bwdd-col-main`, which scrolls and so clips
        // absolutely positioned children (the bridge one is taller than the
        // column), so they are fixed to the viewport instead.
        function placePopover(pop, anchor, align) {
            pop.hidden = false;
            const a = anchor.getBoundingClientRect();
            const w = pop.offsetWidth;
            const h = pop.offsetHeight;
            let left = align === 'right' ? a.right - w : a.left;
            left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
            let top = a.bottom + 4;
            if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 4);
            pop.style.left = Math.round(left) + 'px';
            pop.style.top = Math.round(top) + 'px';
        }

        const infoDot = document.createElement('button');
        infoDot.type = 'button';
        infoDot.className = 'bwdd-info-dot';
        infoDot.setAttribute('aria-label', 'About the Mokuro Bridge and this run\u2019s connection speed');
        infoDot.setAttribute('aria-expanded', 'false');
        infoDot.textContent = '?';
        bridgeRow.insertBefore(infoDot, bridgeText);

        const bridgeInfoPop = document.createElement('div');
        bridgeInfoPop.className = 'bwdd-bridge-pop';
        bridgeInfoPop.hidden = true;
        const infoTitle = document.createElement('span');
        infoTitle.className = 'bwdd-bridge-info-title';
        infoTitle.textContent = 'What is the Mokuro Bridge?';

        const mokuroSection = document.createElement('div');
        mokuroSection.className = 'bwdd-bridge-info-section';
        const mokuroSectionHeading = document.createElement('span');
        mokuroSectionHeading.className = 'bwdd-bridge-info-subhead';
        mokuroSectionHeading.textContent = 'Mokuro engine';
        const infoMokuro = document.createElement('span');
        infoMokuro.className = 'bwdd-bridge-info-mokuro';
        mokuroSection.append(mokuroSectionHeading, infoMokuro);

        const divider1 = document.createElement('hr');
        divider1.className = 'bwdd-bridge-info-divider';

        const aboutSection = document.createElement('div');
        aboutSection.className = 'bwdd-bridge-info-section';
        const aboutSectionHeading = document.createElement('span');
        aboutSectionHeading.className = 'bwdd-bridge-info-subhead';
        aboutSectionHeading.textContent = 'What it does';
        const infoBody = document.createElement('span');
        infoBody.className = 'bwdd-bridge-info-body';
        infoBody.textContent = 'A small companion app that runs locally on your computer. ' +
            'Choosing “Save and run through Mokuro” sends the downloaded pages to it, where ' +
            'mokuro runs Japanese OCR on them; the finished volume is then saved or ' +
            'uploaded wherever you pick. Plain “Save as ZIP” downloads don\'t use it.';
        aboutSection.append(aboutSectionHeading, infoBody);

        const divider2 = document.createElement('hr');
        divider2.className = 'bwdd-bridge-info-divider';

        const divider3 = document.createElement('hr');
        divider3.className = 'bwdd-bridge-info-divider';

        // renderCapabilities() on every bridge poll, so it is accurate whether or
        // not the bridge is running.
        const connSection = document.createElement('div');
        connSection.className = 'bwdd-bridge-info-section';
        const connHeading = document.createElement('span');
        connHeading.className = 'bwdd-bridge-info-subhead';
        connHeading.textContent = 'Connection speed';
        const connNumbers = document.createElement('span');
        connNumbers.className = 'bwdd-caps-line';
        const connBody = document.createElement('span');
        connBody.className = 'bwdd-bridge-info-body';
        connSection.append(connHeading, connNumbers, connBody);

        const infoLink = document.createElement('a');
        infoLink.className = 'bwdd-bridge-info-link';
        infoLink.href = 'https://github.com/GolyBidoof/mokuro-bridge';
        infoLink.target = '_blank';
        infoLink.rel = 'noopener noreferrer';
        infoLink.textContent = 'Download mokuro-bridge ↗';
        bridgeInfoPop.append(infoTitle, mokuroSection, divider1, aboutSection, divider2,
            connSection, divider3, infoLink);
        infoDot.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = bridgeInfoPop.hidden;
            if (open) placePopover(bridgeInfoPop, bridgeRow, 'left');
            else bridgeInfoPop.hidden = true;
            infoDot.setAttribute('aria-expanded', String(open));
        });

        // Anchor for the bridge status row and its "?" infobox, so the infobox
        // overlays just below the row instead of pushing content down.
        const bridgeAnchor = document.createElement('div');
        bridgeAnchor.className = 'bwdd-bridge-anchor';
        bridgeAnchor.append(bridgeRow, bridgeInfoPop);

        function busyReason(info) {
            if (!info) return '';
            const stage = info.busy_stage;
            if (info.busy) {
                if (stage === 'uploading') return 'Uploading…';
                if (stage === 'ocr') return info.busy_detail || 'OCR running…';
                return info.busy_detail || 'Busy…';
            }
            return '';
        }
        async function updateBridgeDot() {
            if (!root.isConnected) return;
            const ok = await bridgeHealth();
            let mokuroMissing = false;
            let mokuroDetailText = '';
            let bridgeBusy = false;
            let bridgeBusyStage = '';
            let bridgeBusyDetail = '';
            // The bridge answers /health even when mokuro isn't installed
            // (mokuro_installed:false), so that is "online but unusable for OCR",
            // not offline.
            if (ok && bridgeReachableNow) {
                const info = await refreshBridgeInfo().catch(() => null);
                const hasBridgePorts = !!(info && Array.isArray(info.fetchProxyPorts) && info.fetchProxyPorts.length);
                if (!hasBridgePorts) clearProxySource('bridge');
                // Take the proxy ports from this same /health payload: re-probing
                // separately fired two extra requests at a closed port every 10 s,
                // and the browser logs each refused connection to the console.
                try {
                    if (info && (Array.isArray(info.fetchUpstreams) || info.upstream)) {
                        setProxyUpstreams(info.fetchUpstreams, info.upstream);
                    }
                    addProxyPorts(info && info.fetchProxyPorts, 'bridge');
                } catch (e) {}
                mokuroMissing = !!(info && info.mokuro_installed === false);
                bridgeBusy = !!(info && info.busy);
                bridgeBusyStage = (info && info.busy_stage) || '';
                bridgeBusyDetail = (info && info.busy_detail) || '';
                if (info && info.mokuro_installed === true) {
                    mokuroDetailText = info.mokuro_version
                        ? 'Mokuro v' + info.mokuro_version + (info.mokuro_custom_fork ? ' (custom fork)' : '') + ' is installed on this machine.'
                        : 'Mokuro is installed on this machine.';
                    infoMokuro.classList.remove('missing');
                } else if (mokuroMissing) {
                    mokuroDetailText = 'Mokuro is not installed on this machine — OCR cannot run.';
                    infoMokuro.classList.add('missing');
                } else {
                    mokuroDetailText = '';
                    infoMokuro.classList.remove('missing');
                }
            } else {
                clearProxySource('bridge');
                mokuroDetailText = 'Bridge not reachable — start it to check the installed mokuro.';
                infoMokuro.classList.remove('missing');
            }
            infoMokuro.textContent = mokuroDetailText;
            bridgeOnline = ok && !mokuroMissing;
            if (ok && mokuroMissing) {
                dot.className = 'bwdd-indicator-dot offline';
                mokuroAlert.style.display = 'block';
                mokuroAlert.textContent = 'Mokuro is not installed on this machine. ' +
                    'OCR cannot run until you install it — e.g. run “pip install mokuro” (or point ' +
                    'the bridge at your mokuro checkout) in the mokuro-bridge folder, then restart the bridge.';
            } else if (ok && bridgeBusy) {
                dot.className = 'bwdd-indicator-dot busy';
                mokuroAlert.style.display = 'none';
            } else {
                dot.className = ok ? 'bwdd-indicator-dot online' : 'bwdd-indicator-dot';
                mokuroAlert.style.display = 'none';
            }
            if (ok && bridgeReachableNow && !mokuroMissing) {
                destWrap.style.display = 'flex';
                // Refresh the destination list only while idle: mid-run the
                // dropdown must keep exactly the pick the run started with
                // (the run reads it again at finalize time).
                if (!runBusy) { try { populateDestMethods(); } catch (e) {} }
                if (bridgeBusy) {
                    // Say what the bridge is doing rather than re-asserting
                    // "online": the dot is already amber.
                    bridgeText.textContent = 'Mokuro Bridge busy — ' + (busyReason({ busy: true, busy_stage: bridgeBusyStage, busy_detail: bridgeBusyDetail }) || 'working');
                    bridgeRow.title = 'mokuro-bridge: ' + (bridgeBusyDetail ? bridgeBusyDetail + ' · ' : '') + 'github.com/GolyBidoof/mokuro-bridge';
                } else {
                    // Idle: describe the destination from the panel's own pick, so
                    // the status line cannot contradict what finalize will use.
                    try {
                        const hasOptions = !!(destSelect.options && destSelect.options.length);
                        const method = hasOptions ? (destSelect.value || 'local') : 'local';
                        let desc, folder = null;
                        if (method === 'local') {
                            folder = localDirInput.value.trim() || (bridgeInfo && bridgeInfo.output_dir) || null;
                            desc = 'saving locally';
                        } else {
                            const opt = destSelect.selectedOptions && destSelect.selectedOptions[0];
                            const text = opt ? String(opt.textContent) : '';
                            const name = opt ? text.split(' — ')[0].trim() : method;
                            const m = text.match(/—\s*(.+)$/);
                            folder = m ? m[1].trim() : null;
                            desc = 'uploading via ' + (name || method);
                        }
                        bridgeText.textContent = 'Mokuro Bridge + Mokuro online — ' + desc;
                        bridgeRow.title = 'mokuro-bridge: ' + (folder ? 'writes to ' + folder + ' · ' : '') + 'github.com/GolyBidoof/mokuro-bridge';
                    } catch (e) {
                        bridgeText.textContent = 'Mokuro Bridge + Mokuro online';
                    }
                }
            } else {
                destWrap.style.display = 'none';
                bridgeText.textContent = ok
                    ? 'Mokuro Bridge is online but mokuro is missing — install it to enable OCR'
                    : 'Mokuro Bridge is not found on port 62642 — start it to enable OCR';
            }
            // OCR button + destination pickers derive from the run lock, so this
            // periodic tick can never re-enable them mid-run.
            setRunLock(runBusy);
            // Poll fast (1 s) while the bridge is busy - ours or background work
            // it reports via /health - so the UI notices the moment it goes idle;
            // otherwise settle to 10 s.
            bridgePollFast = !!(bridgeBusy || runBusy);
            laneBridgeOnline = bridgeReachableNow;
            renderCapabilities();
            scheduleBridgePoll();
        }

        let bridgeTimer = null;
        let bridgePollFast = false;
        function scheduleBridgePoll() {
            if (bridgeTimer) { clearTimeout(bridgeTimer); bridgeTimer = null; }
            bridgeTimer = setTimeout(updateBridgeDot, bridgePollFast ? 1000 : 10000);
        }
        updateBridgeDot();

        const statsEl = document.createElement('div');
        statsEl.className = 'bwdd-cards';

        // Run status area: live region so screen readers announce new
        // outcome/warning messages the moment they land here.
        const details = document.createElement('div');
        details.className = 'bwdd-hint-box';
        details.setAttribute('aria-live', 'polite');

        function mkBar(label, gradient, a11yLabel) {
            const row = document.createElement('div');
            row.className = 'bwdd-bar-row';
            const meta = document.createElement('div');
            meta.className = 'bwdd-bar-meta';
            const name = document.createElement('span');
            name.textContent = label;
            const rate = document.createElement('span');
            rate.className = 'bwdd-bar-rate';
            rate.textContent = '—';
            meta.append(name, rate);

            const track = document.createElement('div');
            track.className = 'bwdd-bar-track';
            // faint background segment (used by the Mokuro bar to show "received
            // but not yet OCR'd"); stays 0-width for the other bars
            const fillBg = document.createElement('div');
            fillBg.className = 'bwdd-bar-fill-bg';
            fillBg.style.width = '0%';
            track.appendChild(fillBg);
            const fill = document.createElement('div');
            fill.className = 'bwdd-bar-fill';
            fill.style.background = gradient;
            fill.setAttribute('role', 'progressbar');
            fill.setAttribute('aria-label', a11yLabel);
            fill.setAttribute('aria-valuemin', '0');
            fill.setAttribute('aria-valuemax', '100');
            fill.setAttribute('aria-valuenow', '0');
            track.appendChild(fill);

            row.append(meta, track);
            return { wrap: row, fill, fillBg, labRate: rate, labName: name };
        }

        const barDownload = mkBar('1. Network Fetch', 'linear-gradient(90deg, #10b981, #059669)', 'Download Progress');
        const barDescramble = mkBar('2. Tile Descramble', 'linear-gradient(90deg, #3b82f6, #1d4ed8)', 'Descramble Progress');
        const barMokuro = mkBar('3. Mokuro Bridge', 'linear-gradient(90deg, #f59e0b, #d97706)', 'OCR Pipeline Progress');
        const barUpload = mkBar('4. Upload', 'linear-gradient(90deg, #8b5cf6, #6d28d9)', 'Upload Progress');
        barDownload.wrap.title = 'Pages fetched from ' + siteLabel() + '\u2019s CDN';
        barDescramble.wrap.title = 'Pages reassembled from their scrambled tiles';
        barMokuro.wrap.title = 'Pages OCR\u2019d / pages received by the bridge / total pages \u2014 faint amber = received but not yet OCR\u2019d';
        barUpload.wrap.title = 'Finished volume being stored or uploaded by the mokuro-bridge';

        const barWrap = document.createElement('div');
        barWrap.className = 'bwdd-bars';
        barWrap.setAttribute('role', 'region');
        barWrap.setAttribute('aria-label', 'Task Progress');
        barWrap.append(barDownload.wrap, barDescramble.wrap, barMokuro.wrap, barUpload.wrap);

        const btnRow = document.createElement('div');
        btnRow.className = 'bwdd-actions';

        const btnZip = document.createElement('button');
        btnZip.type = 'button';
        btnZip.className = 'bwdd-btn zip';
        btnZip.innerHTML = '<span>Save as ZIP</span><span class="bwdd-btn-sub">Pages bundled, ready to read offline</span>';

        const btnOcr = document.createElement('button');
        btnOcr.type = 'button';
        btnOcr.className = 'bwdd-btn ocr';
        btnOcr.innerHTML = '<span>Save and run through Mokuro</span><span class="bwdd-btn-sub">Run pages through the local Mokuro Bridge, then optionally upload</span>';
        const btnOcrTip = 'Mokuro = Japanese OCR (mokuro). Runs through the local mokuro-bridge app — see https://github.com/GolyBidoof/mokuro-bridge';
        btnOcr.title = btnOcrTip;

        btnRow.append(btnZip, btnOcr);

        const nameWrap = document.createElement('div');
        nameWrap.className = 'bwdd-name';
        const nameLabel = document.createElement('label');
        nameLabel.className = 'bwdd-dest-label';
        nameLabel.textContent = 'Archive name';
        nameLabel.setAttribute('for', 'bwdd-archive-name');
        const nameInput = document.createElement('input');
        nameInput.id = 'bwdd-archive-name';
        nameInput.type = 'text';
        nameInput.className = 'bwdd-dest-input';
        nameInput.autocomplete = 'off';
        nameInput.spellcheck = false;
        nameInput.placeholder = 'Auto-filled from this book';
        nameInput.setAttribute('aria-label', 'Archive name - the name of the generated download (leave empty to use this book\u2019s series + volume)');
        const nameInfoDot = document.createElement('button');
        nameInfoDot.type = 'button';
        nameInfoDot.className = 'bwdd-info-dot';
        nameInfoDot.setAttribute('aria-label', 'About the archive name field');
        nameInfoDot.setAttribute('aria-expanded', 'false');
        nameInfoDot.setAttribute('aria-controls', 'bwdd-archive-name-pop');
        nameInfoDot.title = 'What this field does';
        nameInfoDot.textContent = '?';
        // The popover overlays the buttons below rather than taking layout space.
        const namePop = document.createElement('div');
        namePop.className = 'bwdd-name-pop';
        namePop.id = 'bwdd-archive-name-pop';
        namePop.hidden = true;
        namePop.setAttribute('role', 'note');
        const namePopP1 = document.createElement('div');
        namePopP1.textContent = 'Name of the generated archive: the .zip \u201cSave as ZIP\u201d downloads, or the volume the Mokuro bridge stores/uploads when OCR runs.';
        const namePopP2 = document.createElement('div');
        namePopP2.textContent = 'Empty = this book\u2019s series + volume, exactly as the store writes it (e.g. \u2026 1\u5dfb, \uff08\uff11\uff09, \u2026 1).';
        const namePopP3 = document.createElement('div');
        namePopP3.textContent = 'ZIP pages sit flat inside the archive; OCR uploads still land under the series folder. Invalid file-name characters are stripped.';
        namePop.append(namePopP1, namePopP2, namePopP3);
        nameWrap.append(nameLabel, nameInput, nameInfoDot, namePop);
        function setArchivePop(open) {
            if (open) placePopover(namePop, nameWrap, 'right');
            else namePop.hidden = true;
            nameInfoDot.setAttribute('aria-expanded', String(open));
        }
        nameInfoDot.addEventListener('click', (e) => {
            e.stopPropagation();
            setArchivePop(namePop.hidden);
        });
        // Hoisted declaration so the panel's close button can detach it.
        function onNameDocClick(e) {
            if (!namePop.hidden && !nameWrap.contains(e.target)) setArchivePop(false);
        }
        document.addEventListener('click', onNameDocClick);

        // The default the field was last auto-filled with (null = never, or the
        // user has typed their own name since), so syncArchiveDefault can tell
        // "still showing the auto default" from "user's own text".
        let archiveAutoDefault = null;
        // Keep the field's default in sync with the book shown in the reader and
        // return the effective archive name for the current run (never empty):
        //   • Empty field → fill with this book's default.
        //   • Field still holding the previous auto default → swap in the new one.
        //   • Anything the user typed → never touched.
        // Self-corrects while the title arrives in stages (document.title first,
        // then the richer state.cti).
        function syncArchiveDefault(rawTitle) {
            const dflt = archiveDefaultName(rawTitle);
            const cur = nameInput.value;
            if (!cur.trim()) {
                if (dflt) { nameInput.value = dflt; archiveAutoDefault = dflt; }
                else { archiveAutoDefault = null; }
            } else if (archiveAutoDefault !== null && cur === archiveAutoDefault && dflt && dflt !== archiveAutoDefault) {
                nameInput.value = dflt;
                archiveAutoDefault = dflt;
            } else {
                archiveAutoDefault = (dflt && cur === dflt) ? dflt : null;
            }
            const safe = fsSafePath(nameInput.value.trim());
            if (safe) return safe;
            return dflt || fsSafePath(siteCid() || '') || 'book';
        }

        const destWrap = document.createElement('div');
        destWrap.className = 'bwdd-dest';
        destWrap.style.display = 'none';
        const destLabel = document.createElement('label');
        destLabel.className = 'bwdd-dest-label';
        destLabel.textContent = 'Mokuro output destination';
        destLabel.setAttribute('for', 'bwdd-upload-method');
        const destSelect = document.createElement('select');
        destSelect.id = 'bwdd-upload-method';
        destSelect.className = 'bwdd-dest-select';
        destSelect.setAttribute('aria-label', 'Mokuro upload method');
        const localDirRow = document.createElement('div');
        localDirRow.className = 'bwdd-dest-localdir';
        localDirRow.style.display = 'none';
        const localDirLabel = document.createElement('label');
        localDirLabel.className = 'bwdd-dest-label';
        localDirLabel.textContent = 'Output folder (on this computer)';
        localDirLabel.setAttribute('for', 'bwdd-local-dir');
        const localDirInput = document.createElement('input');
        localDirInput.id = 'bwdd-local-dir';
        localDirInput.type = 'text';
        localDirInput.className = 'bwdd-dest-input';
        localDirInput.placeholder = 'absolute path on this computer — e.g. C:\\Users\\you\\manga or /home/you/manga';
        localDirInput.title = 'Where mokuro-bridge should write the finished volume. This is a path on the machine running the bridge (your computer).';
        // A web page cannot read your filesystem path via a folder picker
        // (showDirectoryPicker yields an opaque handle), so we fill the path from
        // the bridge's own configured output_dir and let you edit it freely.
        const localDirFill = document.createElement('button');
        localDirFill.type = 'button';
        localDirFill.className = 'bwdd-btn-fill';
        localDirFill.textContent = 'Use bridge default';
        localDirFill.addEventListener('click', async () => {
            const info = bridgeInfo || await refreshBridgeInfo();
            if (info && info.output_dir) localDirInput.value = info.output_dir;
        });
        const localDirWrap = document.createElement('div');
        localDirWrap.style.cssText = 'display:flex;gap:6px;align-items:center;';
        localDirWrap.append(localDirInput, localDirFill);
        localDirRow.append(localDirLabel, localDirWrap);
        const destHint = document.createElement('div');
        destHint.className = 'bwdd-dest-hint';
        destHint.style.display = 'none';
        destWrap.append(destLabel, destSelect, localDirRow, destHint);

        // Which method the user actually picked, kept separate from
        // destSelect.value because populateDestMethods() rebuilds the dropdown on
        // every 10s bridge-health tick: a refresh that cannot represent the
        // current pick must not forget it and fall back to the default forever.
        let userMethod = null;
        // A value is "usable" only when it maps to a configured, enabled option
        //, an unconfigured provider is selectable (to read its setup hint) but
        // must never be restored/seeded as the effective destination.
        const hasUsableOption = (v) => v != null && [...destSelect.options]
            .some(o => o.value === v && !o.disabled && !(o.dataset && o.dataset.unconfigured));

        async function populateDestMethods() {
            const methods = await fetchUploadMethods().catch(() => null);
            // A run may have started while this fetch was in flight: never
            // repopulate (and thereby change) the pick it will finalize with.
            if (runBusy) return;
            const prevValue = destSelect.value;
            destSelect.textContent = '';
            let def = 'local';
            if (methods && Array.isArray(methods.methods) && methods.methods.length) {
                def = methods.upload_method_default || 'local';
                for (const m of methods.methods) {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    if (m.id === 'local') {
                        opt.textContent = 'Local folder' + (m.current_folder ? ' — ' + m.current_folder : '');
                    } else if (m.configured) {
                        opt.textContent = m.name + (m.current_folder ? ' — ' + m.current_folder : '');
                    } else {
                        // Unconfigured methods stay selectable so the user can read
                        // about them: choosing one shows the setup hint below and
                        // disables OCR until the provider is set up.
                        opt.textContent = m.name + ' — needs setup';
                        opt.dataset.unconfigured = '1';
                        opt.title = 'Not set up yet — enable it once in the mokuro-bridge terminal (from its folder): python server.py --setup-upload ' + (m.id || '');
                    }
                    destSelect.appendChild(opt);
                }
            } else {
                for (const [id, name] of [['local', 'Local (default output)'], ['mega', 'MEGA']]) {
                    const opt = document.createElement('option');
                    opt.value = id; opt.textContent = name;
                    destSelect.appendChild(opt);
                }
            }
            // Seed the remembered method from localStorage on the first
            // population; later rebuilds preserve the visible pick instead.
            if (!userMethod && !prevValue) {
                try {
                    const saved = localStorage.getItem('bwdd-upload-method');
                    if (saved && hasUsableOption(saved)) userMethod = saved;
                } catch (e) {}
            }
            // Pick the value to show after the rebuild:
            //   1. the current selection, if it still exists (a "needs setup" pick
            //      must survive a tick so its hint keeps showing),
            //   2. else the remembered usable method (seeded from localStorage),
            //   3. else the bridge's usable default, else 'local'.
            let picked = null;
            if (prevValue) {
                const stillThere = [...destSelect.options].some(o => o.value === prevValue);
                if (stillThere) picked = prevValue;
            }
            if (picked == null && userMethod && hasUsableOption(userMethod)) picked = userMethod;
            if (picked == null && hasUsableOption(def)) picked = def;
            if (picked == null) picked = 'local';
            destSelect.value = picked;
            onDestChange();
        }

        function rememberMethod(v) {
            userMethod = v;
            try { localStorage.setItem('bwdd-upload-method', v); } catch (e) {}
        }

        function onDestChange() {
            const v = destSelect.value || 'local';
            const showLocal = v === 'local';
            localDirRow.style.display = showLocal ? 'flex' : 'none';
            if (showLocal) {
                if (!localDirInput.value) {
                    const planDefault = bridgeInfo && bridgeInfo.output_dir || '';
                    if (planDefault) localDirInput.placeholder = 'default: ' + planDefault;
                }
            }
            updateDestHint();
            refreshOcrButton();
        }
        function selectedNeedsSetup() {
            const o = destSelect.selectedOptions && destSelect.selectedOptions[0];
            return !!(o && o.dataset && o.dataset.unconfigured);
        }
        // OCR button availability = not busy ∧ bridge online ∧ destination is
        // actually usable. While a not-yet-configured destination is selected
        // the button is disabled so a run can't start toward a dead end.
        function refreshOcrButton() {
            const blockedBySetup = selectedNeedsSetup();
            btnOcr.disabled = runBusy || !bridgeOnline || blockedBySetup;
            btnOcr.setAttribute('aria-disabled', String(btnOcr.disabled));
            btnOcr.title = blockedBySetup
                ? 'This destination is not set up yet — run the command below once, then it will be usable here.'
                : ((runBusy || bridgeOnline) ? btnOcrTip : 'Start the Mokuro Bridge to enable OCR');
        }
        function updateDestHint() {
            const selOpt = destSelect.selectedOptions && destSelect.selectedOptions[0];
            if (!selOpt || !selOpt.dataset || !selOpt.dataset.unconfigured) {
                destHint.style.display = 'none';
                return;
            }
            destHint.style.display = 'block';
            destHint.textContent = '';
            destHint.appendChild(document.createTextNode('This destination needs one-time setup in the bridge terminal: '));
            const code = document.createElement('code');
            code.textContent = 'python server.py --setup-upload ' + (selOpt.value || '');
            destHint.appendChild(code);
            destHint.appendChild(document.createTextNode('  (from the mokuro-bridge folder)'));
        }
        destSelect.addEventListener('change', () => { rememberMethod(destSelect.value); onDestChange(); });
        localDirInput.addEventListener('change', () => { try { localStorage.setItem('bwdd-local-dir', localDirInput.value); } catch (e) {} });
        try { const saved = localStorage.getItem('bwdd-local-dir'); if (saved) localDirInput.value = saved; } catch (e) {}
        populateDestMethods();
        // While a run is in progress the action buttons and the destination
        // section are disabled: no second download, and no changing the
        // destination an OCR run re-reads at finalize time.
        let bridgeOnline = false;
        let runBusy = false;

        // The run lives in this tab: every page already fetched and descrambled
        // is in memory here, and the finalize stream is a request this page is
        // reading. Closing the tab loses all of it, so hold the browser's own
        // "leave site?" prompt for exactly as long as a run is in progress - a
        // stale handler would nag on every later navigation instead.
        let unloadGuardArmed = false;
        function onBeforeUnload(e) {
            e.preventDefault();
            // Legacy Chromium reads returnValue; current Chrome shows its own text.
            e.returnValue = '';
            return '';
        }
        function setUnloadGuard(active) {
            if (active === unloadGuardArmed) return;
            unloadGuardArmed = active;
            try {
                if (active) window.addEventListener('beforeunload', onBeforeUnload);
                else window.removeEventListener('beforeunload', onBeforeUnload);
            } catch (e) {}
        }
        function setRunLock(busy) {
            runBusy = busy;
            setUnloadGuard(busy);
            btnZip.disabled = busy;
            btnZip.setAttribute('aria-disabled', String(busy));
            refreshOcrButton();
            const destLocked = busy || !bridgeOnline;
            destSelect.disabled = destLocked;
            localDirInput.disabled = destLocked;
            localDirFill.disabled = destLocked;
            nameInput.disabled = busy;
            destWrap.classList.toggle('bwdd-dest-locked', busy);
            if (busy) {
                destWrap.setAttribute('aria-busy', 'true');
                destWrap.title = 'Locked while a download or OCR run is in progress';
            } else {
                destWrap.removeAttribute('aria-busy');
                destWrap.title = '';
            }
            // Closing or flapping the panel mid-run would orphan the pipeline
            // (auth timers, OCR polls, the finalize stream) that keeps posting
            // into a detached DOM, hold both header buttons until it finishes.
            closeBtn.disabled = busy;
            flapBtn.disabled = busy;
            if (busy) {
                closeBtn.title = 'Closes after the run finishes';
                flapBtn.title = 'Available after the run finishes';
            } else {
                closeBtn.title = 'Close panel';
                flapBtn.title = 'Slide the panel away to the right edge of the screen';
            }
        }

        const postRunRow = document.createElement('div');
        postRunRow.className = 'bwdd-reader-row';
        postRunRow.style.display = 'none';
        const btnReader = document.createElement('button');
        btnReader.type = 'button';
        btnReader.className = 'bwdd-ghost-btn';
        btnReader.textContent = 'Open Reader Mokuro';
        btnReader.setAttribute('aria-label', 'Open Reader Mokuro in a new tab');
        const btnStored = document.createElement('button');
        btnStored.type = 'button';
        btnStored.className = 'bwdd-ghost-btn';
        btnStored.setAttribute('aria-label', 'Open stored file');
        postRunRow.append(btnReader, btnStored);
        let readerReady = false;
        let storedReady = false;
        function syncPostRunRow() {
            btnReader.style.display = readerReady ? '' : 'none';
            btnStored.style.display = storedReady ? '' : 'none';
            postRunRow.style.display = (readerReady || storedReady) ? 'grid' : 'none';
        }
        function showReaderButton(result) {
            btnReader.onclick = () => {
                const a = document.createElement('a');
                a.href = readerJumpUrl(result);
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                a.remove();
            };
            readerReady = true;
            syncPostRunRow();
        }
        function hideReaderButton() {
            btnReader.onclick = null;
            readerReady = false;
            syncPostRunRow();
        }
        function showStoredButton(result) {
            const target = storedOpenTarget(result);
            if (target) {
                const isCbz = /\.cbz$/i.test(target.file || '');
                btnStored.textContent = isCbz ? 'Open stored file (.cbz)' : 'Open stored file';
                btnStored.setAttribute('aria-label', isCbz
                    ? 'Open the stored .cbz file in a new tab'
                    : 'Open the stored file in a new tab');
                btnStored.title = target.url;
                btnStored.onclick = () => {
                    const a = document.createElement('a');
                    a.href = target.url;
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    a.style.display = 'none';
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                };
            } else {
                const method = result && result.method;
                const isLocal = !method || method === 'local';
                const copyText = isLocal
                    ? (result && (result.output_dir || result.staging))
                    : (result && (result.remote_path || result.mega_path || result.staging));
                const mainLabel = isLocal ? 'Copy local folder path' : 'Copy destination path';
                const a11yLabel = mainLabel + ' to the clipboard';
                btnStored.textContent = mainLabel;
                btnStored.setAttribute('aria-label', a11yLabel);
                btnStored.title = copyText || '';
                btnStored.onclick = () => {
                    const text = copyText || 'about:blank';
                    try { navigator.clipboard.writeText(text); } catch (e) {}
                    btnStored.textContent = 'Path copied ✓';
                    btnStored.setAttribute('aria-label', 'Path copied to the clipboard');
                    setTimeout(() => {
                        btnStored.textContent = mainLabel;
                        btnStored.setAttribute('aria-label', a11yLabel);
                    }, 1500);
                };
            }
            storedReady = true;
            syncPostRunRow();
        }
        function hideStoredButton() {
            btnStored.onclick = null;
            storedReady = false;
            syncPostRunRow();
        }

        // These numbers live in the bridge row's "?" popover, not the panel body:
        // they matter before a run, but not often enough to earn permanent space.
        function renderCapabilities() {
            const c = capabilitySummary();
            connSection.classList.toggle('on', c.bridgeOnline);
            connSection.classList.toggle('off', !c.bridgeOnline);
            // "no bridge", not "page only": the count can still include the GM and
            // trailing-dot lanes, so naming just the page lane would be wrong.
            const speed = c.bridgeOnline ? c.ports + ' ports'
                : (c.ports ? 'bridge offline' : 'no bridge');
            connNumbers.textContent = speed + ' · ' + c.effectiveSockets +
                ' sockets · ' + c.workers + ' workers';

            let explain;
            if (c.bridgeOnline) {
                explain = 'mokuro-bridge is serving ' + c.ports + ' extra local ports. The browser ' +
                    'allows 6 connections per origin, and every port counts as its own origin, so ' +
                    'this run has up to ' + c.sockets + ' network sockets instead of ' +
                    c.withoutBridge + '. Up to ' + c.decodePages + ' pages decode concurrently; ' +
                    'the fetch window is bounded separately to avoid retaining the whole volume.';
                // The per-origin sum can exceed what one browser profile may
                // open; say so rather than promising sockets that cannot exist.
                if (c.socketsClamped) {
                    explain += ' Those ports would add up to ' + c.rawSockets + ', but the browser ' +
                        'caps a profile at ' + CHROMIUM_SOCKETS_PER_PROCESS + ' sockets in total, so ' +
                        'the run uses ' + c.sockets + ' and keeps ' + CONTROL_PLANE_SOCKET_RESERVE +
                        ' in reserve for the manifest, policy refresh and bridge checks.';
                }
            } else if (c.ports) {
                explain = 'mokuro-bridge answered earlier (' + c.ports + ' ports) but is not ' +
                    'reachable now, so this run would use ' + c.effectiveSockets + ' connections. ' +
                    'Restart it to get the extra ports back.';
            } else {
                // Quote the real count, not "6": the GM and trailing-dot lanes
                // already add more than the page's own 6.
                explain = 'mokuro-bridge is not running, so this run uses ' + c.effectiveSockets +
                    ' browser connections. Starting it adds its advertised local ports, ' +
                    'worth up to six connections each. Downloads work the same either way.';
            }
            connBody.textContent = explain + ' ' + c.workers + ' Web Workers unscramble ' +
                workerBatchSize(IMAGE_CODEC.type) + ' page each concurrently as they arrive; that number follows your CPU, not the bridge.';
        }

        const fmtDetails = document.createElement('details');
        fmtDetails.className = 'bwdd-fmt';
        const fmtSummary = document.createElement('summary');
        fmtSummary.className = 'bwdd-fmt-summary';
        const fmtBody = document.createElement('div');
        fmtBody.className = 'bwdd-dest';

        function labelledSelect(labelText, id, options, ariaLabel) {
            const row = document.createElement('div');
            row.className = 'bwdd-opt-row';
            const lab = document.createElement('label');
            lab.className = 'bwdd-dest-label';
            lab.textContent = labelText;
            lab.setAttribute('for', id);
            const sel = document.createElement('select');
            sel.id = id;
            sel.className = 'bwdd-dest-select';
            sel.setAttribute('aria-label', ariaLabel || labelText);
            for (const [v, text] of options) {
                const o = document.createElement('option');
                o.value = v;
                o.textContent = text;
                sel.appendChild(o);
            }
            row.append(lab, sel);
            return { row, sel };
        }

        const FORMAT_LABELS = {
            jpeg: 'JPEG', webp: 'WebP', lossless: 'Lossless', png: 'PNG',
        };
        const fmtCtl = labelledSelect('Format', 'bwdd-image-format', [
            ['jpeg', 'JPEG (smallest)'],
            ['webp', 'WebP (smaller, slower)'],
            ['lossless', 'Lossless (perfect copy)'],
            ['png', 'PNG (largest)'],
        ], 'Page image format');
        const qCtl = labelledSelect('Quality', 'bwdd-image-quality', [
            ['0.95', 'Highest'], ['0.92', 'High (default)'],
            ['0.85', 'Balanced'], ['0.75', 'Small'],
        ], 'Page image quality');
        const fmtNote = document.createElement('div');
        fmtNote.className = 'bwdd-caps-note';

        function onFormatChange(save) {
            if (save !== false) {
                try {
                    localStorage.setItem('bwddImageFormat', fmtCtl.sel.value);
                    localStorage.setItem('bwddImageQuality', qCtl.sel.value);
                } catch (e) {}
            }
            const c = refreshImageCodec();
            // Quality does nothing for the lossless settings, so hide it rather
            // than offer a control with no effect.
            qCtl.row.style.display = c.lossless ? 'none' : 'flex';
            fmtSummary.textContent = 'Image format · ' + FORMAT_LABELS[c.fmt] +
                (c.lossless ? '' : ' q' + c.quality);
            fmtNote.textContent = c.lossless
                ? 'Lossless keeps every pixel the CDN sent. Often smaller than JPEG on line art, much larger on photo pages.'
                : 'Pages are re-encoded from the CDN\u2019s own JPEG, so this is a second generation.';
            renderCapabilities();
        }

        {
            const wantedFmt = IMAGE_CODEC.fmt;
            if (![...fmtCtl.sel.options].some(o => o.value === wantedFmt)) {
                const o = document.createElement('option');
                o.value = wantedFmt;
                o.textContent = wantedFmt;
                fmtCtl.sel.appendChild(o);
            }
            fmtCtl.sel.value = wantedFmt;
            const wantedQ = String(IMAGE_CODEC.quality);
            if (![...qCtl.sel.options].some(o => o.value === wantedQ)) {
                const o = document.createElement('option');
                o.value = wantedQ;
                o.textContent = wantedQ;
                qCtl.sel.appendChild(o);
            }
            qCtl.sel.value = wantedQ;
        }
        fmtCtl.sel.addEventListener('change', () => onFormatChange(true));
        qCtl.sel.addEventListener('change', () => onFormatChange(true));
        fmtBody.append(fmtCtl.row, qCtl.row, fmtNote);
        fmtDetails.append(fmtSummary, fmtBody);
        onFormatChange(false);

        const colMain = document.createElement('div');
        colMain.className = 'bwdd-col bwdd-col-main';
        colMain.append(bridgeAnchor, mokuroAlert, destWrap, nameWrap, fmtDetails, btnRow, barWrap, details, postRunRow);

        const colStats = document.createElement('div');
        colStats.className = 'bwdd-col bwdd-col-stats';
        colStats.append(statsEl);

        const colSep = document.createElement('div');
        colSep.className = 'bwdd-col-sep';

        function mountStatsColumn() {
            const manual = parseFloat(root.style.width);
            const manualWide = isFinite(manual) && manual >= 620;
            body.append(colSep, colStats);
            root.classList.add('bwdd-stats-visible');
            // A manual width only sticks once it is wide enough for two columns;
            // otherwise fall back to the auto two-column width.
            if (!manualWide) root.style.width = '';
        }
        let statsMounted = false;
        const statsObs = new MutationObserver(() => {
            if (statsMounted || !statsEl.childElementCount) return;
            statsMounted = true;
            statsObs.disconnect();
            mountStatsColumn();
        });
        statsObs.observe(statsEl, { childList: true });
        if (statsEl.childElementCount) { statsMounted = true; mountStatsColumn(); }

        body.append(colMain);
        root.append(head, body);
        document.documentElement.appendChild(root);
        // updateBridgeDot() ran above, before root was connected, and bailed at
        // the `!root.isConnected` guard, so refresh it now instead of waiting for
        // the first 10 s interval tick.
        try { updateBridgeDot(); } catch (e) {}

        const edgeTab = document.createElement('button');
        edgeTab.type = 'button';
        edgeTab.className = 'bwdd-edge-tab';
        edgeTab.setAttribute('aria-label', 'Show the ' + sitePanelTitle() + ' panel');
        edgeTab.title = 'Show the ' + sitePanelTitle() + ' panel';
        edgeTab.textContent = '\u00AB';
        edgeTab.style.display = 'none';
        document.documentElement.appendChild(edgeTab);

        function flapOut() {
            if (edgeTab.style.display === 'flex') return;
            const r = root.getBoundingClientRect();
            // Push the panel fully past the right edge. Its left/top position is
            // untouched, so clearing the transform returns it exactly where it was.
            const shift = Math.max(24, Math.ceil(window.innerWidth - r.left) + 4);
            root.style.transform = 'translateX(' + shift + 'px)';
            root.classList.add('bwdd-flapped');
            root.setAttribute('aria-hidden', 'true');
            // inert takes every control out of the tab order / a11y tree, so a
            // keyboard user can't Tab into invisible controls (aria-hidden
            // alone does not do that).
            root.inert = true;
            // Anchor the restore tab to the panel's own vertical span, so a
            // bottom-docked panel leaves its tab near the bottom edge.
            const tabH = 76;   // .bwdd-edge-tab height
            const vh = window.innerHeight || document.documentElement.clientHeight || 800;
            const tabTop = Math.max(0, Math.min(r.top + (r.height - tabH) / 2, vh - tabH - 8));
            edgeTab.style.top = tabTop + 'px';
            edgeTab.style.display = 'flex';
            flapBtn.setAttribute('aria-expanded', 'false');
            flapBtn.setAttribute('aria-label', 'Show the panel (from the right edge)');
            try { edgeTab.focus(); } catch (e) {}
        }
        function flapIn() {
            if (edgeTab.style.display !== 'flex') return;
            root.classList.remove('bwdd-flapped');
            root.style.transform = '';
            root.removeAttribute('aria-hidden');
            root.inert = false;
            edgeTab.style.display = 'none';
            flapBtn.setAttribute('aria-expanded', 'true');
            flapBtn.setAttribute('aria-label', 'Hide the panel to the right edge');
            try { flapBtn.focus(); } catch (e) {}
        }
        edgeTab.addEventListener('click', () => flapIn());
        flapBtn.onclick = () => flapOut();

        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'bwdd-resize';
        resizeHandle.setAttribute('aria-hidden', 'true');
        resizeHandle.setAttribute('title', 'Drag to resize the panel');
        root.appendChild(resizeHandle);

        let resizing = false;
        let resizeStartX = 0, resizeStartY = 0;
        let resizeStartW = 0, resizeStartH = 0;
        function resizeMinW() {
            return root.classList.contains('bwdd-stats-visible') ? 620 : 360;
        }
        function resizeMinH() { return 120; }
        function persistPanelSize() {
            try {
                const r = root.getBoundingClientRect();
                localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(r.width)));
                localStorage.setItem(PANEL_HEIGHT_KEY, String(Math.round(r.height)));
            } catch (e) {}
        }
        resizeHandle.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const r = root.getBoundingClientRect();
            // Anchor by the top-left so the bottom-right corner follows the
            // pointer while resizing (works for both docked and dragged states).
            root.style.left = r.left + 'px';
            root.style.top = r.top + 'px';
            root.style.right = 'auto';
            resizing = true;
            resizeStartX = e.clientX; resizeStartY = e.clientY;
            resizeStartW = r.width;   resizeStartH = r.height;
            try { resizeHandle.setPointerCapture(e.pointerId); } catch (err) {}
        });
        resizeHandle.addEventListener('pointermove', (e) => {
            if (!resizing) return;
            const vw = window.innerWidth || 1200;
            const vh = window.innerHeight || 800;
            const left = root.getBoundingClientRect().left;
            const top = root.getBoundingClientRect().top;
            const minW = resizeMinW();
            const maxW = Math.max(minW, Math.min(1200, vw - left - 12));
            const w = Math.max(minW, Math.min(maxW, resizeStartW + (e.clientX - resizeStartX)));
            root.style.width = Math.round(w) + 'px';
            // The panel is top-anchored, so growing downward is what the user
            // expects; clamp to the viewport too.
            const minH = resizeMinH();
            const maxH = Math.max(minH, Math.min(1000, vh - top - 12));
            const h = Math.max(minH, Math.min(maxH, resizeStartH + (e.clientY - resizeStartY)));
            root.style.height = Math.round(h) + 'px';
        });
        resizeHandle.addEventListener('pointerup', () => { resizing = false; persistPanelSize(); });
        resizeHandle.addEventListener('pointercancel', () => { resizing = false; });
        resizeHandle.addEventListener('lostpointercapture', () => { if (resizing) { resizing = false; persistPanelSize(); } });

        try {
            const savedW = parseInt(localStorage.getItem(PANEL_WIDTH_KEY) || '', 10);
            if (isFinite(savedW) && savedW > 0) root.style.width = Math.min(Math.max(savedW, 300), 1200) + 'px';
        } catch (e) {}
        try {
            const savedH = parseInt(localStorage.getItem(PANEL_HEIGHT_KEY) || '', 10);
            if (isFinite(savedH) && savedH > 0) root.style.height = Math.min(Math.max(savedH, 120), 1000) + 'px';
        } catch (e) {}

        try {
            const savedPos = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || 'null');
            if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
                root.style.left = clampPanelX(savedPos.x) + 'px';
                root.style.top = clampPanelY(savedPos.y) + 'px';
                root.style.right = 'auto';
            }
        } catch (e) {}
        try { if (localStorage.getItem(PANEL_COLLAPSED_KEY) === '1') setCollapsed(true); } catch (e) {}

        let dragging = false;
        let dragPointerId = null;
        let pos = { x: 0, y: 0 };
        function clampPanelX(x) { return Math.max(0, Math.min(x, Math.max(0, (window.innerWidth || 1200) - 60))); }
        function clampPanelY(y) { return Math.max(0, Math.min(y, Math.max(0, (window.innerHeight || 800) - 70))); }
        function savePanelPos() {
            try {
                const r = root.getBoundingClientRect();
                localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ x: r.left, y: r.top }));
            } catch (e) {}
        }
        function applyDragPos(clientX, clientY) {
            root.style.left = clampPanelX(clientX - pos.x) + 'px';
            root.style.top = clampPanelY(clientY - pos.y) + 'px';
            root.style.right = 'auto';
        }
        // Pointer events cover mouse, touch and pen (with capture so the drag keeps
        // tracking even when the pointer leaves the header).
        head.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (e.target.closest('button, a')) return;
            dragging = true;
            dragPointerId = e.pointerId;
            pos.x = e.clientX - root.offsetLeft;
            pos.y = e.clientY - root.offsetTop;
            try { head.setPointerCapture(e.pointerId); } catch (err) {}
            e.preventDefault();
        });
        head.addEventListener('pointermove', (e) => {
            if (!dragging || dragPointerId !== e.pointerId) return;
            applyDragPos(e.clientX, e.clientY);
        });
        function stopDrag(e) {
            if (!dragging || (e && dragPointerId != null && e.pointerId !== dragPointerId)) return;
            dragging = false;
            dragPointerId = null;
            savePanelPos();
        }
        head.addEventListener('pointerup', stopDrag);
        head.addEventListener('pointercancel', stopDrag);
        head.addEventListener('lostpointercapture', () => {
            if (dragging) savePanelPos();
            dragging = false;
            dragPointerId = null;
        });
        // The panel deliberately does NOT capture arrow keys: the viewer uses
        // Left/Right to flip pages, so arrow handling must never be eaten or
        // preventDefault'ed while the panel holds focus. Reposition by dragging the
        // header, resize with the corner grip.

        // Keyboard shortcut: Escape toggles collapse. Named so the close button can
        // remove it: a closed panel must not keep a window-level listener alive.
        function onPanelKeydown(e) {
            if (e.key !== 'Escape') return;
            // An open archive-name popover is closed by Esc first, then a second
            // Esc collapses the panel as usual.
            if (!namePop.hidden) { setArchivePop(false); return; }
            // don't hijack Esc while the user is typing in a form control
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
            if (document.contains(root) && !e.defaultPrevented) {
                setCollapsed(!root.classList.contains('collapsed'));
            }
        }
        window.addEventListener('keydown', onPanelKeydown);

        // Exposed last: this names elements (fmtCtl/qCtl) created further down, so
        // publishing it any earlier hits the TDZ and exports nothing.
        if (BWDD_DEBUG) {
            try {
                window.__bwddUI = Object.assign(window.__bwddUI || {}, {
                    populateDestMethods, onDestChange,
                    renderCapabilities, capabilitySummary, workerPoolSize, discoverProxyPorts,
                    fmtSelect: fmtCtl.sel, qSelect: qCtl.sel,
                    setImageFormat(fmt, quality) {
                        if (fmt) fmtCtl.sel.value = fmt;
                        if (quality != null) qCtl.sel.value = String(quality);
                        onFormatChange(true);
                        return IMAGE_CODEC;
                    },
                });
            } catch (e) { try { console.error('[bwdd] UI export failed:', safeLogText(e)); } catch (e2) {} }
        }
        return { root, details, statsEl, barWrap, barDownload, barDescramble, barMokuro, barUpload, btnZip, btnOcr, btnRow, nameWrap, destSelect, localDirInput, destHint, populateDestMethods, setRunLock, showReaderButton, hideReaderButton, showStoredButton, hideStoredButton, syncArchiveDefault };
    }

    // Three-value Mokuro progress: done / received / total.
    // fillBg (faint) = pages received by the bridge; fill (solid) = pages
    // actually OCR'd. No flicker, every update sets all three consistently.
    function updateMokuroBar(bar, done, received, total) {
        if (!bar || !bar.fill) return;
        const t = total || 1;
        const r = Math.max(0, Math.min(received || 0, t));
        const d = Math.max(0, Math.min(done || 0, r));
        if (bar.fillBg) bar.fillBg.style.width = Math.round((r / t) * 100) + '%';
        bar.fill.style.width = Math.round((d / t) * 100) + '%';
        bar.fill.setAttribute('aria-valuenow', String(Math.round((d / t) * 100)));
        bar.fill.setAttribute('aria-valuetext', d + ' of ' + t + ' pages OCR\u2019d, ' + r + ' received by the bridge');
        bar.labRate.textContent = d + '/' + r + '/' + t;
    }

    function setBar(bar, pct, text) {
        if (!bar) return;
        const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
        bar.fill.style.width = p + '%';
        bar.fill.setAttribute('aria-valuenow', String(p));
        bar.fill.setAttribute('aria-valuetext', `${p}% complete`);
        if (text != null) bar.labRate.textContent = text;
    }
    // Build (but don't insert) the collapsible raw-error block; returns null
    // when there is nothing to show. Both setRunDetails and the success paths
    // use it so recovered/retried errors surface without dominating the copy.
    function makeTechDetails(rawLines, label) {
        const lines = (rawLines || []).filter(Boolean);
        const capped = lines.slice(0, 15);
        const overflow = lines.length - capped.length;
        if (!capped.length) return null;
        const det = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = (label || 'Technical details') + ' (' + capped.length + (overflow ? '+' : '') + ')';
        const pre = document.createElement('pre');
        pre.textContent = capped.join('\n') + (overflow > 0 ? '\n\u2026 and ' + overflow + ' more' : '');
        det.append(sum, pre);
        return det;
    }
    function setRunDetails(el, summary, rawLines) {
        if (!el) return;
        el.textContent = '';
        el.appendChild(document.createTextNode(summary));
        const det = makeTechDetails(rawLines);
        if (det) el.appendChild(det);
    }
    function appendRunDetails(el, rawLines, label) {
        if (!el) return;
        const det = makeTechDetails(rawLines, label);
        if (det) el.appendChild(det);
    }
    function showBars(ui) {
        ui.barWrap.style.display = 'flex';
        ui.barDownload.wrap.style.display = 'flex';
        ui.barDescramble.wrap.style.display = 'flex';
        setBar(ui.barDownload, 0, '0%');
        setBar(ui.barDescramble, 0, '0%');
    }

