import type { EngineStage } from '@aio/engine';
import type { AntennaLabelSpot } from './antennaVisibility';
import { projectToHost } from './screenProjection';

/** Pointer events a pin keeps to itself, so the stage under it never sees a pin click. */
const PIN_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick'];

/**
 * The antenna labels in the 3D view: one `.sv-label` per spot in a `.sv-labels` layer beside the
 * canvas, moved on every frame. Spots are in the local frame already. A pin (a unit that is not
 * selected) takes clicks: `onPick` hears its unit id, and the click goes no further. Returns the
 * detach.
 */
export function attachAntennaLabels(
  stage: EngineStage,
  getSpots: () => AntennaLabelSpot[],
  onPick?: (unitId: string) => void,
): () => void {
  const canvas = stage.renderer.domElement;
  const host = canvas.parentElement ?? canvas;
  const labels = document.createElement('div');
  labels.className = 'sv-labels antenna-labels';
  // the inventory lists every unit for assistive technology; the pins are a pointer shortcut
  labels.setAttribute('aria-hidden', 'true');
  host.appendChild(labels);
  const els = new Map<string, HTMLElement>();

  const onPin = (e: Event) => {
    e.stopPropagation();
    if (e.type !== 'click') return;
    const id = (e.currentTarget as HTMLElement).dataset.unitId;
    if (id) onPick?.(id);
  };

  const make = (sp: AntennaLabelSpot): HTMLElement => {
    const el = document.createElement('span');
    el.dataset.key = sp.key;
    if (sp.kind === 'pin') for (const type of PIN_EVENTS) el.addEventListener(type, onPin);
    return el;
  };

  const place = () => {
    const spots = getSpots();
    const live = new Set(spots.map((s) => s.key));
    for (const [key, el] of els) {
      if (!live.has(key)) {
        el.remove();
        els.delete(key);
      }
    }
    const r = canvas.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    for (const sp of spots) {
      let el = els.get(sp.key);
      if (!el) {
        el = make(sp);
        els.set(sp.key, el);
      }
      labels.appendChild(el); // keeps the spots' order
      const pin = sp.kind === 'pin';
      el.className = `sv-label antenna-label--${sp.kind}${sp.selected ? ' sel' : ''}`;
      if (el.textContent !== sp.text) el.textContent = sp.text;
      if (pin) {
        if (sp.unitId !== undefined) el.dataset.unitId = sp.unitId;
        if (sp.title !== undefined && el.title !== sp.title) el.title = sp.title;
        if (sp.colour !== undefined) el.style.background = sp.colour;
      } else el.style.fontSize = '12px';
      const at = projectToHost(sp.at, stage.camera, r, hr);
      if (!at.inside) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      const to = `translate(${String(Math.round(at.x))}px, ${String(Math.round(at.y))}px)`;
      // a pin is centred on its anchor; a label sits beside it (.sv-label's margin)
      el.style.transform = pin ? `${to} translate(-50%, -50%)` : to;
    }
  };

  const off = stage.onFrame(place);
  return () => {
    off();
    labels.remove();
    els.clear();
  };
}
