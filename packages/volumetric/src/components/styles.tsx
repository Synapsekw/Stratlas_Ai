/**
 * Mission styling for the volumetric workspace (tokens from packages/ui/src/tokens.css). Cut is
 * orange and fill blue, as in the Volumetric Survey Kit; the accent marks the selection.
 */
const css = `
.vol-panel { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; color: var(--fg-1); font: 400 var(--t-13)/1.4 var(--f-ui); }
.vol-sec { padding: 12px; border-bottom: 1px solid var(--line-soft); display: grid; gap: 10px; }
.vol-sec h3 { margin: 0; font: 600 var(--t-11)/1.2 var(--f-ui); letter-spacing: .07em; text-transform: uppercase; color: var(--fg-2); }
.vol-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.vol-ctl { flex-wrap: wrap; justify-content: flex-start; }
.vol-acts { justify-content: flex-start; }
.vol-note { margin: 0; font-size: var(--t-12); color: var(--fg-3); line-height: 1.45; }
.vol-note.pad { padding: 16px 12px; }
.vol-note b { color: var(--fg-1); font-weight: 600; }
.vol-seg button { height: 24px; font: 500 var(--t-12)/1 var(--f-mono); }
.vol-base { display: inline-flex; align-items: center; gap: 6px; font-size: var(--t-11); color: var(--fg-3); }
.vol-base select { height: 24px; padding: 0 6px; border: 1px solid var(--line); border-radius: var(--r-4); background: var(--bg-2); color: var(--fg-0); font: 400 var(--t-12)/1 var(--f-ui); }
.vol-kpis { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--line-soft); border-radius: var(--r-4); }
.vol-kpis > div { padding: 8px 10px; min-width: 0; display: grid; gap: 1px; }
.vol-kpis > div:nth-child(even) { border-left: 1px solid var(--line-soft); }
.vol-kpis > div:nth-child(n+3) { border-top: 1px solid var(--line-soft); }
.vol-kpis span { font-size: var(--t-11); color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vol-kpis b { font: 500 var(--t-16)/1.25 var(--f-mono); color: var(--fg-0); white-space: nowrap; }
.vol-kpis small { font: 400 var(--t-11)/1.2 var(--f-mono); color: var(--fg-3); }
.vol-kpis .vol-hot b { color: var(--acc-strong); }
.vol-kpis .vol-cut b, .vol-facts .vol-cut, .vol-reg td.vol-cut, .vol-secpanel .vol-cut { color: #e8794f; }
.vol-kpis .vol-fill b, .vol-facts .vol-fill, .vol-reg td.vol-fill, .vol-secpanel .vol-fill { color: #6aa6e8; }
.vol-reg { width: 100%; border-collapse: collapse; font: 400 var(--t-12)/1 var(--f-mono); font-variant-numeric: tabular-nums; }
.vol-reg th { padding: 0; border-bottom: 1px solid var(--line); text-align: right; }
.vol-reg th:first-child { text-align: left; }
.vol-reg th button { all: unset; box-sizing: border-box; display: inline-flex; gap: 3px; align-items: center; width: 100%; justify-content: inherit; height: 26px; padding: 0 6px; cursor: pointer; font: 600 var(--t-11)/1 var(--f-ui); letter-spacing: .04em; text-transform: uppercase; color: var(--fg-3); }
.vol-reg th:first-child button { justify-content: flex-start; }
.vol-reg th:not(:first-child) button { justify-content: flex-end; }
.vol-reg th[aria-sort='ascending'] button, .vol-reg th[aria-sort='descending'] button { color: var(--fg-0); }
.vol-reg th button:focus-visible { outline: 2px solid var(--acc); outline-offset: -2px; }
.vol-reg th i { font-style: normal; font-size: 8px; }
.vol-reg td { padding: 0 6px; height: 26px; text-align: right; color: var(--fg-1); border-bottom: 1px solid var(--line-soft); }
.vol-reg td.id { text-align: left; color: var(--fg-0); font-weight: 600; }
.vol-reg td.net { color: var(--fg-0); }
.vol-reg td.vol-flat { color: var(--fg-3); }
.vol-reg tbody tr { cursor: pointer; }
.vol-reg tbody tr:hover { background: var(--bg-2); }
.vol-reg tbody tr[aria-selected='true'] { background: var(--acc-a12); box-shadow: inset 2px 0 0 var(--acc); }
.vol-reg tbody tr:focus-visible { outline: 2px solid var(--acc); outline-offset: -2px; }
.vol-reg tbody tr.absent td:not(.id) { color: var(--fg-4); }
.vol-reg th:first-child { white-space: nowrap; }
.vol-reg th:first-child button:not(.vol-eye) { width: auto; vertical-align: middle; }
.vol-reg th button.vol-eye, .vol-reg td button.vol-eye { all: unset; box-sizing: border-box; display: inline-grid; place-items: center; width: 22px; height: 22px; margin-right: 4px; border-radius: 4px; color: var(--fg-2); cursor: pointer; vertical-align: middle; flex: none; }
.vol-reg button.vol-eye[aria-pressed='false'] { color: var(--fg-4); }
.vol-reg button.vol-eye:hover { background: var(--bg-3); color: var(--fg-0); }
.vol-reg button.vol-eye:focus-visible { outline: 2px solid var(--acc); outline-offset: -2px; }
.vol-reg td.id { white-space: nowrap; }
.vol-reg .vol-hidden-n { color: var(--fg-3); font-weight: 400; }
.vol-reg tfoot td { border-bottom: 0; border-top: 1px solid var(--line); color: var(--fg-0); font-weight: 600; }
.vol-reg tfoot td:first-child { text-align: left; color: var(--fg-3); font-weight: 400; }
.vol-ed { display: inline-block; width: 6px; height: 6px; margin-left: 6px; border-radius: 50%; background: var(--s3); vertical-align: 1px; }
.vol-nav { grid-template-columns: auto 1fr; align-items: center; }
.vol-pn { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.vol-pid { font: 600 var(--t-20)/1 var(--f-mono); color: var(--fg-0); min-width: 52px; text-align: center; }
.vol-pill { font: 600 10.5px/1 var(--f-ui); letter-spacing: .06em; text-transform: uppercase; padding: 4px 7px; border-radius: var(--r-2); border: 1px solid var(--line); color: var(--fg-2); }
.vol-pill.vol-cut { color: #e8794f; border-color: #e8794f66; }
.vol-pill.vol-fill { color: #6aa6e8; border-color: #6aa6e866; }
.vol-pill.edit { color: var(--s3); border-color: var(--s3-a); }
.vol-dens { display: flex; align-items: center; gap: 8px; font-size: var(--t-12); color: var(--fg-2); }
.vol-dens input { width: 64px; height: 24px; padding: 0 6px; border: 1px solid var(--line); border-radius: var(--r-4); background: var(--bg-2); color: var(--fg-0); font: 400 var(--t-12)/1 var(--f-mono); }
.vol-dens span { color: var(--fg-3); font-size: var(--t-11); }
.vol-steps { margin: 0; padding-left: 18px; font-size: var(--t-12); color: var(--fg-1); display: grid; gap: 3px; }
.vol-bars { display: grid; gap: 2px; }
.vol-bars button { all: unset; box-sizing: border-box; display: grid; grid-template-columns: 1fr 90px 56px; align-items: center; gap: 10px; height: 28px; padding: 0 6px; border-radius: var(--r-4); cursor: pointer; font-size: var(--t-12); color: var(--fg-1); }
.vol-bars button:hover { background: var(--bg-2); }
.vol-bars button[aria-pressed='true'] { color: var(--fg-0); font-weight: 600; background: var(--bg-2); }
.vol-bars button:focus-visible { outline: 2px solid var(--acc); outline-offset: -2px; }
.vol-bars .vol-bar { position: relative; height: 4px; border-radius: 2px; background: var(--line-soft); overflow: hidden; }
.vol-bars .vol-bar i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--fg-3); }
.vol-bars button[aria-pressed='true'] .vol-bar i { background: var(--acc); }
.vol-bars .v { text-align: right; font: 500 var(--t-12)/1 var(--f-mono); }
.vol-chg { display: grid; gap: 1px; }
.vol-chg button { all: unset; box-sizing: border-box; display: grid; grid-template-columns: 40px 1fr 64px; gap: 10px; align-items: center; height: 24px; padding: 0 6px; border-radius: var(--r-4); cursor: pointer; font: 500 var(--t-12)/1 var(--f-mono); color: var(--fg-1); }
.vol-chg button:hover { background: var(--bg-2); }
.vol-chg button:focus-visible { outline: 2px solid var(--acc); outline-offset: -2px; }
.vol-chg b { color: var(--fg-0); }
.vol-chg .v { text-align: right; }
.vol-cbar { position: relative; height: 8px; }
.vol-cbar::after { content: ''; position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px; background: var(--line-strong); }
.vol-cbar i { position: absolute; top: 0; bottom: 0; border-radius: 1px; }
.vol-cbar i.c { right: 50%; background: #e8794f; }
.vol-cbar i.f { left: 50%; background: #6aa6e8; }
.vol-facts { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; margin: 0; font-size: var(--t-12); }
.vol-facts dt { color: var(--fg-3); }
.vol-facts dd { margin: 0; text-align: right; font-family: var(--f-mono); color: var(--fg-1); }
.vol-chart { display: block; width: 100%; }
.vol-stage { position: absolute; inset: 0; pointer-events: none; z-index: 5; overflow: hidden; }
.vol-stage > * { pointer-events: auto; }
.vol-handles { position: absolute; inset: 0; pointer-events: none; }
.vol-vh, .vol-mh { position: absolute; left: 0; top: 0; pointer-events: auto; padding: 0; cursor: grab; touch-action: none; }
.vol-vh { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #b00; background: #fff; box-shadow: 0 1px 4px oklch(0 0 0 / .5); }
.vol-vh.sel { background: #ffd23f; border-color: #6b4e00; }
.vol-vh:focus-visible { outline: 2px solid var(--acc); }
.vol-mh { width: 9px; height: 9px; border-radius: 50%; border: 1.5px solid #ffffffcc; background: #ffffff33; }
.vol-mh:hover, .vol-vh:hover { transform-origin: center; filter: brightness(1.2); }
.vol-under { position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; align-items: flex-end; justify-content: center; gap: 12px; pointer-events: none; }
.vol-under > * { pointer-events: auto; }
.vol-editbar { display: flex; align-items: center; gap: 16px; padding: 10px 12px; background: var(--bg-1); border-color: var(--line-strong); box-shadow: 0 12px 32px oklch(0 0 0 / .45); }
.vol-eb-t { display: grid; gap: 2px; min-width: 180px; }
.vol-eb-t span { font: 600 var(--t-11)/1.2 var(--f-ui); letter-spacing: .07em; text-transform: uppercase; color: #ffd23f; }
.vol-eb-t b { font: 500 var(--t-20)/1.2 var(--f-mono); color: var(--fg-0); }
.vol-eb-t small { font-size: var(--t-11); color: var(--fg-3); }
.vol-eb-a { display: flex; gap: 6px; }
.vol-secpanel { width: min(440px, 100%); padding: 10px 12px; display: grid; gap: 8px; background: var(--bg-1); border-color: var(--line-strong); box-shadow: 0 12px 32px oklch(0 0 0 / .45); margin-right: auto; }
.vol-secpanel b { font: 600 var(--t-12)/1 var(--f-ui); color: var(--fg-0); }
.vol-legend { position: absolute; left: 12px; bottom: 56px; display: grid; gap: 4px; padding: 8px 10px; font-size: var(--t-11); color: var(--fg-1); background: var(--scrim); max-width: 220px; pointer-events: none; }
.vol-stage:has(.vol-secpanel) .vol-legend, .vol-stage:has(.vol-editbar) .vol-legend { display: none; }
.vol-legend b { font-weight: 600; color: var(--fg-0); }
.vol-legend .ramp { height: 8px; border-radius: 2px; width: 180px; }
.vol-legend .ends { display: flex; justify-content: space-between; font-family: var(--f-mono); color: var(--fg-2); }
.vol-legend .key { display: flex; align-items: center; gap: 6px; }
.vol-legend .key i { width: 12px; height: 8px; border-radius: 1px; }
.vol-legend .key i.line { height: 2px; background: #fff; }
.vol-swipe { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--ov); box-shadow: 0 0 0 1px oklch(0 0 0 / .35); cursor: ew-resize; touch-action: none; }
.vol-swipe .knob { position: absolute; top: 50%; left: 50%; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%; display: grid; place-items: center; background: var(--bg-1); color: var(--fg-0); border: 1px solid var(--line-strong); }
.vol-swipe:focus-visible .knob { outline: 2px solid var(--acc); }
.vol-swipe-lbl { position: absolute; top: 56px; font: 600 var(--t-11)/1 var(--f-ui); letter-spacing: .07em; text-transform: uppercase; color: var(--ov); background: var(--scrim); padding: 5px 8px; border-radius: var(--r-4); pointer-events: none; }
.vol-swipe-lbl.vol-l { left: 12px; }
.vol-swipe-lbl.vol-r { right: 12px; }
.vol-toast { position: absolute; left: 50%; top: 60px; transform: translateX(-50%); padding: 7px 12px; border-radius: var(--r-4); background: var(--bg-3); border: 1px solid var(--line-strong); color: var(--fg-0); font-size: var(--t-12); box-shadow: 0 8px 24px oklch(0 0 0 / .4); pointer-events: none; }
`;

/** Renders the stylesheet once per document (React 19 hoists and dedupes by href). */
export function VolumetricStyles() {
  return (
    <style href="aio-volumetric" precedence="default">
      {css}
    </style>
  );
}
