import type { EngineStage } from '@aio/engine';
import { Vector3 } from 'three';
import type { Frame } from '../survey/measureScene';
import type { AntennaLabelSpot } from './antennaVisibility';

/**
 * The antenna labels in the 3D view: one `.sv-label` per spot in a `.sv-labels` layer beside the
 * canvas, moved on every frame. Spots are in the local frame already. Returns the detach.
 */
export function attachAntennaLabels(
  stage: EngineStage,
  _frame: Frame,
  getSpots: () => AntennaLabelSpot[],
): () => void {
  const canvas = stage.renderer.domElement;
  const host = canvas.parentElement ?? canvas;
  const labels = document.createElement('div');
  labels.className = 'sv-labels antenna-labels';
  labels.setAttribute('aria-hidden', 'true');
  host.appendChild(labels);
  const tmp = new Vector3();
  const els = new Map<string, HTMLElement>();

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
        el = document.createElement('span');
        el.dataset.key = sp.key;
        els.set(sp.key, el);
      }
      labels.appendChild(el); // keeps the spots' order
      el.className = `sv-label antenna-label--${sp.kind}${sp.selected ? ' sel' : ''}`;
      if (el.textContent !== sp.text) el.textContent = sp.text;
      el.style.fontSize = sp.kind === 'name' && !sp.selected ? '11px' : '12px';
      tmp.set(sp.at[0], sp.at[1], sp.at[2]).project(stage.camera);
      const x = r.left + ((tmp.x + 1) / 2) * r.width;
      const y = r.top + ((1 - tmp.y) / 2) * r.height;
      if (tmp.z > 1 || x < r.left || x > r.right || y < r.top || y > r.bottom) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.transform = `translate(${String(Math.round(x - hr.left))}px, ${String(Math.round(y - hr.top))}px)`;
    }
  };

  const off = stage.onFrame(place);
  return () => {
    off();
    labels.remove();
    els.clear();
  };
}
