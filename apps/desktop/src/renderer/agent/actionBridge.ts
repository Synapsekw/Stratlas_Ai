/**
 * The right-click action registry as agent tools (A2, agent.md 4.4): `list_actions` answers what
 * a person's menu offers on a target, `run_action` runs one, through the same registry, greyed
 * reasons and picks the menus use. Specs and the coverage table (`AGENT_ACTIONS`, with the risk
 * that decides the approval card) are in `@aio/ai` action-tool-specs.ts; actionParity.test.ts
 * keeps the table and the registry together.
 *
 * The context is built as the Datasets list builds its own (`Sidebar.tsx`): the manifest, what is
 * hidden, a package or a reviewer who may only look, the survey dates and their folders, the
 * focused date. What an action writes as a note comes back in the result.
 */
import { isAnnotateReadOnly } from '@aio/annotate';
import {
  AGENT_ACTIONS,
  ToolError,
  actionToolInputs,
  registerRendererTool,
  registerStepDescriber,
  resolveCapture,
  resolveLayer,
  type ActionTarget,
  type ToolRunResult,
} from '@aio/ai';
import type { ProjectManifest } from '@aio/schema';
import {
  EVERY_DATE,
  NO_HOST,
  actionsFor,
  formatDate,
  t,
  makeActionCtx,
  registeredActions,
  type ActionCtx,
  type MenuTarget,
  type ResolvedItem,
} from '@aio/ui';
import { captureIndex, dateTags, workspace } from '@aio/workspace';
import { shell } from '../shell';
import { registerSidebarActions } from '../shell/actions';
import { moveLayersToDate, undoDateMove, type DateMoveResult } from '../shell/dateFolders';
import { measureStore } from '../survey/measureStore';
import { timeline } from '../workspace/timeline';

/** At most this many picks per action in a listing (a long date list stays readable). */
const MAX_PICKS = 40;

function openProject() {
  const p = workspace.getState().project;
  if (!p) throw new ToolError('No project is open.');
  return p;
}

/** A survey date by id, date, name, "earliest" or "latest" (one resolver); null: Every date. */
function captureOf(ref: string | null): string | null {
  return ref === null ? null : resolveCapture(openProject().manifest.captures, ref).id;
}

/** Layer ids by id or exact name; a name several layers share is refused. */
function layerIds(refs: readonly string[]): string[] {
  const manifest = openProject().manifest;
  return refs.map((ref) => resolveLayer(manifest, ref).id);
}

/** The menu target the model named. */
export function menuTarget(target: ActionTarget): MenuTarget {
  switch (target.kind) {
    case 'project':
      return { kind: 'project' };
    case 'date':
      return { kind: 'date', captureId: captureOf(target.date) };
    case 'layers':
      return { kind: 'layers', layerIds: layerIds(target.ids) };
    case 'measurements':
      return { kind: 'measurements', ids: target.ids, clicked: target.ids[0] ?? '' };
    case 'antennas':
      return { kind: 'antennas', ids: target.ids, clicked: target.ids[0] ?? '' };
    case 'photos': {
      const [layerId] = layerIds([target.layer]);
      return {
        kind: 'photos',
        picks: target.ids.map((photoId) => ({ layerId: layerId ?? '', photoId })),
      };
    }
    case 'media': {
      const [layerId] = layerIds([target.layer]);
      return {
        kind: 'media',
        picks: target.ids.map((itemId) => ({ layerId: layerId ?? '', itemId, kind: target.as })),
      };
    }
    case 'annotations':
      return { kind: 'annotations', row: target.row };
  }
}

/** Names, the first three and how many more. */
function names(list: readonly string[]): string {
  if (list.length <= 3) return list.join(', ');
  return t('agentTool.target.more', {
    names: list.slice(0, 3).join(', '),
    count: list.length - 3,
  });
}

/** What a target is, as a person reads it: layer names with their date, the date, the rows. */
export function targetText(menu: MenuTarget, manifest: ProjectManifest): string {
  const dateOf = (id: string | undefined) => manifest.captures.find((c) => c.id === id)?.date;
  const layerName = (id: string) => {
    const l = manifest.layers.find((x) => x.id === id);
    if (!l) return id;
    const d = dateOf(l.capture);
    return d ? t('agentTool.target.layerOn', { name: l.name, date: formatDate(d) }) : l.name;
  };
  switch (menu.kind) {
    case 'project':
      return t('agentTool.target.project');
    case 'date': {
      const d = menu.captureId === null ? undefined : dateOf(menu.captureId);
      return d ? formatDate(d) : t('agentTool.target.everyDate');
    }
    case 'layers':
    case 'group':
      return names(menu.layerIds.map(layerName));
    case 'measurements': {
      const all = measureStore.getState().file.measurements;
      return names(menu.ids.map((id) => all.find((m) => m.id === id)?.label ?? id));
    }
    case 'antennas':
      return t('agentTool.target.antennas', { count: menu.ids.length });
    case 'photos':
    case 'media': {
      const layer = menu.picks[0]?.layerId ?? '';
      return t('agentTool.target.photos', { count: menu.picks.length, layer: layerName(layer) });
    }
    case 'issues':
      return t('agentTool.target.issues');
    case 'annotations':
      return t(menu.row === 'issues' ? 'agentTool.target.issues' : 'agentTool.target.drafts');
  }
}

/** What one run of an action leaves behind: its notes, its problems, the date moves it started. */
interface RunLog {
  notes: string[];
  problems: string[];
  moves: Promise<DateMoveResult & { target: string | null }>[];
}

const newLog = (): RunLog => ({ notes: [], problems: [], moves: [] });

/** The Datasets list's context, with a host that keeps what an action writes and starts. */
export function agentActionCtx(log: RunLog = newLog()): ActionCtx {
  const project = openProject();
  const manifest = project.manifest;
  const tl = timeline.getState();
  const index = tl.projectId === project.id && tl.index ? tl.index : captureIndex(manifest);
  const common = manifest.layers.map((l) => l.id).filter((id) => index.of[id] === undefined);
  const pkg = shell.getState().pkg !== null;
  const lookOnly = isAnnotateReadOnly();
  return makeActionCtx({
    manifest,
    hidden: workspace.getState().hidden,
    canEdit: !pkg && !lookOnly,
    pkg,
    datesOn: index.captures.length > 0,
    focus: tl.projectId === project.id ? tl.focus : null,
    tags: dateTags(index.captures),
    folderLayers: { ...index.layers, [EVERY_DATE]: common },
    drafts: workspace.getState().issues.filter((i) => i.status === 'draft').length,
    host: {
      ...NO_HOST,
      note: (text, danger) => {
        (danger ? log.problems : log.notes).push(text);
      },
      // the Datasets move, awaited by the run: what it wrote, what stayed, why it was refused
      moveLayers: (ids, capture) => {
        log.moves.push(moveLayersToDate(ids, capture).then((r) => ({ ...r, target: capture })));
      },
      askUnplace: () => {
        log.problems.push('The person confirms this in the Datasets list.');
      },
      emptyTrash: () => {
        log.problems.push('The person empties the trash from the Datasets list.');
      },
    },
  });
}

/** The actions offered to the agent on a target (covered in the table), with their state. */
function offered(target: MenuTarget, ctx: ActionCtx): ResolvedItem[] {
  registerSidebarActions();
  return actionsFor(target, ctx).filter((i) => {
    const e = AGENT_ACTIONS[i.id];
    return e !== undefined && 'risk' in e;
  });
}

function pickRows(item: ResolvedItem) {
  return item.sub.slice(0, MAX_PICKS).map((s) => ({
    id: s.id,
    label: s.label,
    ...(s.disabled ? { greyed: s.disabled } : {}),
    ...(s.checked ? { current: true } : {}),
  }));
}

export function listActions(input: unknown): Promise<ToolRunResult> {
  const { target } = actionToolInputs.list_actions.parse(input);
  const items = offered(menuTarget(target), agentActionCtx());
  const rows = items.map((i) => {
    const e = AGENT_ACTIONS[i.id];
    const asks = e !== undefined && 'risk' in e && e.risk === 'write';
    return {
      id: i.id,
      label: i.label,
      ...(asks ? { asksApproval: true } : {}),
      ...(i.disabled ? { greyed: i.disabled } : {}),
      ...(i.sub.length > 0 ? { picks: pickRows(i) } : {}),
    };
  });
  return Promise.resolve({
    result: {
      actions: rows,
      ...(rows.length === 0
        ? { note: 'Nothing the agent can run is offered on this target.' }
        : {}),
    },
    summary: t('agentTool.summary.actions', { count: rows.length }),
  });
}

/** The approval card of a run: the action's label and the target as the app resolved it. */
export function describeRun(input: unknown): string | null {
  const parsed = actionToolInputs.run_action.safeParse(input);
  if (!parsed.success || !workspace.getState().project) return null;
  const { action, target, pick } = parsed.data;
  try {
    const menu = menuTarget(target);
    const item = offered(menu, agentActionCtx()).find((i) => i.id === action);
    if (!item) return null;
    const chosen = pick ? item.sub.find((s) => s.id === pick || s.label === pick) : undefined;
    return t('agentTool.card.run', {
      action: chosen ? `${item.label}: ${chosen.label}` : item.label,
      target: targetText(menu, openProject().manifest),
    });
  } catch {
    // an ambiguous or unknown target: the run refuses it, the card keeps the tool's description
    return null;
  }
}

export async function runAction(input: unknown): Promise<ToolRunResult> {
  const { action, target, pick } = actionToolInputs.run_action.parse(input);
  const entry = AGENT_ACTIONS[action];
  if (entry && 'exclude' in entry) {
    throw new ToolError(`"${action}" stays with the person: ${entry.exclude}`);
  }
  const log = newLog();
  const ctx = agentActionCtx(log);
  const menu = menuTarget(target);
  const manifest = openProject().manifest;
  const items = offered(menu, ctx);
  const item = items.find((i) => i.id === action);
  if (!item) {
    const ids = items.filter((i) => !i.disabled).map((i) => i.id);
    throw new ToolError(
      `"${action}" is not offered on this target. Offered: ${ids.join(', ') || 'nothing'}.`,
    );
  }
  if (item.disabled) throw new ToolError(`${item.label} is greyed: ${item.disabled}`);
  let sub: string | undefined;
  if (item.sub.length > 0) {
    if (pick === undefined) {
      const ids = item.sub.map((s) => s.id).slice(0, MAX_PICKS);
      throw new ToolError(`${item.label} needs a pick: ${ids.join(', ')}.`);
    }
    const q = pick.toLowerCase();
    const chosen =
      item.sub.find((s) => s.id === pick) ?? item.sub.find((s) => s.label.toLowerCase() === q);
    if (!chosen) {
      const ids = item.sub.map((s) => s.id).slice(0, MAX_PICKS);
      throw new ToolError(`No pick "${pick}" for ${item.label}. Picks: ${ids.join(', ')}.`);
    }
    if (chosen.disabled) throw new ToolError(`${chosen.label} is greyed: ${chosen.disabled}`);
    sub = chosen.id;
  }
  const raw = registeredActions().find((a) => a.id === action);
  if (!raw) throw new ToolError(`"${action}" is not registered in this build.`);
  try {
    await raw.run(menu, ctx, sub);
  } catch (e) {
    throw new ToolError(e instanceof Error ? e.message : String(e));
  }
  // a date move is written before the step ends; a refused write fails the step
  const moves = await Promise.all(log.moves);
  const refusedWrite = moves.find((m) => m.error)?.error;
  if (refusedWrite) throw new ToolError(refusedWrite);
  const [problem] = log.problems;
  if (problem) throw new ToolError(problem);
  const label = sub
    ? `${item.label}: ${item.sub.find((s) => s.id === sub)?.label ?? sub}`
    : item.label;
  const kept = moves.flatMap((m) =>
    Object.entries(m.stays).map(([layer, capture]) => ({
      layer: manifest.layers.find((l) => l.id === layer)?.name ?? layer,
      keeps: manifest.captures.find((c) => c.id === capture)?.date ?? capture,
    })),
  );
  const moved = moves.filter((m) => m.moved.length > 0);
  const waits = entry && 'risk' in entry ? entry.then : undefined;
  const status = waits === 'confirm' ? 'waiting' : waits === 'finish' ? 'opened' : 'done';
  const summary =
    waits !== undefined
      ? t(waits === 'confirm' ? 'agentTool.summary.confirm' : 'agentTool.summary.finish', {
          action: label,
        })
      : kept.length > 0
        ? t('agentTool.summary.kept', { action: label, count: kept.length })
        : t('agentTool.summary.ran', { action: label });
  return {
    result: {
      action,
      label,
      target: targetText(menu, manifest),
      status,
      ...(status === 'waiting' ? { note: 'Waiting for the person to confirm in the app.' } : {}),
      ...(status === 'opened' ? { note: 'Opened in the app for the person to finish.' } : {}),
      ...(kept.length > 0
        ? { kept, keptNote: 'These layers keep the date their name or the volumes give them.' }
        : {}),
      ...(log.notes.length > 0 ? { notes: log.notes } : {}),
    },
    summary,
    // the Datasets Undo: the moved layers go back, unless they were filed elsewhere since
    ...(moved.length > 0
      ? {
          undo: async () => {
            for (const m of [...moved].reverse()) {
              const why = await undoDateMove(m.moved, m.target);
              if (why) return why;
            }
            return null;
          },
        }
      : {}),
  };
}

let registered = false;

/** Register the two executors, once (the specs come with `@aio/ai`). */
export function registerActionTools(): void {
  if (registered) return;
  registered = true;
  registerRendererTool('list_actions', listActions);
  registerRendererTool('run_action', runAction);
  registerStepDescriber('run_action', describeRun);
}
