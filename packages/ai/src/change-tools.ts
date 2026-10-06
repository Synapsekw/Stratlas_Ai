/**
 * Executors of the change tools (M8 stream C1): `list_changes`, `show_change`,
 * `run_change_detection`, and the change-set reading `compare_captures` uses. Change sets come
 * from main through `window.aio` (`change:list`, `change:read`, `change:compute`).
 */
import type { AioBridge, ChangeItem, ChangeSet } from '@aio/schema';
import { changeToolInputs, type ChangeToolName } from './change-tool-specs';
import {
  project,
  registerRendererTool,
  ToolError,
  type RendererToolContext,
  type ToolRunResult,
} from './tool-kit';

interface CaptureRef {
  id: string;
  label: string;
  date: string;
}

function bridge(): AioBridge {
  const aio = (globalThis as { aio?: AioBridge }).aio;
  if (!aio) throw new ToolError('Change sets are read by the desktop app only.');
  return aio;
}

/** One change producer the app started (or could not) for `run_change_detection`. */
export interface ChangeProducerRun {
  id: string;
  label: string;
  ok: boolean;
  jobId?: string;
  /** Why it did not start (missing data, a refused job). */
  error?: string;
}

/**
 * The app's hook that runs its registered change producers (C2 to C4 pipelines) for a pair. Set by
 * the desktop renderer at start, so this package needs neither React nor `@aio/change`.
 */
export type ChangeProducerRunner = (req: {
  projectId: string;
  from: string;
  to: string;
  /** Producer ids, or every producer the pair has data for. */
  ids: readonly string[] | 'all';
}) => Promise<ChangeProducerRun[]>;

let producerRunner: ChangeProducerRunner | null = null;

/** Install (or remove, with null) the app's change producer runner. */
export function setChangeProducerRunner(runner: ChangeProducerRunner | null): void {
  producerRunner = runner;
}

function pick(all: readonly CaptureRef[], ref: string | undefined, fallback: CaptureRef) {
  if (ref === undefined) return fallback;
  const q = ref.toLowerCase();
  const found =
    all.find((c) => c.id.toLowerCase() === q || c.label.toLowerCase() === q) ??
    all.find((c) => c.date === ref || c.date.startsWith(ref)) ??
    all.find((c) => c.label.toLowerCase().includes(q));
  if (!found) {
    const list = all.map((c) => `${c.id} (${c.date})`).join(', ');
    throw new ToolError(`No capture "${ref}" in this project. Captures: ${list}.`);
  }
  return found;
}

/** The two captures to compare, earlier first. */
export function capturePair(
  ctx: RendererToolContext,
  from?: string,
  to?: string,
): { from: CaptureRef; to: CaptureRef } {
  const captures = [...project(ctx).manifest.captures].sort((a, b) => a.date.localeCompare(b.date));
  const first = captures[0];
  const last = captures.at(-1);
  if (!first || !last || captures.length < 2)
    throw new ToolError(
      'This project has fewer than two capture dates, so there is nothing to compare.',
    );
  const a = pick(captures, from, first);
  const b = pick(captures, to, last);
  if (a.id === b.id) throw new ToolError('Pick two different capture dates.');
  return a.date <= b.date ? { from: a, to: b } : { from: b, to: a };
}

/** The saved change sets of a pair (every producer). */
export async function changeSetsOf(
  ctx: RendererToolContext,
  from: string,
  to: string,
): Promise<ChangeSet[]> {
  const aio = (globalThis as { aio?: AioBridge }).aio;
  if (!aio) return [];
  const projectId = project(ctx).id;
  const list = await aio.invoke('change:list', { projectId }).catch(() => null);
  if (!list?.ok) return [];
  const out: ChangeSet[] = [];
  for (const s of list.sets) {
    if (s.from !== from || s.to !== to) continue;
    const r = await aio.invoke('change:read', { projectId, id: s.id }).catch(() => null);
    if (r?.ok) out.push(r.set);
  }
  return out;
}

const countBy = <T>(items: readonly T[], key: (t: T) => string) => {
  const out: Record<string, number> = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
};

function row(set: ChangeSet, i: ChangeItem) {
  return {
    id: i.id,
    set: set.id,
    kind: i.kind,
    verdict: i.verdict,
    ...(i.label ? { label: i.label } : {}),
    review: i.review?.status ?? 'open',
    ...(i.method ? { method: i.method } : {}),
    ...(i.kind === 'issue' && i.size ? { size: i.size } : {}),
    ...(i.kind === 'issue' && i.severity ? { severity: i.severity } : {}),
    ...(i.kind === 'detection' && i.count ? { count: i.count } : {}),
    ...(i.kind === 'vector' && i.distanceM !== undefined ? { distanceM: i.distanceM } : {}),
    ...(i.kind === 'region' && i.volume ? { volume: i.volume } : {}),
  };
}

/** Counts per kind and verdict of a pair's change sets, for `compare_captures`. */
export function changeSummary(sets: readonly ChangeSet[]) {
  const items = sets.flatMap((s) => s.items);
  const byKind: Record<string, Record<string, number>> = {};
  for (const i of items) {
    const k = (byKind[i.kind] ??= {});
    k[i.verdict] = (k[i.verdict] ?? 0) + 1;
  }
  return {
    sets: sets.map((s) => ({ id: s.id, producer: s.producer, createdAt: s.createdAt })),
    total: items.length,
    byKind,
    toReview: items.filter((i) => (i.review?.status ?? 'open') === 'open').length,
    note: 'Every change is a proposal until a person confirms it. Resolved never closes an issue on its own.',
  };
}

/** "1 new, 1 resolved, 1 grown" for the step chip. */
export function verdictLine(sets: readonly ChangeSet[]): string {
  const counts = countBy(
    sets.flatMap((s) => s.items).filter((i) => i.verdict !== 'unchanged'),
    (i) => i.verdict,
  );
  const parts = Object.entries(counts).map(([v, n]) => `${String(n)} ${v}`);
  return parts.length ? parts.join(', ') : 'no change';
}

function define<N extends ChangeToolName>(
  name: N,
  run: (
    input: ReturnType<(typeof changeToolInputs)[N]['parse']>,
    ctx: RendererToolContext,
  ) => Promise<ToolRunResult>,
): void {
  registerRendererTool(name, (input, ctx) =>
    run(
      changeToolInputs[name].parse(input) as ReturnType<(typeof changeToolInputs)[N]['parse']>,
      ctx,
    ),
  );
}

define('list_changes', async (input, ctx) => {
  const pair = capturePair(ctx, input.from, input.to);
  const sets = await changeSetsOf(ctx, pair.from.id, pair.to.id);
  const rows = sets
    .flatMap((s) => s.items.map((i) => ({ s, i })))
    .filter(
      ({ i }) =>
        (!input.kind || i.kind === input.kind) &&
        (!input.verdict || i.verdict === input.verdict) &&
        (!input.status || (i.review?.status ?? 'open') === input.status),
    );
  return {
    result: {
      from: { captureId: pair.from.id, date: pair.from.date },
      to: { captureId: pair.to.id, date: pair.to.date },
      ...(sets.length === 0
        ? { note: 'No change sets for these dates yet. Use run_change_detection.' }
        : {}),
      total: rows.length,
      items: rows.slice(0, input.limit).map(({ s, i }) => row(s, i)),
    },
    summary: `${String(rows.length)} change${rows.length === 1 ? '' : 's'}`,
  };
});

define('show_change', async (input, ctx) => {
  const pair = capturePair(ctx, input.from, input.to);
  const sets = await changeSetsOf(ctx, pair.from.id, pair.to.id);
  const hit = sets.flatMap((s) => s.items).find((i) => i.id === input.id);
  if (!hit)
    throw new ToolError(`No change "${input.id}" between these dates. Use list_changes for ids.`);
  const ws = ctx.workspace.getState();
  const before = { selection: ws.selection, camera: ws.lastCamera };
  const issueId = hit.kind === 'issue' ? (hit.to ?? hit.from) : undefined;
  if (issueId) ws.select({ kind: 'issue', id: issueId });
  if (hit.at) ws.flyTo({ kind: 'point', p: hit.at, distance: 25 });
  else if (issueId) ws.flyTo({ kind: 'selection', selection: { kind: 'issue', id: issueId } });
  else throw new ToolError(`The change "${input.id}" has no place to fly to.`);
  return {
    result: { id: hit.id, kind: hit.kind, verdict: hit.verdict, at: hit.at ?? null },
    summary: hit.label ?? hit.id,
    undo: () => {
      const s = ctx.workspace.getState();
      s.select(before.selection);
      if (before.camera) s.flyTo(before.camera.target);
    },
  };
});

define('run_change_detection', async (input, ctx) => {
  const pair = capturePair(ctx, input.from, input.to);
  const aio = bridge();
  const jobId = `agent-change-${String(ctx.now().getTime())}`;
  const r = await aio.invoke('change:compute', {
    jobId,
    projectId: project(ctx).id,
    from: pair.from.id,
    to: pair.to.id,
    kinds: input.kinds ?? ['issue', 'detection', 'vector'],
  });
  if (!r.ok) throw new ToolError(r.error);
  let started: ChangeProducerRun[] | undefined;
  if (input.pipelines) {
    if (!producerRunner) throw new ToolError('The change pipelines run in the desktop app only.');
    started = await producerRunner({
      projectId: project(ctx).id,
      from: pair.from.id,
      to: pair.to.id,
      ids: input.pipelines.includes('all') ? 'all' : input.pipelines,
    });
  }
  const sets = await changeSetsOf(ctx, pair.from.id, pair.to.id);
  const jobs = started?.filter((s) => s.ok).length ?? 0;
  return {
    result: {
      written: r.ids,
      ...changeSummary(sets),
      ...(started
        ? {
            pipelines: started,
            pipelineNote:
              'Pipelines run as jobs; their changes join list_changes when the jobs finish.',
          }
        : {}),
    },
    summary: started
      ? `${verdictLine(sets)}; ${String(jobs)} change jobs started`
      : verdictLine(sets),
  };
});
