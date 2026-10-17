/**
 * How the Coverage layer is shown (spec D23a): on or off (the eye hides the map and the scene
 * layer together), its opacity (60% by default), the optional hatch (D26) and "Show from". The
 * layer is not a manifest layer (D12), so its display state is kept per project on this machine,
 * like the stage layout. The legend's slider and the Display bench row edit the same state.
 */
import { createStore, useStore } from 'zustand';
import { browserStorage, type PanelStorage } from '../panelPrefs';
import { SHOW_FROM, type ShowFrom } from './coverageRamp';

export interface RfLayerDisplay {
  visible: boolean;
  /** 0 to 1. */
  opacity: number;
  hatch: boolean;
  showFrom: ShowFrom;
}

export const DEFAULT_RF_LAYER: RfLayerDisplay = {
  visible: true,
  opacity: 0.6,
  hatch: false,
  showFrom: 'all',
};

const KEY = 'quadrion.rfLayer';

export interface RfLayerState extends RfLayerDisplay {
  projectId: string | null;
}

export const rfLayer = createStore<RfLayerState>()(() => ({
  ...DEFAULT_RF_LAYER,
  projectId: null,
}));

export function useRfLayer<T>(selector: (s: RfLayerState) => T): T {
  return useStore(rfLayer, selector);
}

/** A stored display, field by field; anything else falls back to the default. */
export function parseRfLayer(v: unknown): RfLayerDisplay {
  if (!v || typeof v !== 'object') return { ...DEFAULT_RF_LAYER };
  const r = v as Record<string, unknown>;
  const op = r.opacity;
  return {
    visible: typeof r.visible === 'boolean' ? r.visible : DEFAULT_RF_LAYER.visible,
    opacity:
      typeof op === 'number' && Number.isFinite(op)
        ? Math.min(1, Math.max(0, op))
        : DEFAULT_RF_LAYER.opacity,
    hatch: typeof r.hatch === 'boolean' ? r.hatch : DEFAULT_RF_LAYER.hatch,
    showFrom: SHOW_FROM.includes(r.showFrom as ShowFrom)
      ? (r.showFrom as ShowFrom)
      : DEFAULT_RF_LAYER.showFrom,
  };
}

let storage: PanelStorage | null = browserStorage();
/** Tests swap the storage. */
export function setRfLayerStorage(s: PanelStorage | null): void {
  storage = s;
}

function readAll(): Record<string, unknown> {
  try {
    const raw = storage?.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Show the display this machine remembers for a project (the default when none). */
export function loadRfLayer(projectId: string | null): void {
  const d = projectId ? parseRfLayer(readAll()[projectId]) : { ...DEFAULT_RF_LAYER };
  rfLayer.setState({ ...d, projectId });
}

export function setRfLayer(patch: Partial<RfLayerDisplay>): void {
  const next = { ...rfLayer.getState(), ...patch };
  if (patch.opacity !== undefined) next.opacity = Math.min(1, Math.max(0, patch.opacity));
  rfLayer.setState(next);
  const id = next.projectId;
  if (!id) return;
  try {
    const all = readAll();
    const { visible, opacity, hatch, showFrom } = next;
    all[id] = { visible, opacity, hatch, showFrom };
    storage?.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage full or blocked: the choice lasts for this session
  }
}
