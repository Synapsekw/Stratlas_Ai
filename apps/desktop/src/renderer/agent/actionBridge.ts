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
  type ActionTarget,
  type ToolRunResult,
} from '@aio/ai';
import {
  EVERY_DATE,
  NO_HOST,
  actionsFor,
  makeActionCtx,
  registeredActions,
  type ActionCtx,
  type MenuTarget,
  type ResolvedItem,
} from '@aio/ui';
import { captureIndex, dateTags, workspace } from '@aio/workspace';
import { shell } from '../shell';
import { registerSidebarActions } from '../shell/actions';
import { moveLayersToDate } from '../shell/dateFolders';
import { timeline } from '../workspace/timeline';

/** At most this many picks per action in a listing (a long date list stays readable). */
const MAX_PICKS = 40;

function openProject() {
  const p = workspace.getState().project;
  if (!p) throw new ToolError('No project is open.');
  return p;
}

/** A survey date by id, date or name; null stays the Every date folder. */
function captureOf(ref: string | null): string | null {
  if (ref === null) return null;
  const captures = openProject().manifest.captures;
  const q = ref.toLowerCase();
  const c =
    captures.find((x) => x.id === ref) ??
    captures.find((x) => x.date === ref || x.label.toLowerCase() === q) ??
    captures.find((x) => x.date.startsWith(ref));
  if (!c) {
    const list = captures.map((x) => `${x.id} (${x.date})`).join(', ');
    throw new ToolError(`No survey date "${ref}". The dates: ${list || 'none'}.`);
  }
  return c.id;
}

/** Layer ids by id or exact name. */
function layerIds(refs: readonly string[]): string[] {
  const layers = openProject().manifest.layers;
  return refs.map((ref) => {
    const l =
      layers.find((x) => x.id === ref) ??
      layers.find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!l) throw new ToolError(`No layer "${ref}". Use list_layers for the ids.`);
    return l.id;
  });
}

/** The menu target the model named. */
export function menuTarget(t: ActionTarget): MenuTarget {
  switch (t.kind) {
    case 'project':
      return { kind: 'project' };
    case 'date':
      return { kind: 'date', captureId: captureOf(t.date) };
    case 'layers':
      return { kind: 'layers', layerIds: layerIds(t.ids) };
    case 'measurements':
      return { kind: 'measurements', ids: t.ids, clicked: t.ids[0] ?? '' };
    case 'antennas':
      return { kind: 'antennas', ids: t.ids, clicked: t.ids[0] ?? '' };
    case 'photos': {
      const [layerId] = layerIds([t.layer]);
      return {
        kind: 'photos',
        picks: t.ids.map((photoId) => ({ layerId: layerId ?? '', photoId })),
      };
    }
    case 'media': {
      const [layerId] = layerIds([t.layer]);
      return {
        kind: 'media',
        picks: t.ids.map((itemId) => ({ layerId: layerId ?? '', itemId, kind: t.as })),
      };
    }
    case 'annotations':
      return { kind: 'annotations', row: t.row };
  }
}

/** The Datasets list's context, with a host that keeps the notes an action writes. */
export function agentActionCtx(notes: string[]): ActionCtx {
  const project = openProject();
  const manifest = project.manifest;
  const tl = timeline.getState();
  const index = tl.projectId === project.id && tl.index ? tl.index : captureIndex(manifest);
  const common = manifest.layers.map((l) => l.id).filter((id) => index.of[id] === undefined);
  const pkg = shell.getState().pkg !== null;
  const lookOnly = isAnnotateReadOnly();
  const note = (text: string, danger?: boolean) => {
    notes.push(danger ? `Problem: ${text}` : text);
  };
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
      note,
      moveLayers: (ids, capture) => {
        void moveLayersToDate(ids, capture).then((r) => {
          if (r.error) note(r.error, true);
        });
      },
      askUnplace: () => {
        note('The person confirms this in the Datasets list.', true);
      },
      emptyTrash: () => {
        note('The person empties the trash from the Datasets list.', true);
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
  const notes: string[] = [];
  const ctx = agentActionCtx(notes);
  const items = offered(menuTarget(target), ctx);
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
    summary: `${String(rows.length)} action${rows.length === 1 ? '' : 's'}`,
  });
}

export async function runAction(input: unknown): Promise<ToolRunResult> {
  const { action, target, pick } = actionToolInputs.run_action.parse(input);
  const entry = AGENT_ACTIONS[action];
  if (entry && 'exclude' in entry) {
    throw new ToolError(`"${action}" stays with the person: ${entry.exclude}`);
  }
  const notes: string[] = [];
  const ctx = agentActionCtx(notes);
  const menu = menuTarget(target);
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
  const failed = notes.find((n) => n.startsWith('Problem: '));
  if (failed) throw new ToolError(failed.slice('Problem: '.length));
  const label = sub
    ? `${item.label}: ${item.sub.find((s) => s.id === sub)?.label ?? sub}`
    : item.label;
  return {
    result: { action, label, done: true, ...(notes.length > 0 ? { notes } : {}) },
    summary: label,
  };
}

let registered = false;

/** Register the two executors, once (the specs come with `@aio/ai`). */
export function registerActionTools(): void {
  if (registered) return;
  registered = true;
  registerRendererTool('list_actions', listActions);
  registerRendererTool('run_action', runAction);
}
