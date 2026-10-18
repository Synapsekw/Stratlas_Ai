import type { EngineStage } from '@aio/engine';
import type { AntennaLabelSpot } from './antennaVisibility';
import { projectToHost } from './screenProjection';

/**
 * The antenna labels in the 3D view: one `.sv-label` per spot in a `.sv-labels` layer beside the
 * canvas, moved on every frame. Spots are in the local frame already. Returns the detach.
 */
export function attachAntennaLabels(
  stage: EngineStage,
  getSpots: () => AntennaLabelSpot[],
): () => void {
  const canvas = stage.renderer.domElement;
  const host = canvas.parentElement ?? canvas;
  const labels = document.createElement('div');
  labels.className = 'sv-labels antenna-labels';
  labels.setAttribute('aria-hidden', 'true');
  host.appendChild(labels);
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
      const at = projectToHost(sp.at, stage.camera, r, hr);
      if (!at.inside) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.transform = `translate(${String(Math.round(at.x))}px, ${String(Math.round(at.y))}px)`;
    }
  };

  const off = stage.onFrame(place);
  return () => {
    off();
    labels.remove();
    els.clear();
  };
}
