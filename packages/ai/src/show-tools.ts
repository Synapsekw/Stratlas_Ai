/**
 * Executors of the tools that show things in the app: `show_issue`, `show_photos`, `show_issues`,
 * `open_screen`, `list_assets`. They reach the screens only through the optional hooks on
 * `ctx.app`, so what the agent does is what a click does; a host without the hooks gets one fixed
 * message. Nothing here writes project data.
 */
import type { Issue } from '@aio/schema';
import type { Selection } from '@aio/workspace';
import type { z } from 'zod';
import { assetIndex, describeIssue, issuesOn, severityLabel, type AssetIndex } from './asset-index';
import { applyPose, currentPose, ensureScene, flyToIssue } from './camera-tools';
import { findIssueFuzzy, issuePoints } from './places';
import { showToolInputs, type ShowToolName } from './show-tool-specs';
import {
  assetRef,
  issueClass,
  plural,
  project,
  registerRendererTool,
  severityRank,
  ToolError,
  worstFirst,
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

const isOpen = (i: Issue) => i.status !== 'closed';

// What the issue tools share (list_issues and summarize_issues use these too) ------------------

// said also with a finding or an untagged part of the model selected: neither is an asset
export const WHOLE_PROJECT = 'No tagged asset is selected, so this covers the whole project.';

/**
 * The findings `where` names: on a tagged asset, in an area, or on the selection. "This asset"
 * with no tagged asset selected means the whole project (a project is often one asset), so
 * "selection" then names nothing (`whole`), and the tool says so in its result.
 */
export function findingsOn(
  ctx: RendererToolContext,
  where: string | undefined,
): { there: ReturnType<typeof issuesOn> | null; whole: boolean } {
  if (where === undefined) return { there: null, whole: false };
  if (where === 'selection') {
    const selected = ctx.workspace.getState().selection;
    if (selected?.kind !== 'asset' || !assetRef(ctx, selected.id)) {
      return { there: null, whole: true };
    }
  }
  return { there: issuesOn(ctx, where), whole: false };
}

/**
 * Rows carry the asset a finding sits on. While the bounds of the assets are not known the rows
 * have none, and the model is told why, so it does not read that as "on no asset".
 */
export const assetsUnknown = (index: AssetIndex) =>
  index.status === 'loading' &&
  'The 3D model has not loaded yet, so the asset of each finding is not known. Open Scene and ask again.';

/** What a result has to tell the model beside its numbers, as one `note`; no key when nothing. */
export function noted(...notes: (string | false | undefined)[]): { note?: string } {
  const said = notes.filter((n): n is string => typeof n === 'string');
  return said.length > 0 ? { note: said.join(' ') } : {};
}

/** The text filter of list_issues: in the code, the title or the note, whatever the case. */
export const matchesText = (i: Issue, text: string) =>
  `${i.code} ${i.title} ${i.note}`.toLowerCase().includes(text.toLowerCase());

/**
 * A level the project does not have (7 where there are three) would open an empty screen. It is
 * an error that lists the levels instead, so the model can pick one.
 */
function checkLevel(ctx: RendererToolContext, level: SeverityLevel | 'highest' | undefined): void {
  if (level === undefined || level === 'highest') return;
  const models = project(ctx).manifest.severityModels;
  const known =
    level === 'uncertain'
      ? models.some((m) => m.uncertain !== undefined)
      : models.some((m) => m.levels.some((l) => l.value === level));
  if (known) return;
  const levels = models
    .flatMap((m) => m.levels)
    .sort((a, b) => a.value - b.value)
    .map((l) => `${String(l.value)} ${l.label}`);
  if (levels.length === 0) throw new ToolError('This project has no severity levels.');
  const missing = level === 'uncertain' ? '"uncertain" level' : `severity level ${String(level)}`;
  throw new ToolError(
    `This project has no ${missing}. Its levels are ${[...new Set(levels)].join(', ')}.`,
  );
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
  inspect: 'Inspect',
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
): { issue: Issue; among: Issue[]; whole: boolean } {
  const open = ctx.workspace.getState().issues.filter(isOpen);
  if (input.issue !== undefined) {
    return { issue: findIssueFuzzy(ctx, input.issue), among: open, whole: false };
  }
  const { there, whole } = findingsOn(ctx, input.where);
  const ids = there ? new Set(there.ids) : null;
  const among = ids ? open.filter((i) => ids.has(i.id)) : open;
  const issue = [...among].sort(worstFirst)[0];
  if (!issue) {
    if (!there) throw new ToolError('No open findings.');
    // in a project graded from photos no asset has a finding: "none" alone would read as "clean"
    const n = there.unplaced;
    const be = n === 1 ? 'is' : 'are';
    const apart =
      n > 0
        ? ` ${plural(n, 'finding')} ${be} marked on photos or the map only and ${be} not matched to assets.`
        : '';
    throw new ToolError(`No open findings on ${there.label}.${apart}`);
  }
  return { issue, among, whole };
}

define('show_issue', async (input, ctx) => {
  project(ctx);
  const app = host(ctx, 'openScreen');
  if (input.evidence) host(ctx, 'showEvidence');
  const { issue, among, whole } = pick(ctx, input);

  // what undo needs, taken before anything changes
  const restoreView = app.captureView?.();
  const selectionBefore = ctx.workspace.getState().selection;

  // ensureScene opens Scene from another screen; a host that cannot say what shows gets it opened
  if (!app.screen) app.openScreen('scene');
  await ensureScene(ctx);
  // the camera is read once the 3D view is there: on Media or Issues there is none to read, only
  // an old request of the agent, and undo would send the camera to that
  const poseBefore = currentPose(ctx);
  const selection: Selection = { kind: 'issue', id: issue.id };
  ctx.workspace.getState().select(selection);
  const opened = input.evidence && app.showEvidence?.(issue.id) === true;

  const placed = issuePoints(issue).length > 0;
  let nowhere: string | undefined;
  // opening the evidence of a pin flies to the pin, as a click on it does; anything else (no
  // evidence, or a finding on a photo only) the camera is sent to here
  if (!(opened && placed)) {
    const flight = await flyToIssue(ctx, issue);
    if (!flight.moved) {
      // nothing for the 3D camera, but the map pans to a finding that is marked on it
      ctx.workspace.getState().flyTo({ kind: 'selection', selection });
      const mapOnly = issue.sightings.length > 0 && issue.sightings.every((s) => s.on === 'map');
      // the stage can show the 3D view alone: the map then shows nothing until it is opened
      const mapShows = app.stageView?.().showMap === true;
      nowhere = !mapOnly
        ? 'This finding has no position to fly to.'
        : mapShows
          ? 'This finding is marked on the map only. The map shows it.'
          : 'This finding is marked on the map only. Open the map to see it.';
    }
  }

  const index = assetIndex(ctx);
  const detail = describeIssue(ctx, issue, index);
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
      ...(whole ? { where: null } : {}),
      // only a finding with a place in the model can sit on an asset at all
      ...noted(whole && WHOLE_PROJECT, nowhere, placed && assetsUnknown(index)),
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
  checkLevel(ctx, input.severity);

  // the findings asked for: on an asset or in an area, one finding, one class; all named must hold
  let found: Issue[] | null = null;
  const labels: string[] = [];
  const narrow = (keep: (i: Issue) => boolean) =>
    (found ?? ctx.workspace.getState().issues).filter(keep);
  const { there, whole } = findingsOn(ctx, input.where);
  if (there) {
    const ids = new Set(there.ids);
    found = narrow((i) => ids.has(i.id));
    labels.push(`On ${there.label}`);
  }
  if (input.issue !== undefined) {
    const one = findIssueFuzzy(ctx, input.issue);
    found = narrow((i) => i.id === one.id);
    labels.push(`Finding ${one.code}`);
  }
  if (input.classId !== undefined) {
    const cls = issueClass(ctx, input.classId);
    found = narrow((i) => i.classId === cls.id);
    labels.push(cls.label);
  }
  const label = labels.join(', ');
  // a scope without photos is still a scope: Inspect shows its empty state with the chip
  const scope: ViewScope | null = found ? { label, ids: photoKeys(found) } : null;

  const restoreView = app.captureView?.();
  const view = app.showPhotos({
    onlyFindings: input.onlyFindings ?? (input.severity !== undefined || scope !== null),
    order: input.order,
    severity: input.severity ?? null,
    scope,
  });
  app.openScreen('inspect');
  return {
    result: {
      shown: view.shown,
      total: view.total,
      severity: view.severityLabel || null,
      scope: label || null,
      ...(there && there.unplaced > 0 ? { notOnAnAsset: there.unplaced } : {}),
      ...(whole ? { where: null } : {}),
      ...noted(whole && WHOLE_PROJECT),
    },
    summary: plural(view.shown, 'photo'),
    ...(restoreView ? { undo: restoreView } : {}),
  };
});

define('show_issues', (input, ctx) => {
  project(ctx);
  const app = host(ctx, 'showIssues', 'openScreen');
  checkLevel(ctx, input.severity);
  const { there, whole } = findingsOn(ctx, input.where);
  const cls = input.classId !== undefined ? issueClass(ctx, input.classId) : null;
  const scope: ViewScope | null = there ? { label: `On ${there.label}`, ids: there.ids } : null;

  let severity: SeverityLevel | null;
  let severityName: string | null;
  if (input.severity === 'highest') {
    // the highest level present among the findings asked for, not the top of the scale; closed
    // findings count only when they are what was asked for
    const ids = there ? new Set(there.ids) : null;
    const text = input.text;
    const worst = ctx.workspace
      .getState()
      .issues.filter(
        (i) =>
          (!ids || ids.has(i.id)) &&
          (!cls || i.classId === cls.id) &&
          (input.status ? i.status === input.status : isOpen(i)) &&
          (text === undefined || matchesText(i, text)),
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
      ...(whole ? { where: null } : {}),
      ...noted(whole && WHOLE_PROJECT),
    },
    summary: plural(shown, 'finding'),
    ...(restoreView ? { undo: restoreView } : {}),
  };
});

define('open_screen', ({ screen }, ctx) => {
  project(ctx);
  const app = host(ctx, 'openScreen');
  const restoreView = app.captureView?.();
  // Media and Detections became one screen; the old names still open it
  const to: AppScreen = screen === 'media' || screen === 'detections' ? 'inspect' : screen;
  app.openScreen(to);
  return {
    result: { screen: to },
    summary: SCREEN_NAME[to],
    ...(restoreView ? { undo: restoreView } : {}),
  };
});

// Findings per asset -------------------------------------------------------------------------

define('list_assets', ({ by, sort, limit }, ctx) => {
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
      (a, b) =>
        (sort === 'findings' ? b.row.findings - a.row.findings : b.rank - a.rank) ||
        b.row.open - a.row.open ||
        a.row.name.localeCompare(b.row.name),
    );
  // the cut comes after the order: the asset asked for is in the rows however many there are
  const rows = all.slice(0, limit).map((r) => r.row);
  const issues = ctx.workspace.getState().issues;
  return {
    result: {
      by,
      total: all.length,
      shown: rows.length,
      unplaced: index.unplaced.length,
      // a place in the model, but no asset within reach: in no row, like the unplaced ones
      noAsset: issues.length - index.unplaced.length - index.links.size,
      rows,
    },
    summary: plural(rows.length, by),
  };
});
