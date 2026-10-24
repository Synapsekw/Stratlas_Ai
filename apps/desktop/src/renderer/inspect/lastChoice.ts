/**
 * The class and severity a person last chose in Inspect, per project, on this computer
 * (`localStorage`, like the detect mode): one key accepts an AI suggestion with it when it fits,
 * and the drawing picker opens on it. Every read and write is in try/catch: a blocked storage
 * only forgets the choice.
 */
import { annotateUi } from '@aio/annotate';
import type { Issue } from '@aio/schema';

export interface Choice {
  classId: string;
  severity: Issue['severity'];
}

const keyOf = (projectId: string) => `quadrion.inspect.last.${projectId}`;

function isChoice(v: unknown): v is Choice {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.classId === 'string' &&
    c.classId !== '' &&
    (typeof c.severity === 'number' || c.severity === 'uncertain')
  );
}

export function lastChoiceFor(projectId: string): Choice | null {
  try {
    const raw = localStorage.getItem(keyOf(projectId));
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    return isChoice(v) ? { classId: v.classId, severity: v.severity } : null;
  } catch {
    return null;
  }
}

function store(projectId: string, c: Choice): void {
  try {
    localStorage.setItem(
      keyOf(projectId),
      JSON.stringify({ classId: c.classId, severity: c.severity }),
    );
  } catch {
    // storage blocked: the choice is not kept
  }
}

/** Keep `c` as the project's last choice; the drawing picker opens on it too. */
export function rememberChoice(projectId: string, c: Choice): void {
  store(projectId, c);
  annotateUi.setState({ lastClassId: c.classId, lastSeverity: c.severity });
}

/** Seed the drawing picker when a project opens in Inspect; record what the picker confirms from then on. Returns the unsubscribe. */
export function trackDrawingChoice(projectId: string): () => void {
  const last = lastChoiceFor(projectId);
  if (last) annotateUi.setState({ lastClassId: last.classId, lastSeverity: last.severity });
  return annotateUi.subscribe((s, prev) => {
    if (s.lastClassId === prev.lastClassId && s.lastSeverity === prev.lastSeverity) return;
    if (!s.lastClassId || s.lastSeverity === null) return;
    store(projectId, { classId: s.lastClassId, severity: s.lastSeverity });
  });
}
