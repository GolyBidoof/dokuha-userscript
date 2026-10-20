    // Real detection of the current color scheme, not a styling guess: we ask
    // the platform through prefers-color-scheme, which reflects the OS "dark
    // mode" toggle, the browser's own theme and any per-site override, and make
    // that decision the single authority - <html data-bwdd-theme> mirrors it,
    // bwddTheme gives the script a live value and onChange() subscribers, and
    // the dark palette <style> created in injectStyles() is gated on it, so the
    // theme follows the environment instead of relying on the page honouring a
    // media query. A 'change' listener keeps it in sync while the viewer is
    // already open, no reload needed.
    const bwddTheme = (() => {
        let scheme = 'light';
        let started = false;
        let styleEl = null;            // dark-palette <style> gated by detection
        const subscribers = [];

        function mql(pref) {
            try {
                if (typeof window.matchMedia !== 'function') return null;
                return window.matchMedia('(prefers-color-scheme: ' + pref + ')');
            } catch (e) { return null; }
        }
        function readScheme() {
            // 'dark' wins; an explicit 'light' wins over nothing; anything
            // else (unsupported browser, "no-preference") resolves to light,
            // matching the script's default styling.
            const dark = mql('dark');
            if (dark && dark.matches) return 'dark';
            const light = mql('light');
            if (light && light.matches) return 'light';
            return 'light';
        }
        function publish() {
            try {
                if (document.documentElement) document.documentElement.setAttribute('data-bwdd-theme', scheme);
            } catch (e) {}
            for (const fn of subscribers) { try { fn(scheme); } catch (e) {} }
        }
        function gateStyle() {
            // The dark-palette <style> is in the document only while the
            // environment reports dark: attaching/removing the element is the most
            // widely supported gate (no reliance on CSSOM .disabled semantics) and
            // costs nothing - light mode has no dark sheet, dark mode appends one
            // after the base sheet.
            if (!styleEl) return;
            const host = (typeof document !== 'undefined' && (document.head || document.documentElement)) || null;
            if (!host) return;
            const connected = typeof styleEl.isConnected === 'boolean' ? styleEl.isConnected : !!styleEl.parentNode;
            const dark = scheme === 'dark';
            try {
                if (dark && !connected) host.appendChild(styleEl);
                else if (!dark && connected && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
            } catch (e) {}
        }
        function onMediaChange() {
            const next = readScheme();
            if (next === scheme) return;
            scheme = next;
            gateStyle();
            publish();
            if (BWDD_DEBUG) { try { console.info('[bwdd] light/dark scheme:', scheme); } catch (e) {} }
        }
        return {
            start() {
                if (started) return scheme;
                started = true;
                scheme = readScheme();
                publish();
                const dark = mql('dark');
                const light = mql('light');
                const attach = (mq) => {
                    if (!mq) return;
                    const fn = () => onMediaChange();
                    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', fn);
                    else if (typeof mq.addListener === 'function') mq.addListener(fn);   // legacy Safari
                };
                attach(dark); attach(light);
                if (BWDD_DEBUG) { try { console.info('[bwdd] light/dark scheme:', scheme); } catch (e) {} }
                return scheme;
            },
            get current() { return scheme; },
            isDark() { return scheme === 'dark'; },
            onChange(fn) {
                if (typeof fn === 'function') subscribers.push(fn);
                if (started) { try { fn(scheme); } catch (e) {} }
            },
            attachStyle(el) {
                styleEl = el;
                gateStyle();
            },
        };
    })();
    try { bwddTheme.start(); } catch (e) {}
    try {
        console.info('[bwdd] ' + sitePanelTitle() + ' v' + BWDD_VERSION + ' loaded, image codec: ' +
            IMAGE_CODEC.fmt + (IMAGE_CODEC.lossless ? ' (lossless)' : ' q' + IMAGE_CODEC.quality) +
            ', extension .' + IMAGE_CODEC.ext);
    } catch (e) {}
    if (BWDD_DEBUG) { try { window.__bwddTheme = bwddTheme; } catch (e) {} }

    let __bwddCssInjected = false;
    function injectStyles() {
        if (__bwddCssInjected) return;
        __bwddCssInjected = true;

        const font = document.createElement('link');
        font.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap';
        font.rel = 'stylesheet';
        document.head.appendChild(font);

        const css = document.createElement('style');
        css.textContent = `
#bwdd-root {
  --bwdd-accent-fill: #1d4ed8;
  --bwdd-amber-fill: #fcd9a8;
  --bwdd-bg: #ffffff;
  --bwdd-bg-ctrl: #f1f5f9;
  --bwdd-bg-ctrl-hover: #e2e8f0;
  --bwdd-bg-hover: #f1f5f9;
  --bwdd-bg-sunken: #f8fafc;
  --bwdd-border: #e2e8f0;
  --bwdd-border-soft: #f1f5f9;
  --bwdd-border-strong: #cbd5e1;
  --bwdd-code-bg: #f8fafc;
  --bwdd-danger: #b91c1c;
  --bwdd-danger-bg: #fef2f2;
  --bwdd-danger-border: #fecaca;
  --bwdd-glow-offline: 0 0 6px rgba(220, 38, 38, 0.45);
  --bwdd-glow-online: 0 0 6px rgba(21, 128, 61, 0.4);
  --bwdd-icon: #64748b;
  --bwdd-link: #1d4ed8;
  --bwdd-link-hover: #1e40af;
  --bwdd-link-hover-bg: rgba(29, 78, 216, 0.06);
  --bwdd-offline: #dc2626;
  --bwdd-root-fg: #0f172a;
  --bwdd-success: #15803d;
  --bwdd-success-dot: #15803d;
  --bwdd-text: #1e293b;
  --bwdd-text-ctrl: #334155;
  --bwdd-text-faint: #64748b;
  --bwdd-text-fainter: #94a3b8;
  --bwdd-text-muted: #475569;
  --bwdd-text-soft: #334155;
  --bwdd-text-strong: #0f172a;
  --bwdd-title: #1e293b;
  --bwdd-warn-bg: #fffbeb;
  --bwdd-warn-border: #fde68a;
  --bwdd-warn-code-bg: #fef9c3;
  --bwdd-warn-text: #92400e;
  --bwdd-caps-on-bg: #ecfdf5;
  --bwdd-caps-on-border: #a7f3d0;
  --bwdd-caps-on-text: #065f46;
  --bwdd-caps-on-strong: #064e3b;
  --bwdd-caps-off-bg: #f8fafc;
  --bwdd-caps-off-border: #e2e8f0;
  --bwdd-busy: #d97706;   /* amber, bridge busy (OCR/upload) */
  --bwdd-glow-busy: 0 0 6px rgba(217, 119, 6, 0.45);
  --bwdd-white: #ffffff;

  position: fixed;
  top: 16px;
  right: 24px;   /* room to grow leftward when the stats column mounts */
  z-index: 2147483647;
  width: 400px;   /* single-column default; widens to 640px once the stats column mounts */
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 32px);
  min-height: 0;
  background: var(--bwdd-bg);
  color: var(--bwdd-root-fg);
  border-radius: 14px;
  border: 1px solid var(--bwdd-border);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.04);
  font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  line-height: 1.4;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
  transition: height 0.2s ease, opacity 0.15s ease, width 0.25s ease, transform 0.25s ease;
}
#bwdd-root * { box-sizing: border-box; }
/* A store page's own font rules land directly on the panel's divs, so a leaf
   rule like .bwdd-btn { font-family: inherit } picks up the shop's font
   (Meiryo on CMOA) instead of ours. Make the whole subtree inherit from
   #bwdd-root; the only deliberate exception is monospace for code/pre. */
#bwdd-root *:not(code):not(pre):not(kbd):not(samp) { font-family: inherit; }
#bwdd-root.collapsed { height: auto !important; max-height: none !important; }
#bwdd-root.collapsed .bwdd-body { display: none; }
#bwdd-root.bwdd-stats-visible { width: 640px; }   /* two-column width, once there is a stats column to show */
@media (prefers-reduced-motion: reduce) {
  #bwdd-root, #bwdd-root *, .bwdd-btn, .bwdd-bar-fill { transition: none !important; }
}

/* Header with Drag Handle */
.bwdd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 10px 10px 12px;
  background: var(--bwdd-bg);
  border-bottom: 1px solid var(--bwdd-border-soft);
  cursor: grab;
  touch-action: none;
}
.bwdd-head:active { cursor: grabbing; }
.bwdd-title-group { display: flex; flex-direction: column; min-width: 0; }
.bwdd-title {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--bwdd-title);
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.2;
}
.bwdd-title .bwdd-icon { font-size: 14px; }
.bwdd-title-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.bwdd-subtitle {
  font-size: 11px;
  color: var(--bwdd-text-muted);
  font-weight: 500;
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 0 1 auto;   /* natural width, the GitHub link sits right after the text */
  min-width: 0;
}
.bwdd-gh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 17px;
  height: 17px;
  border-radius: 5px;
  color: var(--bwdd-text-muted);
  text-decoration: none;
  transition: background 0.15s, color 0.15s;
}
.bwdd-gh svg { width: 12px; height: 12px; fill: currentColor; display: block; }
.bwdd-gh:hover { color: var(--bwdd-link); background: var(--bwdd-link-hover-bg); }
.bwdd-gh:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
/* The shared script mark: a small, quiet link home beside the version line. */
.bwdd-mark {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 10px;
  font-weight: 600;
  color: var(--bwdd-text-muted);
  text-decoration: none;
  padding: 0 2px;
}
.bwdd-mark:hover { color: var(--bwdd-link); text-decoration: underline; }
.bwdd-mark:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
.bwdd-head-controls { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.bwdd-ctrl-btn {
  background: transparent;
  border: none;
  color: var(--bwdd-text-muted);
  font-size: 15px;
  line-height: 1;
  min-width: 32px;
  min-height: 32px;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.bwdd-ctrl-btn:hover { background: var(--bwdd-bg-hover); color: var(--bwdd-text-strong); }
.bwdd-ctrl-btn:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 2px; }
.bwdd-ctrl-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Scrollable Body */
.bwdd-body {
  padding: 10px 12px 12px;
  overflow: hidden;
  display: flex;
  flex-direction: row;
  gap: 10px;
  background: var(--bwdd-bg);
  user-select: text;
  flex: 1 1 auto;
  min-height: 0;
}
.bwdd-col { min-height: 0; }   /* allow the scrollable columns to shrink when the panel is resized vertically */
.bwdd-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}
.bwdd-col-stats {
  flex: 0 0 250px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.bwdd-col-main {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* Hairline between the controls column and the reading-stats column. It is
   appended together with the stats column, so it only exists once stats do. */
.bwdd-col-sep {
  flex: 0 0 auto;
  align-self: stretch;
  width: 1px;
  margin: 2px 0;
  background: var(--bwdd-border);
}
@media (max-width: 660px) {
  .bwdd-body { flex-direction: column; overflow-y: auto; }
  .bwdd-col-sep { display: none; }
  .bwdd-col-stats, .bwdd-col-main { flex: none; width: 100%; overflow: visible; }
}

/* Bridge Health Indicator */
.bwdd-bridge-pill {
  font-size: 11px;
  color: var(--bwdd-text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px;
  min-height: 24px;
}
.bwdd-indicator-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bwdd-text-fainter);
  display: inline-block;
  flex-shrink: 0;
}
.bwdd-indicator-dot.online { background: var(--bwdd-success-dot); box-shadow: var(--bwdd-glow-online); }

/* "What is the Mokuro Bridge?" help dot + toggleable infobox */
.bwdd-info-dot {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--bwdd-border-strong);
  background: var(--bwdd-bg-sunken);
  color: var(--bwdd-icon);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  padding: 0;
  font-family: inherit;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.bwdd-info-dot:hover,
.bwdd-info-dot:focus-visible,
.bwdd-info-dot[aria-expanded="true"] {
  background: var(--bwdd-accent-fill);
  border-color: var(--bwdd-accent-fill);
  color: var(--bwdd-white);
}
.bwdd-info-dot:focus-visible { outline: 2px solid rgba(29, 78, 216, 0.4); outline-offset: 1px; }
/* "mokuro missing" alert (below the bridge row) + mokuro detail line in the info box */
.bwdd-mokuro-alert {
  margin: 2px 0 6px;
  padding: 7px 9px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--bwdd-danger);
  background: var(--bwdd-danger-bg);
  border: 1px solid var(--bwdd-danger-border);
  border-radius: 8px;
}
.bwdd-mokuro-alert:empty { display: none; }
.bwdd-indicator-dot.offline {
  background: var(--bwdd-offline);
  box-shadow: var(--bwdd-glow-offline);
}
.bwdd-indicator-dot.busy {
  background: var(--bwdd-busy);
  box-shadow: var(--bwdd-glow-busy);
}
.bwdd-bridge-info-mokuro {
  display: block;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--bwdd-success);
}
.bwdd-bridge-info-mokuro.missing { color: var(--bwdd-danger); }
/* The bridge "?" infobox is positioned as an overlay popover (see the shared
   .bwdd-name-pop / .bwdd-bridge-pop box below); this anchor keeps it glued to
   the bridge status row it belongs to. */
.bwdd-bridge-anchor { position: relative; }
.bwdd-bridge-info-title {
  display: block;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--bwdd-text-muted);
  margin-bottom: 7px;
}
.bwdd-bridge-info-section { display: block; }
.bwdd-bridge-info-subhead {
  display: block;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--bwdd-text-muted);
  margin-bottom: 2px;
}
.bwdd-bridge-info-divider {
  border: none;
  border-top: 1px solid var(--bwdd-border);
  margin: 7px 0;
}
.bwdd-bridge-info-body { display: block; }
.bwdd-bridge-info-link {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--bwdd-link);
  text-decoration: none;
  font-weight: 600;
  font-size: 11px;
  line-height: 1.5;
  border: 1px solid currentColor;
  border-radius: 6px;
  padding: 4px 8px;
  min-height: 24px;
  white-space: nowrap;
}
.bwdd-bridge-info-link:hover { text-decoration: underline; background: var(--bwdd-link-hover-bg); }
.bwdd-bridge-info-link:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 2px; }

/* Progress Bars */
.bwdd-bars {
  display: none;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: var(--bwdd-bg-sunken);
  border: 1px solid var(--bwdd-border);
  border-radius: 10px;
}
.bwdd-bar-row { display: none; flex-direction: column; gap: 3px; }
.bwdd-bar-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--bwdd-text-muted);
}
.bwdd-bar-rate { font-variant-numeric: tabular-nums; color: var(--bwdd-text-strong); }
.bwdd-bar-track {
  position: relative;
  height: 6px;
  background: var(--bwdd-border);
  border-radius: 999px;
  overflow: hidden;
}
.bwdd-bar-fill,
.bwdd-bar-fill-bg {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  width: 0%;
  border-radius: 999px;
  transition: width 0.2s ease;
}
.bwdd-bar-fill { z-index: 2; }
.bwdd-bar-fill-bg {
  z-index: 1;
  background: var(--bwdd-amber-fill);   /* faint amber, pages received, not yet OCR'd */
}
.bwdd-bar-legend {
  font-size: 10px;
  line-height: 1.4;
  color: var(--bwdd-text-faint);
  margin-top: 1px;
}

/* Cards & Badges, compact, LearnNatively / Manga-Kotoba inspired */
.bwdd-cards { display: flex; flex-direction: column; gap: 8px; }
.bwdd-cards:empty { display: none; }
.bwdd-card {
  border: 1px solid var(--bwdd-border);
  background: var(--bwdd-bg);
  border-radius: 10px;
  padding: 8px 10px;
}
.bwdd-card h3 {
  margin: 0 0 5px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--bwdd-text-muted);
  line-height: 1.3;
}
.bwdd-card[data-card="book"] {
  background: var(--bwdd-bg-sunken);
  border-color: var(--bwdd-border-strong);
}
.bwdd-book-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--bwdd-text-strong);
  margin-bottom: 5px;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.bwdd-spec-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.bwdd-spec-badges:empty { display: none; }
.bwdd-spec-badge {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-size: 11px;
  background: var(--bwdd-bg);
  border: 1px solid var(--bwdd-border);
  border-radius: 6px;
  padding: 1px 6px;
  line-height: 1.5;
}
.bwdd-spec-lbl { color: var(--bwdd-text-muted); font-weight: 500; }
.bwdd-spec-val { color: var(--bwdd-text-strong); font-weight: 600; font-variant-numeric: tabular-nums; }

.bwdd-card-sub { font-size: 11px; font-weight: 600; color: var(--bwdd-text); margin-bottom: 4px; line-height: 1.35; }
.bwdd-lvl-cap { font-size: 10px; color: var(--bwdd-text-muted); font-weight: 500; }

/* Compact stat rows (shared LN + MK) */
.bwdd-grid {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 1px 10px;
  font-size: 11px;
  margin: 2px 0 4px;
}
.bwdd-grid dt { color: var(--bwdd-text-muted); font-weight: 500; line-height: 1.6; }
.bwdd-grid dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--bwdd-title); line-height: 1.6; }

.bwdd-card-links { display: flex; gap: 6px; margin-top: 6px; font-size: 11px; }
.bwdd-link {
  color: var(--bwdd-link);
  text-decoration: none;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid currentColor;
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  line-height: 1.5;
  min-height: 24px;
}
.bwdd-card-links .bwdd-link { flex: 1; text-align: center; }
.bwdd-link:hover { text-decoration: underline; background: var(--bwdd-link-hover-bg); }
.bwdd-link:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 2px; }

.bwdd-nlvl-pill {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border-radius: 6px;
  padding: 2px 9px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  line-height: 1.5;
  min-height: 22px;
}
/* LearnNatively card: warm cream body, brown text, teal links */
.bwdd-card[data-card="natively"] {
  background: #faf6ee;
  border-color: #e8ddc9;
  color: #3f3227;
  box-shadow: none;
}
.bwdd-card[data-card="natively"] h3 { color: #8a6d3b; }
.bwdd-card[data-card="natively"] .bwdd-card-sub { color: #3f3227; }
.bwdd-card[data-card="natively"] .bwdd-lvl-cap { color: #6f5f4d; }
.bwdd-card[data-card="natively"] .bwdd-link { color: #0f766e; border-color: #0f766e; }
.bwdd-card[data-card="natively"] .bwdd-link:hover { background: rgba(15, 118, 110, 0.08); }
.bwdd-card[data-card="natively"] .bwdd-link:focus-visible { outline-color: #0f766e; }
.bwdd-ln-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.bwdd-ln-title-row {
  display: block;
  flex: 1 1 160px;
  min-width: 0;
  margin-bottom: 0;
  line-height: 1.45;
}
.bwdd-ln-meta {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0;
  flex: 0 0 auto;
}
.bwdd-ln-social {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 3px 16px;
  border-top: 1px solid #e8ddc9;
  padding-top: 6px;
  margin: 6px 0 0;
  line-height: 1.7;
  font-size: 11px;
  color: #6f5f4d;
  text-align: left;
}
/* Manga-Kotoba card: plain white body, sage text, hairline ledger rows */
.bwdd-card[data-card="manga-kotoba"] {
  background: #ffffff;
  border-color: #dfe3d2;
  color: #243b2a;
  box-shadow: none;
}
.bwdd-card[data-card="manga-kotoba"] h3 { color: #6b5d2e; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid { margin-bottom: 2px; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dt,
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dd {
  padding: 1px 0;
  border-bottom: 1px solid #edf0e3;
}
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dt { color: #5b6650; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dd { color: #243b2a; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link { color: #3f6212; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link:hover { background: rgba(63, 98, 18, 0.07); }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link:focus-visible { outline-color: #3f6212; }
.bwdd-mk-title {
  display: block;
  text-align: center;
  margin-bottom: 2px;
}
.bwdd-lnbadge {
  display: inline-block;
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 5px;
  color: var(--bwdd-text-muted);
  font-size: 10px;
  font-weight: 700;
  padding: 0 5px;
  line-height: 1.6;
}
.bwdd-none { font-size: 11px; color: var(--bwdd-text-muted); margin: 0 0 6px; line-height: 1.5; text-align: center; }

/* Action Buttons */
.bwdd-actions { display: flex; flex-direction: column; gap: 6px; margin-top: 2px; }

/* Upload destination picker */
.bwdd-dest {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 6px;
  padding: 8px 10px;
  background: var(--bwdd-bg-sunken);
  border: 1px solid var(--bwdd-border);
  border-radius: 10px;
}
.bwdd-dest-label { font-size: 11px; font-weight: 600; color: var(--bwdd-text-muted); }
.bwdd-opt-row { display: flex; align-items: center; gap: 6px; }
.bwdd-opt-row > * { flex: 1 1 0; min-width: 0; }
.bwdd-opt-row > .bwdd-dest-label { flex: 0 0 auto; white-space: nowrap; }
/* Pre-flight numbers, shown inside the bridge row's "?" popover. */
.bwdd-caps-line {
  display: block;
  font-weight: 600;
  color: var(--bwdd-text-strong);
  margin: 2px 0 4px;
}
.bwdd-bridge-info-section.on .bwdd-caps-line { color: var(--bwdd-caps-on-strong); }
.bwdd-caps-note { font-size: 10px; color: var(--bwdd-text-faint); }
/* Advanced image settings, collapsed so they stay out of the way. */
.bwdd-fmt { margin-top: 8px; }
.bwdd-fmt-summary {
  cursor: pointer;
  font-size: 11px;
  font-weight: 600;
  color: var(--bwdd-text-muted);
  padding: 3px 2px;
  border-radius: 4px;
}
.bwdd-fmt-summary:hover { color: var(--bwdd-link); }
.bwdd-fmt-summary:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
.bwdd-fmt[open] > .bwdd-fmt-summary { margin-bottom: 2px; }

/* The panel's own form controls must look the same on every store. A shop's
   stylesheet lands on bare input/select/textarea elements, and exactly which
   properties it touches differs per store, so this is a scoped reset rather
   than a list tuned to one leak: every property a host page realistically sets
   is pinned once for the whole panel subtree. The #bwdd-root prefix outranks a
   page selector that is an element, a class, or an element plus an attribute,
   so a host rule only wins with !important, which no store stylesheet uses for
   generic form controls. The prefix is also what keeps the reset off the host
   page's own fields. */
#bwdd-root input,
#bwdd-root select,
#bwdd-root textarea {
  box-sizing: border-box;
  height: auto;
  min-height: 0;
  max-height: none;
  margin: 0;
  padding: 5px 7px;
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 6px;
  background: var(--bwdd-bg);
  color: var(--bwdd-root-fg);
  font-family: inherit;
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
  line-height: 1.4;
  letter-spacing: normal;
  text-transform: none;
  text-indent: 0;
  vertical-align: middle;
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
}
/* appearance: none would take the native dropdown affordance with it, and the
   panel draws no caret of its own, so a select keeps the platform control. */
#bwdd-root select { appearance: auto; -webkit-appearance: auto; }
#bwdd-root input:focus-visible,
#bwdd-root select:focus-visible,
#bwdd-root textarea:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
.bwdd-dest-localdir { display: flex; flex-direction: column; gap: 3px; }
.bwdd-dest-hint { font-size: 11px; color: var(--bwdd-warn-text); background: var(--bwdd-warn-bg); border: 1px solid var(--bwdd-warn-border); border-radius: 6px; padding: 5px 7px; line-height: 1.4; }
.bwdd-dest-hint code { font-family: ui-monospace, monospace; font-size: 10px; background: var(--bwdd-warn-code-bg); border-radius: 3px; padding: 0 3px; }
/* Archive-name field (above the action buttons): one compact row of label,
   input and "?" info dot; the popover it opens overlays the buttons below. */
.bwdd-name {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
}
.bwdd-name .bwdd-dest-label { flex: 0 0 auto; }
/* Higher specificity than the subtree reset above, so the name field keeps its
   compact row sizing (natural width, tighter vertical padding). */
#bwdd-root .bwdd-name .bwdd-dest-input { flex: 1 1 auto; width: auto; min-width: 0; padding-top: 4px; padding-bottom: 4px; }
.bwdd-name .bwdd-info-dot {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  min-width: 18px;
  min-height: 18px;
  font-size: 10px;
}
/* "?" popovers (archive-name field + Mokuro Bridge info): one shared overlay
   look. Each popover is absolutely positioned under its own row (its anchor
   sets position:relative) and overlays whatever sits below, so opening one
   never takes layout space or pushes content around. */
.bwdd-name-pop,
.bwdd-bridge-pop {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 8;
  width: 300px;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 24px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 9px 11px;
  background: var(--bwdd-bg);
  color: var(--bwdd-text-soft);
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 8px;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18), 0 2px 6px rgba(15, 23, 42, 0.08);
  font-size: 11px;
  line-height: 1.5;
}
.bwdd-name-pop > div + div { margin-top: 5px; }
.bwdd-name-pop[hidden], .bwdd-bridge-pop[hidden] { display: none; }
.bwdd-btn-fill {
  flex: 0 0 auto;
  font: 600 11px inherit;
  padding: 5px 8px;
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 6px;
  background: var(--bwdd-bg-ctrl);
  color: var(--bwdd-text-ctrl);
  cursor: pointer;
  white-space: nowrap;
}
.bwdd-btn-fill:hover { background: var(--bwdd-bg-ctrl-hover); }
.bwdd-btn-fill:focus-visible { outline: 2px solid var(--bwdd-link); outline-offset: 1px; }
.bwdd-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 8px 12px;
  min-height: 44px;
  border: none;
  border-radius: 10px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--bwdd-white);
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s;
}
.bwdd-btn-sub {
  font-size: 11px;
  font-weight: 400;
  opacity: 0.9;
  margin-top: 1px;
}
.bwdd-btn > span { text-align: center; width: 100%; }
.bwdd-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}
.bwdd-btn:active:not(:disabled) { transform: translateY(0); }
.bwdd-btn:focus-visible { outline: 2px solid var(--bwdd-root-fg); outline-offset: 2px; }
.bwdd-btn:disabled { opacity: 0.6; cursor: not-allowed; }
@media (forced-colors: active) {
  .bwdd-btn, .bwdd-nlvl-pill { forced-color-adjust: none; }
}

.bwdd-btn.zip {
  background: linear-gradient(135deg, #15803d 0%, #166534 100%);
  box-shadow: 0 4px 12px rgba(22, 101, 52, 0.25);
}
.bwdd-btn.zip:hover:not(:disabled) {
  box-shadow: 0 6px 16px rgba(22, 101, 52, 0.35);
}
.bwdd-btn.ocr {
  background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);
}
.bwdd-btn.ocr:hover:not(:disabled) {
  box-shadow: 0 6px 16px rgba(37, 99, 235, 0.35);
}

/* Destination section dimmed while a run holds the lock */
.bwdd-dest-locked { opacity: 0.7; }

/* "Open Reader Mokuro" + open-file/copy, one quiet row, only after a
   successful OCR run. Both are secondary actions, so they share a calm
   outline-button look instead of loud filled gradients. */
.bwdd-reader-row {
  display: none;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 6px;
  margin-top: 6px;
}
/* The quiet outline button is a component, not a child of one row. Only the
   row's own sizing stays scoped there. */
.bwdd-ghost-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 10px;
  min-height: 30px;
  border: 1px solid var(--bwdd-border-strong);
  border-radius: 8px;
  background: var(--bwdd-bg);
  color: var(--bwdd-text-muted);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.bwdd-reader-row > .bwdd-ghost-btn {
  min-width: 0;
  width: 100%;
}
.bwdd-ghost-btn:hover {
  background: var(--bwdd-bg-sunken);
  color: var(--bwdd-link);
  border-color: var(--bwdd-link);
}
.bwdd-ghost-btn:focus-visible {
  outline: 2px solid var(--bwdd-link);
  outline-offset: 1px;
}

.bwdd-hint-box {
  font-size: 11px;
  color: var(--bwdd-text-muted);
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.45;
}
.bwdd-hint-box:empty { display: none; }
/* Collapsible raw-error block inside the status area (see setRunDetails) */
.bwdd-hint-box details { margin-top: 6px; }
.bwdd-hint-box summary {
  cursor: pointer;
  color: var(--bwdd-link);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.bwdd-hint-box summary:hover { color: var(--bwdd-link-hover); }
.bwdd-hint-box pre {
  margin: 6px 0 0;
  padding: 6px 8px;
  background: var(--bwdd-code-bg);
  border: 1px solid var(--bwdd-border);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--bwdd-text-muted);
  max-height: 140px;
  overflow: auto;
}
/* Panel flapped away to the right, an edge tab stays to bring it back */
#bwdd-root.bwdd-flapped { pointer-events: none; }
.bwdd-edge-tab {
  position: fixed;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2147483647;
  display: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 76px;
  padding: 0;
  border: none;
  border-radius: 10px 0 0 10px;
  background: #1d4ed8;
  color: #ffffff;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  box-shadow: -3px 0 10px rgba(15, 23, 42, 0.18);
  transition: background 0.15s;
}
.bwdd-edge-tab:hover { background: #2563eb; }
.bwdd-edge-tab:focus-visible { outline: 2px solid #1d4ed8; outline-offset: -2px; }
/* Header drag grip + corner resize handle */
.bwdd-drag-grip {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: stretch;
  width: 16px;
  color: var(--bwdd-text-fainter);
  font-size: 11px;
  line-height: 1;
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.bwdd-drag-grip:active { cursor: grabbing; }
.bwdd-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 22px;
  height: 22px;
  z-index: 6;
  cursor: nwse-resize;   /* corner: resize both width and height */
  touch-action: none;
  user-select: none;
}
.bwdd-resize::after {
  content: '';
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 9px;
  height: 9px;
  border-right: 2px solid var(--bwdd-text-fainter);
  border-bottom: 2px solid var(--bwdd-text-fainter);
  border-bottom-right-radius: 3px;
  opacity: 0.65;
  transition: opacity 0.15s;
}
.bwdd-resize:hover::after,
.bwdd-resize:active::after { opacity: 1; }
#bwdd-root.collapsed .bwdd-resize,
#bwdd-root.bwdd-flapped .bwdd-resize { display: none; }

`;
        (document.head || document.documentElement).appendChild(css);

        // Dark palette (only active while bwddTheme detects dark, section 12a).
        // This is a deliberate per-rule remap, not a blanket inversion: the
        // chrome and surfaces get a dark palette chosen for contrast, and the
        // LearnNatively / Manga-Kotoba stat cards get brand-matched dark variants
        // below. The only elements left alone are the Natively difficulty level
        // rectangles (.bwdd-nlvl-pill), whose semantic colors are set inline and
        // already read correctly on dark. The rules have no @media wrapper on
        // purpose: the stylesheet element is attached/removed by
        // bwddTheme.attachStyle() above, so the environment detection is the one
        // gate.
        const darkCss = document.createElement('style');
        darkCss.textContent = `
#bwdd-root {
  --bwdd-accent-fill: #3b82f6;
  --bwdd-amber-fill: rgba(245, 158, 11, 0.22);
  --bwdd-bg: #0f172a;
  --bwdd-bg-ctrl: #334155;
  --bwdd-bg-ctrl-hover: #475569;
  --bwdd-bg-hover: #1e293b;
  --bwdd-bg-sunken: #1e293b;
  --bwdd-border: #334155;
  --bwdd-border-soft: #1e293b;
  --bwdd-border-strong: #475569;
  --bwdd-code-bg: #0f172a;
  --bwdd-danger: #f87171;
  --bwdd-danger-bg: rgba(127, 29, 29, 0.28);
  --bwdd-danger-border: #7f1d1d;
  --bwdd-glow-offline: 0 0 6px rgba(248, 113, 113, 0.4);
  --bwdd-glow-online: 0 0 6px rgba(34, 197, 94, 0.45);
  --bwdd-icon: #cbd5e1;
  --bwdd-link: #60a5fa;
  --bwdd-link-hover: #93c5fd;
  --bwdd-link-hover-bg: rgba(96, 165, 250, 0.12);
  --bwdd-offline: #f87171;
  --bwdd-root-fg: #e2e8f0;
  --bwdd-success: #4ade80;
  --bwdd-success-dot: #22c55e;
  --bwdd-text: #e2e8f0;
  --bwdd-text-ctrl: #e2e8f0;
  --bwdd-text-faint: #94a3b8;
  --bwdd-text-fainter: #64748b;
  --bwdd-text-muted: #94a3b8;
  --bwdd-text-soft: #cbd5e1;
  --bwdd-text-strong: #f1f5f9;
  --bwdd-title: #f1f5f9;
  --bwdd-warn-bg: rgba(251, 191, 36, 0.12);
  --bwdd-warn-border: rgba(251, 191, 36, 0.35);
  --bwdd-warn-code-bg: rgba(251, 191, 36, 0.25);
  --bwdd-warn-text: #fcd34d;
  --bwdd-caps-on-bg: rgba(16, 185, 129, 0.14);
  --bwdd-caps-on-border: rgba(16, 185, 129, 0.38);
  --bwdd-caps-on-text: #6ee7b7;
  --bwdd-caps-on-strong: #a7f3d0;
  --bwdd-caps-off-bg: #1e293b;
  --bwdd-caps-off-border: #334155;
  --bwdd-busy: #f59e0b;
  --bwdd-glow-busy: 0 0 6px rgba(245, 158, 11, 0.5);
  --bwdd-white: #ffffff;
  background: var(--bwdd-bg);
  color: var(--bwdd-root-fg);
  border-color: var(--bwdd-border);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.35);
  color-scheme: dark;
}

/* LearnNatively card, dark variant: warm espresso surfaces with cream text.
   The difficulty level rectangles (.bwdd-nlvl-pill) are deliberately NOT
   restyled here, their semantic colors are set inline by JS and already
   read correctly on the dark card. */
.bwdd-card[data-card="natively"] {
  background: #201a12;
  border-color: #463a27;
  color: #e9dcbf;
  box-shadow: none;
}
.bwdd-card[data-card="natively"] h3 { color: #cfa95f; }
.bwdd-card[data-card="natively"] .bwdd-card-sub { color: #f0e6d2; }
.bwdd-card[data-card="natively"] .bwdd-lvl-cap { color: #bfa97f; }
.bwdd-card[data-card="natively"] .bwdd-lnbadge {
  border-color: #574832;
  background: #2a2319;
  color: #d5c5a6;
}
.bwdd-card[data-card="natively"] .bwdd-link { color: #2dd4bf; border-color: #2dd4bf; }
.bwdd-card[data-card="natively"] .bwdd-link:hover { background: rgba(45, 212, 191, 0.12); }
.bwdd-card[data-card="natively"] .bwdd-link:focus-visible { outline-color: #2dd4bf; }
.bwdd-card[data-card="natively"] .bwdd-ln-social {
  border-top-color: #4a3d2a;
  color: #c8b896;
}


/* Manga-Kotoba card, dark variant: deep sage ink with sage/cream text. */
.bwdd-card[data-card="manga-kotoba"] {
  background: #131a14;
  border-color: #2e3f33;
  color: #d9e4da;
  box-shadow: none;
}
.bwdd-card[data-card="manga-kotoba"] h3 { color: #cfbf7a; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-card-sub { color: #e6efe7; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dt,
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dd {
  border-bottom-color: #283a2f;
}
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dt { color: #9db3a1; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-grid dd { color: #e2ebe3; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link { color: #84cc16; border-color: #84cc16; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link:hover { background: rgba(132, 204, 22, 0.14); }
.bwdd-card[data-card="manga-kotoba"] .bwdd-link:focus-visible { outline-color: #84cc16; }
.bwdd-card[data-card="manga-kotoba"] .bwdd-none { color: #a9bcab; }
.bwdd-dest-select:focus-visible, .bwdd-dest-input:focus-visible,
.bwdd-btn-fill:focus-visible { outline-color: #60a5fa; }
.bwdd-hint-box summary { color: #60a5fa; }
.bwdd-hint-box summary:hover { color: #93c5fd; }
.bwdd-hint-box pre { background: #0f172a; border-color: #334155; color: #94a3b8; }
/* Edge restore tab (dark) */
.bwdd-edge-tab { background: #3b82f6; color: #ffffff; box-shadow: -3px 0 10px rgba(0, 0, 0, 0.4); }
.bwdd-edge-tab:hover { background: #60a5fa; }
.bwdd-edge-tab:focus-visible { outline-color: #60a5fa; }
/* Quiet reader/stored row (dark), colors come from --bwdd-* tokens */
.bwdd-ghost-btn { background: var(--bwdd-bg); color: var(--bwdd-text-muted); border-color: var(--bwdd-border-strong); }
.bwdd-ghost-btn:hover { background: var(--bwdd-bg-sunken); color: var(--bwdd-link); border-color: var(--bwdd-link); }

`;
        (document.head || document.documentElement).appendChild(darkCss);
        bwddTheme.attachStyle(darkCss);   // removed from the DOM unless dark is detected
    }
