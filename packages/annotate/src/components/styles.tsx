/**
 * Mission styling for the annotation suite, from docs/design/ui-options/round2/option-1-mission.css
 * and the tokens in packages/ui/src/tokens.css. Severity colours come from the project's severity
 * model at runtime (inline `--sev`), so the classes only use neutral tokens.
 */
const css = `
.ann-panel { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--bg-1); color: var(--fg-1); font: 400 var(--t-13)/1.4 var(--f-ui); }
.ann-h { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border-bottom: 1px solid var(--line); flex: none; }
.ann-h h2, .ann-h h3 { margin: 0; font: 600 var(--t-12)/1 var(--f-ui); letter-spacing: .06em; text-transform: uppercase; color: var(--fg-2); }
.ann-h .sub { font: 400 var(--t-11)/1 var(--f-mono); color: var(--fg-3); }
.ann-h .acts { margin-left: auto; display: flex; gap: 4px; align-items: center; }
.ann-btn { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-4); background: var(--bg-2); color: var(--fg-1); font: 500 var(--t-12)/1 var(--f-ui); cursor: pointer; transition: background .15s var(--ease), border-color .15s var(--ease); }
.ann-btn:hover:not(:disabled) { background: var(--bg-3); border-color: var(--line-strong); }
.ann-btn:disabled { opacity: .45; cursor: default; }
.ann-btn.ghost { background: transparent; border-color: transparent; }
.ann-btn.primary { background: var(--acc); border-color: var(--acc); color: var(--acc-ink); }
.ann-btn.danger { color: var(--danger); }
.ann-btn[aria-pressed='true'] { background: var(--acc-a20); border-color: var(--acc-a40); color: var(--acc-strong); }
.ann-btn:focus-visible, .ann-row:focus-visible, .ann-input:focus-visible { outline: 2px solid var(--acc); outline-offset: -2px; }
.ann-save { font: 400 var(--t-11)/1 var(--f-mono); color: var(--fg-3); display: inline-flex; align-items: center; gap: 5px; }
.ann-save i { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
.ann-save[data-state='pending'] i, .ann-save[data-state='saving'] i { background: var(--warn); }
.ann-save[data-state='error'] { color: var(--danger); }
.ann-save[data-state='error'] i { background: var(--danger); }
.ann-filter { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 12px; border-bottom: 1px solid var(--line-soft); align-items: center; flex: none; }
.ann-seg { display: inline-flex; border: 1px solid var(--line); border-radius: var(--r-4); overflow: hidden; }
.ann-seg button { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 7px; border: 0; border-right: 1px solid var(--line); background: transparent; color: var(--fg-2); font: 500 var(--t-11)/1 var(--f-mono); cursor: pointer; }
.ann-seg button:last-child { border-right: 0; }
.ann-seg button[aria-pressed='true'] { background: var(--bg-3); color: var(--fg-0); }
.ann-input, .ann-select { height: 24px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-4); background: var(--bg-2); color: var(--fg-0); font: 400 var(--t-12)/1 var(--f-ui); min-width: 0; }
.ann-input.grow { flex: 1; }
textarea.ann-input { height: auto; min-height: 56px; padding: 6px 8px; line-height: 1.45; resize: vertical; font-family: var(--f-ui); }
.ann-dot { width: 8px; height: 8px; border-radius: 2px; flex: none; background: var(--sev, var(--s1)); }
.ann-list { flex: 1; min-height: 0; overflow-y: auto; outline: none; }
.ann-row { display: grid; grid-template-columns: 14px 44px minmax(0, 1fr) auto; gap: 2px 10px; height: 48px; box-sizing: border-box; padding: 0 12px; align-content: center; border-bottom: 1px solid var(--line-soft); cursor: pointer; align-items: center; }
.ann-row .ann-tick { grid-row: span 2; }
.ann-row.ro { grid-template-columns: 44px minmax(0, 1fr) auto; }
.ann-tick { margin: 0; width: 13px; height: 13px; accent-color: var(--acc); cursor: pointer; opacity: .55; }
span.ann-tick { display: inline-block; box-sizing: border-box; border: 1px solid var(--fg-3); border-radius: 2px; background: var(--bg-1); position: relative; }
span.ann-tick[data-on='true'] { background: var(--acc); border-color: var(--acc); }
span.ann-tick[data-on='true']::after { content: ''; position: absolute; left: 3.5px; top: 0.5px; width: 3px; height: 7px; border: solid var(--acc-ink); border-width: 0 1.5px 1.5px 0; transform: rotate(45deg); }
.ann-row:hover .ann-tick, .ann-row.checked .ann-tick, .ann-bulk .ann-tick { opacity: 1; }
.ann-row.checked { background: var(--acc-a12, var(--bg-2)); }
.ann-group { display: flex; align-items: center; gap: 8px; width: 100%; height: 30px; box-sizing: border-box; padding: 0 12px; border: 0; border-bottom: 1px solid var(--line); background: var(--bg-2); color: var(--fg-1); font: 600 var(--t-11)/1 var(--f-ui); letter-spacing: .04em; text-transform: uppercase; cursor: pointer; text-align: left; }
.ann-group:hover { background: var(--bg-3); }
.ann-group .car { width: 10px; color: var(--fg-3); font-size: 10px; }
.ann-group .gl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ann-group .gc { font: 500 var(--t-11)/1 var(--f-mono); color: var(--fg-3); text-transform: none; }
.ann-bulk { display: flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-bottom: 1px solid var(--line-soft); flex: none; }
.ann-bulk[data-active='true'] { background: color-mix(in oklch, var(--acc) 8%, var(--bg-1)); }
.ann-bulk .cnt { font: 600 var(--t-12)/1 var(--f-mono); color: var(--acc-strong); margin-right: 4px; white-space: nowrap; }
.ann-bulk .ann-faint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ann-notice { padding: 6px 12px; font-size: var(--t-11); color: var(--fg-2); border-bottom: 1px solid var(--line-soft); flex: none; }
.ann-dir { min-width: 26px; justify-content: center; font-family: var(--f-mono); }
.ann-row:hover { background: var(--bg-2); }
.ann-row[aria-selected='true'] { background: var(--bg-2); box-shadow: inset 0 0 0 1px var(--line-strong); }
.ann-row .iid { font: 600 var(--t-12)/1 var(--f-mono); color: var(--fg-0); grid-row: span 2; }
.ann-row.draft .iid { color: var(--s4); }
.ann-row .it { font-size: var(--t-12); color: var(--fg-0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ann-row .im { font-size: var(--t-11); color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ann-row .ann-sev { grid-row: span 2; }
.ann-row .st { font: 400 10.5px/1 var(--f-mono); color: var(--fg-3); }
.ann-sev { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px; border-radius: 3px; font: 600 var(--t-11)/1 var(--f-mono); white-space: nowrap; background: color-mix(in oklch, var(--sev) 16%, transparent); color: color-mix(in oklch, var(--sev) 70%, var(--fg-0)); }
.ann-sev i { width: 7px; height: 7px; border-radius: 1.5px; display: block; background: var(--sev); }
.ann-sev.unc i { background: repeating-linear-gradient(-45deg, var(--sev) 0 1.5px, transparent 1.5px 3px); }
.ann-tag { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 6px; border: 1px solid var(--line); border-radius: 3px; font-size: var(--t-11); color: var(--fg-2); white-space: nowrap; }
.ann-tag.acc { border-color: var(--acc-a40); color: var(--acc); }
.ann-ini { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 18px; padding: 0 4px; border-radius: 9px; background: var(--bg-3, rgba(127,127,127,.15)); font-size: var(--t-11); font-weight: 600; color: var(--fg-2); white-space: nowrap; }
.ann-pins { display: flex; flex-direction: column; gap: 8px; min-width: 220px; }
.ann-pins .ann-faint { margin: 0; line-height: 1.4; max-width: 260px; }
.ann-check { display: inline-flex; align-items: center; gap: 8px; font-size: var(--t-12); color: var(--fg-1); cursor: pointer; }
.ann-check input { accent-color: var(--acc); margin: 0; }
.ann-empty { padding: 24px 16px; color: var(--fg-3); font-size: var(--t-12); text-align: center; }
.ann-body { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; overflow-y: auto; }
.ann-field { display: grid; grid-template-columns: 72px 1fr; gap: 8px; align-items: center; font-size: var(--t-12); }
.ann-field > span { color: var(--fg-3); }
.ann-sightings { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; }
.ann-sighting { border: 1px solid var(--line-soft); border-radius: var(--r-4); overflow: hidden; background: var(--bg-0); cursor: pointer; text-align: left; padding: 0; color: inherit; }
.ann-sighting:hover { border-color: var(--line-strong); }
.ann-sighting .sth { aspect-ratio: 4 / 3; position: relative; background: var(--bg-2) center / cover no-repeat; display: grid; place-items: center; color: var(--fg-3); font: 500 var(--t-11)/1 var(--f-mono); }
.ann-sighting .stl { padding: 4px 6px; font-size: 10.5px; color: var(--fg-2); display: flex; align-items: center; gap: 4px; white-space: nowrap; overflow: hidden; }
.ann-sighting .stl button { margin-left: auto; }
.ann-audit { font: 400 var(--t-11)/1.5 var(--f-mono); color: var(--fg-3); margin: 0; padding-left: 14px; }
.ann-error { color: var(--danger); font-size: var(--t-11); }
.new-class-row { display: flex; flex-direction: column; gap: 4px; padding: 2px 6px; }
.new-class-row .ann-input { width: 100%; box-sizing: border-box; }
.ann-faint { color: var(--fg-3); font-size: var(--t-11); }
.ann-ro-title { color: var(--fg-0); font-size: var(--t-14); font-weight: 600; line-height: 1.35; }
.ann-ro-note { margin: 0; color: var(--fg-1); font-size: var(--t-13); line-height: 1.5; white-space: pre-wrap; }

.ann-stage { position: relative; overflow: hidden; background: var(--bg-0); width: 100%; height: 100%; touch-action: none; user-select: none; }
.ann-stage img.ann-img { position: absolute; left: 0; top: 0; transform-origin: 0 0; image-rendering: auto; pointer-events: none; }
.ann-stage svg.ann-draw { position: absolute; inset: 0; width: 100%; height: 100%; }
.ann-stage svg .shape { fill: color-mix(in oklch, var(--c) 14%, transparent); stroke: var(--c); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.ann-stage svg .shape.sel { stroke-width: 2.5; fill: color-mix(in oklch, var(--c) 24%, transparent); }
.ann-stage svg .draft { fill: var(--acc-a12); stroke: var(--acc); stroke-dasharray: 4 3; stroke-width: 1.5; }
.ann-stage svg .handle { fill: var(--bg-0); stroke: var(--acc); stroke-width: 1.5; cursor: grab; }
.ann-stage svg .label { font: 600 11px/1 var(--f-mono); fill: var(--ov); paint-order: stroke; stroke: oklch(0.13 0.01 250 / 0.85); stroke-width: 3px; }
.ann-stage svg.det-look .halo { fill: none; stroke: oklch(0.13 0.01 250 / 0.72); stroke-width: 4.5; stroke-linejoin: round; vector-effect: non-scaling-stroke; pointer-events: none; transition: stroke-width .12s var(--ease-x), opacity .12s var(--ease-x); }
.ann-stage svg.det-look .shape { fill: color-mix(in oklch, var(--c) 10%, transparent); stroke-width: 2.5; stroke-linejoin: round; transition: stroke-width .12s var(--ease-x), opacity .12s var(--ease-x); }
.ann-stage svg.det-look .shape.hov { stroke-width: 3.5; }
.ann-stage svg.det-look .halo.hov, .ann-stage svg.det-look .halo.sel { stroke-width: 5.5; }
.ann-stage svg.det-look .shape.sel { stroke-width: 3.5; fill: color-mix(in oklch, var(--c) 16%, transparent); filter: drop-shadow(0 0 4px color-mix(in oklch, var(--c) 65%, transparent)); }
.ann-stage svg.det-look.has-sel .shape:not(.sel):not(.hov), .ann-stage svg.det-look.has-sel .halo:not(.sel):not(.hov), .ann-stage svg.det-look.has-sel .chip:not(.sel) { opacity: 0.6; }
.ann-stage svg.det-look .chip { pointer-events: none; transition: opacity .12s var(--ease-x); }
.ann-stage svg.det-look .chip rect { stroke: oklch(0.13 0.01 250 / 0.55); stroke-width: 1; }
.ann-stage svg.det-look .chip text { font: 600 12px/1 var(--f-ui); dominant-baseline: central; }
@media (prefers-reduced-motion: reduce) { .ann-stage svg.det-look .halo, .ann-stage svg.det-look .shape, .ann-stage svg.det-look .chip { transition: none; } }
.ann-toolbar { position: absolute; top: 8px; left: 8px; display: flex; gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: var(--r-6); background: var(--scrim); backdrop-filter: blur(6px); z-index: 2; align-items: center; }
.ann-toolbar .sep { width: 1px; height: 16px; background: var(--line); margin: 0 3px; }
.ann-toolbar label { display: inline-flex; align-items: center; gap: 6px; font: 400 var(--t-11)/1 var(--f-mono); color: var(--fg-2); padding: 0 6px; }
.ann-toolbar input[type='range'] { width: 80px; accent-color: var(--acc); }
.ann-zoom { position: absolute; bottom: 8px; right: 8px; font: 400 var(--t-11)/1 var(--f-mono); color: var(--ov-dim); background: var(--scrim); padding: 4px 6px; border-radius: var(--r-4); z-index: 2; }
.ann-pop { position: fixed; z-index: 50; width: min(640px, calc(100vw - 24px)); max-height: min(680px, calc(100vh - 24px)); background: var(--bg-1); border: 1px solid var(--line-strong); border-radius: var(--r-6); box-shadow: 0 16px 40px oklch(0 0 0 / 0.45); display: flex; flex-direction: column; font: 400 var(--t-12)/1.35 var(--f-ui); color: var(--fg-1); animation: ann-in .16s var(--ease-x); overflow: hidden; }
@keyframes ann-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.ann-pop-h { display: flex; flex-direction: column; gap: 3px; padding: 12px 14px 10px; border-bottom: 1px solid var(--line); flex: none; }
.ann-pop-h b { font: 600 var(--t-13)/1.2 var(--f-ui); color: var(--fg-0); }
.ann-pop-body { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(220px, 0.9fr); flex: 1; min-height: 280px; }
.ann-pop[data-stack='true'] .ann-pop-body { grid-template-columns: minmax(0, 1fr); }
.ann-pop-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ann-pop-col + .ann-pop-col { border-left: 1px solid var(--line); }
.ann-pop[data-stack='true'] .ann-pop-col + .ann-pop-col { border-left: 0; border-top: 1px solid var(--line); }
.ann-pop-col-h { display: flex; align-items: baseline; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line-soft); flex: none; font: 600 var(--t-12)/1.2 var(--f-ui); color: var(--fg-0); }
.ann-pop-col-h b { font: inherit; }
.ann-pop-search { margin: 8px 8px 4px; width: auto; }
.ann-pop .classes { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow-y: auto; padding: 4px; }
.ann-pop .cls { display: flex; align-items: center; gap: 10px; min-height: 36px; padding: 6px 8px; border: 0; border-radius: var(--r-4); background: transparent; color: var(--fg-1); cursor: pointer; text-align: left; font: inherit; }
.ann-pop .cls:hover { background: var(--bg-2); }
.ann-pop .cls[aria-pressed='true'] { background: var(--bg-3); color: var(--fg-0); }
.ann-pop .cls .cls-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.ann-pop .cls .cls-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ann-pop .cls .cls-meta { color: var(--fg-3); font-size: var(--t-11); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ann-pop .cls kbd { margin-left: auto; font: 500 10.5px/1 var(--f-mono); color: var(--fg-3); border: 1px solid var(--line); border-radius: 3px; padding: 2px 4px; flex: none; }
.ann-pop .new-class { justify-content: flex-start; height: 32px; margin: 4px; padding: 0 8px; color: var(--fg-2); flex: none; }
.ann-pop .sevs { display: flex; flex-direction: column; gap: 4px; overflow-y: auto; padding: 8px; flex: 1; min-height: 0; }
.ann-pop .sev-row { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 1px 8px; align-items: center; text-align: left; min-height: 44px; padding: 6px 8px; border: 1px solid transparent; border-radius: var(--r-4); background: transparent; color: var(--fg-1); font: inherit; cursor: pointer; }
.ann-pop .sev-row:hover { background: var(--bg-2); }
.ann-pop .sev-row[aria-pressed='true'] { background: color-mix(in oklch, var(--sev) 14%, var(--bg-2)); border-color: var(--sev); }
.ann-pop .sev-row .sw { grid-row: span 2; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 4px; background: var(--sev); color: var(--bg-0); font: 600 var(--t-12)/1 var(--f-mono); }
.ann-pop .sev-row.unc .sw { background: repeating-linear-gradient(-45deg, var(--sev) 0 3px, color-mix(in oklch, var(--sev) 35%, var(--bg-1)) 3px 6px); }
.ann-pop .sev-row .lab { font-weight: 600; color: var(--fg-0); }
.ann-pop .sev-row .crit { color: var(--fg-3); font-size: var(--t-11); line-height: 1.3; }
.ann-pop-pad { padding: 8px 10px; }
.ann-pop-error { padding: 0 12px 8px; }
.ann-pop-foot { display: flex; gap: 6px; justify-content: flex-end; padding: 8px 10px; border-top: 1px solid var(--line); flex: none; }
.ann-compose { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; overflow-y: auto; min-height: 0; }
.ann-compose-field { display: flex; flex-direction: column; gap: 4px; font-size: var(--t-11); color: var(--fg-3); }
.ann-compose-field .ann-input { width: 100%; box-sizing: border-box; }
.ann-hotkey { max-width: 88px; }
.ann-swatches { display: flex; flex-wrap: wrap; gap: 6px; }
.ann-swatch { width: 18px; height: 18px; padding: 0; border: 1px solid oklch(0 0 0 / 0.25); border-radius: 4px; cursor: pointer; }
.ann-swatch[aria-pressed='true'] { outline: 2px solid var(--fg-0); outline-offset: 2px; }
.ann-scale { display: flex; flex-direction: column; gap: 2px; }
.ann-scale button { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-height: 32px; padding: 6px 8px; border: 1px solid transparent; border-radius: var(--r-4); background: transparent; color: var(--fg-1); font: inherit; text-align: left; cursor: pointer; }
.ann-scale button:hover { background: var(--bg-2); }
.ann-scale button[aria-checked='true'] { background: var(--bg-3); border-color: var(--line-strong); color: var(--fg-0); }
.ann-scale button span { color: var(--fg-3); font-size: var(--t-11); }
.ann-grades { display: flex; flex-direction: column; gap: 8px; }
.ann-grade { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 4px 8px; align-items: center; }
.ann-grade .sw { grid-row: span 2; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 4px; background: var(--sev); color: var(--bg-0); font: 600 var(--t-12)/1 var(--f-mono); }
.ann-grade .crit { grid-column: 2; }
.ann-video { position: absolute; inset: 0; z-index: 3; }
.ann-video .bar { position: absolute; left: 8px; bottom: 8px; display: flex; gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: var(--r-6); background: var(--scrim); align-items: center; }
`;

/** Renders the stylesheet once per document (React 19 hoists and dedupes by href). */
export function AnnotateStyles() {
  return (
    <style href="aio-annotate" precedence="default">
      {css}
    </style>
  );
}
