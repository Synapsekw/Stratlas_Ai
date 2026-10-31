/**
 * Keeps the QA fitness flags on the open project's measurement results (intelligence review I2,
 * `ComparisonResult.qaFlags`): whenever the QA files, the site's QA level, the survey dates or the
 * measurements change, each result and series row gets the flags of its date (`withQaFlags`).
 * Only once the QA files of the project the measurements are of have been read, so a project
 * whose QA is still loading is never stamped "unchecked". Derived data: nothing is an edit.
 */
import { rmseLimit, withQaFlags, type QaFlagContext } from '@aio/insights';
import { workspace } from '@aio/workspace';
import { measureStore, stampQaFlags } from '../survey/measureStore';
import { qaStore } from '../survey/qaStore';

/** The flag context of the open project, or null while its measurements or QA are not read. */
export function qaFlagContext(): QaFlagContext | null {
  const ms = measureStore.getState();
  const qs = qaStore.getState();
  const project = workspace.getState().project;
  const manifest = project?.manifest;
  if (!project || !manifest || ms.status !== 'ready' || ms.readOnly || !ms.projectId) return null;
  // the open project's id (a working copy's may differ from its manifest's)
  if (ms.projectId !== project.id || qs.loadedFor !== ms.projectId) return null;
  return {
    qa: qs.qa,
    captures: manifest.captures,
    rmseLimitM: rmseLimit(ms.settings.qa.level, ms.settings.qa.rmseM),
  };
}

/** Start keeping the flags; returns the stop. */
export function connectQaFlags(): () => void {
  let busy = false;
  /** What the last stamp was made from (the stores change for many other reasons). */
  let seen: readonly unknown[] = [];
  const look = () => {
    if (busy) return;
    const ctx = qaFlagContext();
    if (!ctx) return;
    const inputs = [
      ctx.qa,
      ctx.captures,
      ctx.rmseLimitM,
      measureStore.getState().file,
      measureStore.getState().projectId,
    ];
    if (inputs.every((x, i) => x === seen[i])) return;
    busy = true;
    try {
      stampQaFlags((r) => withQaFlags(r, ctx));
    } finally {
      busy = false;
    }
    // the stamp gave a new file: remember that one, so it is not looked at twice
    seen = [...inputs.slice(0, 3), measureStore.getState().file, inputs[4]];
  };
  const offs = [measureStore.subscribe(look), qaStore.subscribe(look), workspace.subscribe(look)];
  look();
  return () => {
    for (const off of offs) off();
  };
}
