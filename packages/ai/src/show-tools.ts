/**
 * Executors of the tools that show things in the app: `show_issue`, `show_photos`, `show_issues`,
 * `open_screen`, `list_assets`. They reach the screens only through the optional hooks on
 * `ctx.app`, so what the agent does is what a click does; a host without the hooks gets one fixed
 * message. Nothing here writes project data.
 */
import type { Issue } from '@aio/schema';
import type { Selection } from '@aio/workspace';
import type { z } from 'zod';
import { assetIndex, describeIssue, issuesOn, severityLabel } from './asset-index';
import { applyPose, currentPose, ensureScene, flyToIssue } from './camera-tools';
import { findIssueFuzzy, issuePoints } from './places';
import { showToolInputs, type ShowToolName } from './show-tool-specs';
import {
  plural,
  project,
  registerRendererTool,
  severityRank,
  ToolError,
  type AppHooks,
  type AppScreen,
  type RendererToolContext,
  type SeverityLevel,
  type ToolRunResult,
  type ViewScope,
} from './tool-kit';

const NO_HOOKS = 'This build of the app cannot open screens for the agent.';
// the same answers issuesOn gives, so every asset question fails alike
const MODEL_LOADING =
  'The 3D model is still loading, so findings cannot be matched to assets yet. Open Scene and try again in a moment.';
const NO_ASSETS = 'This project has no tagged assets.';

/** The host app with the hooks a tool cannot do without. */
function host<K extends keyof AppHooks>(
  ctx: RendererToolContext,
  ...needs: K[]
): AppHooks & Required<Pick<AppHooks, K>> {
  const app = ctx.app;
  if (!app || needs.some((k) => app[k] === undefined)) throw new ToolError(NO_HOOKS);
  return app as AppHooks & Required<Pick<AppHooks, K>>;
}

/**
 * Natural order for codes: prefix, then number (F2 before F10). The order of the issue register
 * (`compareCodes` in @aio/annotate, which this package does not depend on), so "the first by
 * code" is the one the person sees first.
 */
export function compareCodes(a: string, b: string): number {
  const pa = /^([A-Z]*)(\d*)$/.exec(a);
  const pb = /^([A-Z]*)(\d*)$/.exec(b);
  const prefixA = pa?.[1] ?? a;
  const prefixB = pb?.[1] ?? b;
  if (prefixA !== prefixB) return prefixA < prefixB ? -1 : 1;
  return Number(pa?.[2] ?? 0) - Number(pb?.[2] ?? 0);
}

/** Worst first; findings of one level in code order, so the first is the same every time. */
export const worstFirst = (a: Issue, b: Issue) =>
  severityRank(b.severity) - severityRank(a.severity) || compareCodes(a.code, b.code);

const isOpen = (i: Issue) => i.status !== 'closed';

/** An issue class by id or by its label. */
function classOf(ctx: RendererToolContext, ref: string) {
  const classes = project(ctx).manifest.classCatalogues.flatMap((c) => c.classes);
  const cls =
    classes.find((c) => c.id === ref) ??
    classes.find((c) => c.label.toLowerCase() === ref.toLowerCase());
  if (cls) return cls;
  if (classes.length === 0) throw new ToolError('This project has no issue classes.');
  const list = classes
    .slice(0, 20)
    .map((c) => `${c.id} (${c.label})`)
    .join(', ');
  throw new ToolError(`Choose classId from this project's classes: ${list}.`);
}

/** The name of a level: from the first severity model of the project that has it. */
function levelLabel(ctx: RendererToolContext, level: SeverityLevel): string {
  const models = project(ctx).manifest.severityModels;
  if (level === 'uncertain') {
    return models.find((m) => m.uncertain)?.uncertain?.label ?? 'Uncertain';
  }
  for (const m of models) {
    const found = m.levels.find((l) => l.value === level);
    if (found) return found.label;
  }
  return `Level ${String(level)}`;
}

const SCREEN_NAME: Record<AppScreen, string> = {
  scene: 'Scene',
  issues: 'Issues',
  media: 'Media',
  detections: 'Detections',
  reports: 'Reports',
};

function define<N extends ShowToolName>(
  name: N,
  run: (
    input: z.output<(typeof showToolInputs)[N]>,
    ctx: RendererToolContext,
  ) => Promise<ToolRunResult> | ToolRunResult,
): void {
  registerRendererTool(name, (input, ctx) =>
    Promise.resolve(
      run(showToolInputs[name].parse(input) as z.output<(typeof showToolInputs)[N]>, ctx),
    ),
  );
}

// One finding --------------------------------------------------------------------------------

/**
 * The finding to show and the findings it is compared with: the one named, else the most severe
 * open one, of the project or of an asset or area.
 */
function pick(
  ctx: RendererToolContext,
  input: { issue?: string | undefined; where?: string | undefined },
): { issue: Issue; among: Issue[] } {
  const open = ctx.workspace.getState().issues.filter(isOpen);
  if (input.issue !== undefined) return { issue: findIssueFuzzy(ctx, input.issue), among: open };
  let among = open;
  let on = '';
  if (input.where !== undefined) {
    const there = issuesOn(ctx, input.where);
    const ids = new Set(there.ids);
    among = open.filter((i) => ids.has(i.id));
    on = ` on ${there.label}`;
  }
  const issue = [...among].sort(worstFirst)[0];
  if (!issue) throw new ToolError(`No open findings${on}.`);
  return { issue, among };
}

define('show_issue', async (input, ctx) => {
  project(ctx);
  const app = host(ctx, 'openScreen');
  if (input.evidence) host(ctx, 'showEvidence');
  const { issue, among } = pick(ctx, input);

  // what undo needs, taken before anything changes
  const restoreView = app.captureView?.();
  const selectionBefore = ctx.workspace.getState().selection;
  const poseBefore = currentPose(ctx);

  // ensureScene opens Scene from another screen; a host that cannot say what shows gets it opened
  if (!app.screen) app.openScreen('scene');
  await ensureScene(ctx);
  const selection: Selection = { kind: 'issue', id: issue.id };
  ctx.workspace.getState().select(selection);
  const opened = input.evidence && app.showEvidence?.(issue.id) === true;

  let note: string | undefined;
  // opening the evidence of a pin flies to the pin, as a click on it does; anything else (no
  // evidence, or a finding on a photo only) the camera is sent to here
  if (!(opened && issuePoints(issue).length > 0)) {
    const flight = await flyToIssue(ctx, issue);
    if (!flight.moved) {
      ctx.workspace.getState().flyTo({ kind: 'selection', selection });
      note = 'This finding has no position to fly to.';
    }
  }

  const detail = describeIssue(ctx, issue, assetIndex(ctx));
  const rank = severityRank(issue.severity);
  const same = among
    .filter((i) => i.id !== issue.id && severityRank(i.severity) === rank)
    .sort(worstFirst);
  return {
    result: {
      issue: detail,
      evidence: opened,
      photoOnly: detail.photoOnly,
      sameLevel: { count: same.length, codes: same.slice(0, 5).map((i) => i.code) },
      ...(note ? { note } : {}),
    },
    summary: issue.code,
    undo: () => {
      ctx.workspace.getState().select(selectionBefore);
      if (poseBefore) applyPose(ctx, poseBefore);
      restoreView?.();
    },
  };
});

// Screens with a filter set ------------------------------------------------------------------

/** `<layerId>/<photoId>` of every photo the findings are marked on. */
function photoKeys(issues: readonly Issue[]): string[] {
  const keys = new Set<string>();
  for (const i of issues) {
    for (const s of i.sightings) if (s.on === 'image') keys.add(`${s.layer}/${s.photo}`);
  }
  return [...keys];
}

define('show_photos', (input, ctx) => {
  const manifest = project(ctx).manifest;
  const app = host(ctx, 'showPhotos', 'openScreen');
  if (!manifest.layers.some((l) => l.kind === 'photos' && l.items.length > 0)) {
    throw new ToolError('This project has no photos.');
  }

  // the findings asked for: on an asset or in an area, one finding, one class; all named must hold
  let found: Issue[] | null = null;
  const labels: string[] = [];
  let unplaced = 0;
  const narrow = (keep: (i: Issue) => boolean) =>
    (found ?? ctx.workspace.getState().issues).filter(keep);
  if (input.where !== undefined) {
    const there = issuesOn(ctx, input.where);
    const ids = new Set(there.ids);
    found = narrow((i) => ids.has(i.id));
    labels.push(`On ${there.label}`);
    unplaced = there.unplaced;
  }
  if (input.issue !== undefined) {
    const one = findIssueFuzzy(ctx, input.issue);
    found = narrow((i) => i.id === one.id);
    labels.push(`Finding ${one.code}`);
  }
  if (input.classId !== undefined) {
    const cls = classOf(ctx, input.classId);
    found = narrow((i) => i.classId === cls.id);
    labels.push(cls.label);
  }
  const label = labels.join(', ');
  // a scope without photos is still a scope: Media shows its empty state with the chip
  const scope: ViewScope | null = found ? { label, ids: photoKeys(found) } : null;

  const restoreView = app.captureView?.();
  const view = app.showPhotos({
    onlyFindings: input.onlyFindings ?? (input.severity !== undefined || scope !== null),
    order: input.order,
    severity: input.severity ?? null,
    scope,
  });
  app.openScreen('media');
  return {
    result: {
      shown: view.shown,
      total: view.total,
      severity: view.severityLabel || null,
      scope: label || null,
      ...(unplaced > 0 ? { notOnAnAsset: unplaced } : {}),
    },
    summary: plural(view.shown, 'photo'),
    ...(restoreView ? { undo: restoreView } : {}),
  };
});

define('show_issues', (input, ctx) => {
  project(ctx);
  const app = host(ctx, 'showIssues', 'openScreen');
  const there = input.where !== undefined ? issuesOn(ctx, input.where) : null;
  const cls = input.classId !== undefined ? classOf(ctx, input.classId) : null;
  const scope: ViewScope | null = there ? { label: `On ${there.label}`, ids: there.ids } : null;

  let severity: SeverityLevel | null;
  let severityName: string | null;
  if (input.severity === 'highest') {
    // the highest level present among the findings asked for, not the top of the scale; closed
    // findings count only when they are what was asked for
    const ids = there ? new Set(there.ids) : null;
    const worst = ctx.workspace
      .getState()
      .issues.filter(
        (i) =>
          (!ids || ids.has(i.id)) &&
          (!cls || i.classId === cls.id) &&
          (input.status ? i.status === input.status : isOpen(i)),
      )
      .sort(worstFirst)[0];
    severity = worst?.severity ?? null;
    severityName = worst ? severityLabel(ctx, worst) : null;
  } else {
    severity = input.severity ?? null;
    severityName = severity === null ? null : levelLabel(ctx, severity);
  }

  const restoreView = app.captureView?.();
  const { shown } = app.showIssues({
    severity,
    classId: cls?.id ?? null,
    status: input.status ?? null,
    ...(input.text !== undefined ? { text: input.text } : {}),
    sort: input.sort,
    dir: 'asc',
    scope,
  });
  app.openScreen('issues');
  return {
    result: {
      shown,
      severity: severityName,
      scope: scope?.label ?? null,
      ...(there && there.unplaced > 0 ? { notOnAnAsset: there.unplaced } : {}),
    },
    summary: plural(shown, 'finding'),
    ...(restoreView ? { undo: restoreView } : {}),
  };
});

define('open_screen', ({ screen }, ctx) => {
  project(ctx);
  const app = host(ctx, 'openScreen');
  const restoreView = app.captureView?.();
  app.openScreen(screen);
  return {
    result: { screen },
    summary: SCREEN_NAME[screen],
    ...(restoreView ? { undo: restoreView } : {}),
  };
});

// Findings per asset -------------------------------------------------------------------------

define('list_assets', ({ by, limit }, ctx) => {
  const index = assetIndex(ctx);
  if (index.status === 'loading') throw new ToolError(MODEL_LOADING);
  if (index.status === 'none') throw new ToolError(NO_ASSETS);

  const groups = new Map<string, { area?: string; issues: Issue[] }>();
  for (const issue of ctx.workspace.getState().issues) {
    const link = index.links.get(issue.id);
    const name = by === 'area' ? link?.area : link?.asset;
    if (!link || name === undefined) continue;
    const group = groups.get(name) ?? {
      ...(by === 'asset' && link.area ? { area: link.area } : {}),
      issues: [],
    };
    group.issues.push(issue);
    groups.set(name, group);
  }
  const all = [...groups]
    .map(([name, g]) => {
      const open = g.issues.filter(isOpen);
      // the shape an asset is in now: a closed finding no longer counts against it
      const worst = [...open].sort(worstFirst)[0];
      return {
        // nothing open sorts below an open finding of uncertain severity (rank -1)
        rank: worst ? severityRank(worst.severity) : -2,
        row: {
          name,
          ...(g.area ? { area: g.area } : {}),
          findings: g.issues.length,
          open: open.length,
          worst: worst ? { level: worst.severity, label: severityLabel(ctx, worst) } : null,
        },
      };
    })
    .sort(
      (a, b) => b.rank - a.rank || b.row.open - a.row.open || a.row.name.localeCompare(b.row.name),
    );
  const rows = all.slice(0, limit).map((r) => r.row);
  return {
    result: {
      by,
      total: all.length,
      shown: rows.length,
      unplaced: index.unplaced.length,
      rows,
    },
    summary: plural(rows.length, by),
  };
});
