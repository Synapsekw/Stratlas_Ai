/**
 * Styling of the volumetric overlay in 3D and the drawn section's panel (tokens from
 * packages/ui/src/tokens.css): cut and fill in the app's `--cut` / `--fill`, the accent marks the
 * selection.
 */
const css = `
.vol-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); min-width: 0; }
.vol-note { margin: 0; font-size: var(--t-12); color: var(--fg-3); line-height: 1.45; }
.vol-note b { color: var(--fg-1); font-weight: 600; }
.vol-stage { position: absolute; inset: 0; pointer-events: none; z-index: 5; overflow: hidden; }
.vol-stage > * { pointer-events: auto; }
.vol-under { position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; align-items: flex-end; justify-content: center; gap: var(--sp-5); pointer-events: none; }
.vol-under > * { pointer-events: auto; }
.vol-secpanel { width: min(440px, 100%); padding: 10px 12px; display: grid; gap: var(--sp-4); background: var(--bg-1); border-color: var(--line-strong); box-shadow: 0 12px 32px oklch(0 0 0 / .45); margin-right: auto; }
.vol-secpanel b { font: 600 var(--t-12)/1 var(--f-ui); color: var(--fg-0); }
.vol-secpanel .vol-cut { color: var(--cut); }
.vol-secpanel .vol-fill { color: var(--fill); }
.vol-legend { position: absolute; left: 12px; bottom: 56px; display: grid; gap: var(--sp-2); padding: 8px 10px; font-size: var(--t-11); color: var(--fg-1); background: var(--scrim); max-width: 220px; pointer-events: none; }
.vol-legend b { font-weight: 600; color: var(--fg-0); }
.vol-legend .ramp { height: 8px; border-radius: 2px; width: 180px; }
.vol-legend .ends { display: flex; justify-content: space-between; font-family: var(--f-mono); color: var(--fg-2); }
.vol-legend .key { display: flex; align-items: center; gap: var(--sp-3); }
.vol-legend .key i { width: 12px; height: 8px; border-radius: 1px; }
.vol-legend .key i.line { height: 2px; background: var(--ov); }
/* the 3D volume body (red) and its pale base plate (scene/controller.ts) */
.vol-legend .key i.vol-key-body { background: var(--danger); }
.vol-legend .key i.vol-key-base { background: var(--fg-1); }
.vol-legend.live { pointer-events: auto; max-width: 240px; }
.vol-legend.vol-hint { max-width: 300px; color: var(--fg-2); line-height: 1.45; font-size: var(--t-12); }
.vol-legend-note { color: var(--fg-2); line-height: 1.45; }
.vol-elev { display: grid; gap: var(--sp-3); padding-bottom: 4px; }
.vol-elev .ramp { width: 100%; height: 10px; }
.vol-elev-note { color: var(--fg-3); }
.vol-hs { display: inline-flex; align-items: center; gap: var(--sp-2); color: var(--fg-2); cursor: pointer; }
.vol-hs input { margin: 0; accent-color: var(--acc); }
.vol-ramps { display: grid; grid-template-columns: repeat(6, 1fr); gap: var(--sp-2); }
.vol-ramps button { all: unset; box-sizing: border-box; height: 14px; border-radius: 2px; cursor: pointer; border: 1px solid oklch(0 0 0 / .4); }
.vol-ramps button[aria-checked='true'] { outline: 2px solid var(--acc); outline-offset: 1px; }
.vol-ramps button:focus-visible { outline: 2px solid var(--fg-0); outline-offset: 1px; }
.vol-rng { display: grid; grid-template-columns: 34px 1fr; align-items: center; gap: var(--sp-3); color: var(--fg-2); }
.vol-rng input { width: 100%; margin: 0; accent-color: var(--acc); }
.vol-elev .btn { justify-self: start; }
.vol-elev .btn[aria-pressed='true'] { color: var(--acc-strong); }
.vol-swipe { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--ov); box-shadow: 0 0 0 1px oklch(0 0 0 / .35); cursor: ew-resize; touch-action: none; }
.vol-swipe .knob { position: absolute; top: 50%; left: 50%; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%; display: grid; place-items: center; background: var(--bg-1); color: var(--fg-0); border: 1px solid var(--line-strong); }
.vol-swipe:focus-visible .knob { outline: 2px solid var(--acc); }
.vol-swipe-lbl { position: absolute; top: 56px; font: 600 var(--t-11)/1 var(--f-ui); letter-spacing: .07em; text-transform: uppercase; color: var(--ov); background: var(--scrim); padding: 5px 8px; border-radius: var(--r-4); pointer-events: none; }
.vol-swipe-lbl.vol-l { left: 12px; }
.vol-swipe-lbl.vol-r { right: 12px; }
/* Cut / fill's From and To surveys (the desktop's Volume tools) */
.vol-pair { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: var(--sp-2) var(--sp-4); }
.vol-pair-lbl { font-size: var(--t-11); color: var(--fg-3); }
.vol-pair-src { grid-column: 1 / -1; margin: 0; font-size: var(--t-11); color: var(--fg-3); }
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
