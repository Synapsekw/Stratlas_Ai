/**
 * Window context for the agent: a small JSON snapshot of what the person sees, sent with every
 * message (AI-4). Pure functions over the workspace state so they are easy to test.
 */
import type { Layer, WindowKind } from '@aio/schema';
import type { Selection, WorkspaceState } from '@aio/workspace';
import { WINDOW_LABELS } from './prompt';

const MAX_LAYERS = 40;

export function formatClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

type VideoLayer = Extract<Layer, { kind: 'video' }>;

export function clipStartUtcMs(layer: VideoLayer): number {
  return layer.flight.startUtcMs + layer.offsetMs;
}

function layers(state: WorkspaceState): Layer[] {
  return state.project?.manifest.layers ?? [];
}

export function selectionLabel(state: WorkspaceState, sel: Selection): string {
  if (sel.kind === 'issue') return state.issues.find((i) => i.id === sel.id)?.code ?? sel.id;
  if (sel.kind === 'clip' || sel.kind === 'layer')
    return layers(state).find((l) => l.id === sel.id)?.name ?? sel.id;
  return sel.id;
}

function countBy<T>(items: readonly T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) {
    const k = key(i);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

const MAX_CRITERIA = 120;

export interface SeverityLevelsOfModel {
  model: string;
  levels: { value: number; label: string; criteria?: string }[];
  uncertain?: string;
}

/**
 * The names of the project's severity levels, so the agent says "S4" and maps "the worst" to a
 * level that exists. Text only; a long criterion is cut so the context stays small.
 */
function severityLevels(state: WorkspaceState): SeverityLevelsOfModel[] {
  return (state.project?.manifest.severityModels ?? []).map((m) => ({
    model: m.id,
    levels: [...m.levels]
      .sort((a, b) => a.value - b.value)
      .map((l) => ({
        value: l.value,
        label: l.label,
        ...(l.criteria ? { criteria: l.criteria.slice(0, MAX_CRITERIA) } : {}),
      })),
    ...(m.uncertain ? { uncertain: m.uncertain.label } : {}),
  }));
}

export function assembleContext(
  state: WorkspaceState,
  window: WindowKind,
): Record<string, unknown> {
  const project = state.project;
  if (!project) {
    return { window, project: null, selection: null, note: 'No project is open.' };
  }
  // A retired viewer of an older project is no layer the assistant can use.
  const all = layers(state).filter((l) => l.kind !== 'legacy');
  const clip = all.find((l): l is VideoLayer => l.kind === 'video' && l.id === state.activeClip);
  const visible = all.filter((l) => !state.hidden[l.id]);
  const open = state.issues.filter((i) => i.status !== 'closed');
  const sel = state.selection;
  return {
    window,
    project: {
      name: project.manifest.name,
      ...(project.manifest.customer ? { customer: project.manifest.customer } : {}),
      ...(project.manifest.site ? { site: project.manifest.site } : {}),
    },
    time: {
      nowUtc: new Date(state.nowMs).toISOString(),
      nowMs: state.nowMs,
      playing: state.playing,
      rate: state.rate,
    },
    activeClip: clip
      ? {
          id: clip.id,
          name: clip.name,
          atSeconds: Math.round((state.nowMs - clipStartUtcMs(clip)) / 100) / 10,
        }
      : null,
    selection: sel
      ? {
          kind: sel.kind,
          id: sel.id,
          label: selectionLabel(state, sel),
          ...(sel.layer ? { layer: sel.layer } : {}),
        }
      : null,
    layers: {
      visible: visible.slice(0, MAX_LAYERS).map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
      hiddenCount: all.length - visible.length,
      total: all.length,
    },
    counts: {
      layersByKind: countBy(all, (l) => l.kind),
      clips: all.filter((l) => l.kind === 'video').length,
      issues: state.issues.length,
      issuesByStatus: countBy(state.issues, (i) => i.status),
      openIssuesBySeverity: countBy(open, (i) => String(i.severity)),
    },
    severityLevels: severityLevels(state),
  };
}

/** "3D view, 20-T-0002, 15:11:26": the chip that shows what the agent is bound to. */
export function bindingLabel(window: WindowKind, state: WorkspaceState): string {
  const parts = [WINDOW_LABELS[window]];
  if (state.selection) parts.push(selectionLabel(state, state.selection));
  if (state.project) parts.push(formatClock(state.nowMs));
  return parts.join(', ');
}
