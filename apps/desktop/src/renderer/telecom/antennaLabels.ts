import type { EngineStage } from '@aio/engine';
import type { AntennaLabelSpot } from './antennaVisibility';
import { projectToHost } from './screenProjection';

/** The screen shift that puts a label where its `align` says, after the move to its anchor. */
const ALIGN: Record<NonNullable<AntennaLabelSpot['align']>, string> = {
  above: ' translate(-50%, calc(-100% - 4px))',
  below: ' translate(-50%, 4px)',
  centre: ' translate(-50%, -50%)',
};

/** Where `.sv-label`'s margin (measure.css: -24px 0 0 6px) puts a label beside its anchor. */
const BESIDE = { x: 6, y: -24 };

/** The gap a name label keeps above its unit's size labels, px. */
const NAME_GAP_PX = 2;

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

  /** A pin that would sit on a selected unit's label gives way: it hides while they overlap. */
  const hidePinsUnderSelected = () => {
    const sel: DOMRect[] = [];
    for (const el of labels.querySelectorAll<HTMLElement>('.sv-label.sel')) {
      if (el.style.display !== 'none') sel.push(el.getBoundingClientRect());
    }
    if (sel.length === 0) return;
    for (const el of labels.querySelectorAll<HTMLElement>('.antenna-label--pin')) {
      if (el.style.display === 'none') continue;
      const p = el.getBoundingClientRect();
      if (
        sel.some(
          (s) => p.left < s.right && p.right > s.left && p.top < s.bottom && p.bottom > s.top,
        )
      )
        el.style.display = 'none';
    }
  };

  /**
   * A selected unit's name label steps up clear of its own size labels: zoomed out, the width
   * label beside the top edge's end reaches up into the name above the box.
   */
  const liftNames = () => {
    for (const name of labels.querySelectorAll<HTMLElement>('.antenna-label--name')) {
      const key = name.dataset.key ?? '';
      if (name.style.display === 'none' || !key.endsWith(':name')) continue;
      const unit = key.slice(0, -':name'.length);
      const n = name.getBoundingClientRect();
      let lift = 0;
      for (const d of labels.querySelectorAll<HTMLElement>('.antenna-label--dim')) {
        if (d.style.display === 'none' || !(d.dataset.key ?? '').startsWith(`${unit}:dim:`))
          continue;
        const r = d.getBoundingClientRect();
        const meets = n.left < r.right && n.right > r.left && n.top < r.bottom && n.bottom > r.top;
        if (meets) lift = Math.max(lift, n.bottom - r.top + NAME_GAP_PX);
      }
      if (lift > 0) name.style.transform += ` translateY(-${String(Math.ceil(lift))}px)`;
    }
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
      // a pin is centred on its anchor whatever the spot says
      const align = sp.align ?? (pin ? 'centre' : undefined);
      if (align) el.dataset.align = align;
      else delete el.dataset.align;
      if (el.textContent !== sp.text) el.textContent = sp.text;
      if (pin) {
        if (sp.unitId !== undefined) el.dataset.unitId = sp.unitId;
        if (sp.title !== undefined && el.title !== sp.title) el.title = sp.title;
        if (sp.colour !== undefined) el.style.background = sp.colour;
      } else el.style.fontSize = '12px';
      let at = projectToHost(sp.at, stage.camera, r, hr);
      if (sp.orAt) {
        // two ends: the one further right on screen (seen from behind, the other end)
        const other = projectToHost(sp.orAt, stage.camera, r, hr);
        if (other.front && (!at.front || other.x > at.x)) at = other;
      }
      // the angle label stays in view: its anchor (the facing arrow's tip) may be off the side
      const keep = sp.kind === 'angle' && !align && at.front && hr.width > 0 && hr.height > 0;
      if (!at.inside && !keep) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      if (keep) {
        const size = el.getBoundingClientRect();
        // `.sv-label`'s offset puts the box at (x + 6, y - 24): hold that box inside the host
        const left = Math.max(0, Math.min(at.x + BESIDE.x, hr.width - size.width));
        const top = Math.max(0, Math.min(at.y + BESIDE.y, hr.height - size.height));
        at.x = left - BESIDE.x;
        at.y = top - BESIDE.y;
      }
      const to = `translate(${String(Math.round(at.x))}px, ${String(Math.round(at.y))}px)`;
      // an aligned label is placed by its align; any other sits beside it (.sv-label's margin)
      el.style.transform = align ? to + ALIGN[align] : to;
    }
    liftNames();
    hidePinsUnderSelected();
  };

  const off = stage.onFrame(place);
  return () => {
    off();
    labels.remove();
    els.clear();
  };
}
