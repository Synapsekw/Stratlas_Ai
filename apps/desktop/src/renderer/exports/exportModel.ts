import {
  EXPORT_FORMAT_KIND,
  type ExportFormat,
  type Issue,
  type PackageInfo,
  type ProjectManifest,
} from '@aio/schema';
import type { IconName } from '@aio/ui';
import { createStore } from 'zustand/vanilla';

export type ExportActionId = ExportFormat | 'snapshot';

export interface ExportAction {
  id: ExportActionId;
  /** Menu label. */
  label: string;
  /** Command palette title. */
  title: string;
  hint: string;
  icon: IconName;
}

export const EXPORT_ACTIONS: readonly ExportAction[] = [
  {
    id: 'csv',
    label: 'Issues CSV',
    title: 'Export issues as CSV',
    hint: 'Spreadsheet',
    icon: 'download',
  },
  {
    id: 'geojson',
    label: 'GeoJSON',
    title: 'Export issues as GeoJSON',
    hint: 'GIS, WGS84',
    icon: 'map',
  },
  {
    id: 'coco',
    label: 'COCO JSON',
    title: 'Export photo annotations as COCO',
    hint: 'Detection dataset',
    icon: 'photo',
  },
  {
    id: 'kit-json',
    label: 'Kit JSON',
    title: 'Export issues as kit assessment JSON',
    hint: 'Asset Inspection Kit',
    icon: 'download',
  },
  {
    id: 'masks-zip',
    label: 'Masks ZIP',
    title: 'Export photo masks and overlays as ZIP',
    hint: 'PNG masks',
    icon: 'layers',
  },
  {
    id: 'report-pdf',
    label: 'Issue register report (PDF)',
    title: 'Export the issue register report as PDF',
    hint: 'Branded PDF',
    icon: 'report',
  },
  {
    id: 'snapshot',
    label: '3D view snapshot (PNG)',
    title: 'Save a snapshot of the 3D view',
    hint: 'Current camera',
    icon: 'camera',
  },
];

/** Formats that read the photo files of a project folder; a package serves them only in place. */
const NEEDS_FOLDER: readonly ExportActionId[] = ['coco', 'masks-zip'];

/**
 * May this export run with the open project: always for a folder project; inside a package only
 * the kinds its header allows (main checks again), and not the formats that need the folder.
 */
export function actionAllowed(id: ExportActionId, pkg: PackageInfo | null): boolean {
  if (pkg === null) return true;
  if (NEEDS_FOLDER.includes(id)) return false;
  const kind = id === 'snapshot' ? 'snapshot' : EXPORT_FORMAT_KIND[id];
  return pkg.header.exports.includes(kind);
}

/** The export actions offered for the open project (menu, palette). */
export function allowedActions(pkg: PackageInfo | null): readonly ExportAction[] {
  return EXPORT_ACTIONS.filter((a) => actionAllowed(a.id, pkg));
}

export function actionLabel(id: ExportActionId): string {
  return EXPORT_ACTIONS.find((a) => a.id === id)?.label ?? id;
}

export interface LegendEntry {
  label: string;
  color: string;
  count: number;
}

/** Severity legend of a snapshot: levels with issues, worst first, then uncertain. */
export function legendEntries(m: ProjectManifest, issues: readonly Issue[]): LegendEntry[] {
  const out: LegendEntry[] = [];
  let uncertain: LegendEntry | null = null;
  for (const model of m.severityModels) {
    const mine = issues.filter((i) => i.severityModelId === model.id);
    for (const l of [...model.levels].reverse()) {
      const count = mine.filter((i) => i.severity === l.value).length;
      if (count > 0) out.push({ label: l.label, color: l.color, count });
    }
    const u = mine.filter((i) => i.severity === 'uncertain').length;
    if (u > 0) {
      uncertain ??= {
        label: model.uncertain?.label ?? 'Uncertain',
        color: model.uncertain?.color ?? '#b68ef8',
        count: 0,
      };
      uncertain.count += u;
    }
  }
  return uncertain ? [...out, uncertain] : out;
}

const two = (n: number) => String(n).padStart(2, '0');

/** `<project>-3d-view-YYYYMMDD-HHMMSS.png` (UTC). */
export function snapshotName(projectName: string, now: Date): string {
  const base =
    projectName
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  const d = `${String(now.getUTCFullYear())}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}`;
  const t = `${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}`;
  return `${base}-3d-view-${d}-${t}.png`;
}

export function doneMessage(id: ExportActionId, r: { path: string; count?: number }): string {
  if (r.count === undefined || id === 'snapshot') return `Saved to ${r.path}`;
  const what = id === 'masks-zip' ? 'mask files' : r.count === 1 ? 'issue' : 'issues';
  return `${String(r.count)} ${what} saved to ${r.path}`;
}

export type ToastState = 'running' | 'done' | 'error';

export interface Toast {
  id: string;
  title: string;
  state: ToastState;
  phase: string;
  done: number;
  total: number;
  message: string;
}

export interface ToastStore {
  toasts: Toast[];
  start: (id: string, title: string) => void;
  progress: (id: string, phase: string, done: number, total: number) => void;
  finish: (id: string, state: 'done' | 'error', message: string) => void;
  dismiss: (id: string) => void;
}

/** Progress toasts of running and finished exports. */
export function createToastStore() {
  return createStore<ToastStore>()((set) => ({
    toasts: [],
    start: (id, title) => {
      set((s) => ({
        toasts: [
          ...s.toasts.filter((t) => t.id !== id),
          { id, title, state: 'running', phase: 'Starting', done: 0, total: 0, message: '' },
        ],
      }));
    },
    progress: (id, phase, done, total) => {
      set((s) => ({
        toasts: s.toasts.map((t) =>
          t.id === id && t.state === 'running' ? { ...t, phase, done, total } : t,
        ),
      }));
    },
    finish: (id, state, message) => {
      set((s) => ({
        toasts: s.toasts.map((t) => (t.id === id ? { ...t, state, message, phase: '' } : t)),
      }));
    },
    dismiss: (id) => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
  }));
}
