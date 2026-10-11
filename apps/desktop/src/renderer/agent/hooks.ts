/**
 * What the app lets the agent's tools do on its screens (`AppHooks` of @aio/ai): say which screen
 * shows, open one, set the Media and the Issues filter, open a finding's evidence, and remember
 * the view so a step can be undone. Each hook sets the store a click sets, so what the agent did
 * is on the screen, and the person can clear it.
 */
import {
  registerAppHooks,
  type AppScreen,
  type IssueViewFilter,
  type PhotoViewFilter,
  type PhotoViewResult,
  type SeverityLevel,
  type ViewFilters,
} from '@aio/ai';
import { DEFAULT_ISSUE_VIEW, issueView, issuesInView, setIssueView } from '@aio/annotate';
import type { ProjectManifest } from '@aio/schema';
import { workspace } from '@aio/workspace';
import { detections } from '../detections/store';
import { closeEvidence, evidence, openEvidence } from '../issueCard/evidence';
import { findingsIndex } from '../screens/mediaFindings';
import { highestLevel, mediaView, photosInView, setMediaView } from '../screens/mediaView';
import { shell } from '../shell';
import { stagePrefs } from '../workspace/stagePrefs';
import { isDockScreen } from './dockScreens';

const APP_SCREENS: readonly AppScreen[] = ['scene', 'issues', 'media', 'detections', 'reports'];

function screen(): AppScreen | 'other' {
  const now = shell.getState().screen;
  return APP_SCREENS.find((s) => s === now) ?? 'other';
}

function openScreen(to: AppScreen): void {
  const sh = shell.getState();
  sh.go(to);
  // the person is brought here by the agent: the conversation comes along, unfolded
  if (isDockScreen(to)) sh.setAgentDock(false);
}

/** The name of a level: from the first severity model that has it, the one Media's select lists. */
function levelLabel(
  manifest: Pick<ProjectManifest, 'severityModels'>,
  level: SeverityLevel | null,
): string {
  if (level === null) return '';
  for (const model of manifest.severityModels) {
    const label =
      level === 'uncertain'
        ? model.uncertain?.label
        : model.levels.find((l) => l.value === level)?.label;
    if (label) return label;
  }
  return '';
}

function showPhotos(filter: PhotoViewFilter): PhotoViewResult {
  const ws = workspace.getState();
  const project = ws.project;
  if (!project) return { shown: 0, total: 0, severity: null, severityLabel: '' };
  // the index Media draws its tiles from (usePhotoFindings): issues on photos and the review's
  // detections of this project, so the count said is the count shown
  const review = detections.getState();
  const index = findingsIndex(
    project.manifest,
    ws.issues,
    review.projectId === project.id ? review.review.detections : [],
  );
  const scope = filter.scope ?? null;
  // nothing graded: no level to show, which is not an error
  const severity =
    filter.severity === 'highest'
      ? highestLevel(index, scope?.ids ?? null)
      : (filter.severity ?? null);
  setMediaView({
    onlyFindings: filter.onlyFindings ?? false,
    order: filter.order ?? 'file',
    severity,
    scope,
  });
  const view = mediaView.getState();
  let shown = 0;
  let total = 0;
  for (const layer of project.manifest.layers) {
    if (layer.kind !== 'photos') continue;
    total += layer.items.length;
    shown += photosInView(layer.items, layer.id, index, view).length;
  }
  return { shown, total, severity, severityLabel: levelLabel(project.manifest, severity) };
}

function showIssues(filter: IssueViewFilter): { shown: number } {
  setIssueView({
    ...DEFAULT_ISSUE_VIEW,
    sev: filter.severity ?? null,
    classId: filter.classId ?? '',
    status: filter.status ?? '',
    text: filter.text ?? '',
    sort: filter.sort ?? 'code',
    dir: filter.dir ?? 'asc',
    scope: filter.scope ?? null,
  });
  // the search text is applied inside the register (over code, title, note, author and class
  // label) and is not counted here: with a text set the register can show fewer than this
  return { shown: issuesInView(workspace.getState().issues, issueView.getState()).length };
}

/**
 * Remember the screen, both filters, the agent column, the stage and the evidence; the returned
 * function puts them back. It sets only what it remembered: going back to Issues does not unfold
 * the column the way the agent opening Issues does. Once another project is open (or none) the
 * view it remembered is gone, and it does nothing.
 */
function captureView(): () => void {
  const projectId = workspace.getState().project?.id ?? null;
  const { screen: screenBefore, stageMode, stageAuto, agentDockCollapsed } = shell.getState();
  const media = mediaView.getState();
  const issues = issueView.getState();
  const split = projectId === null ? undefined : stagePrefs.getState().byProject[projectId]?.split;
  const shown = evidence.getState().open;
  return () => {
    if ((workspace.getState().project?.id ?? null) !== projectId) return;
    setMediaView(media);
    setIssueView(issues);
    // evidence opened since closes the way its x closes it; the evidence that was open comes back
    // on the finding it was on
    if (!shown) closeEvidence();
    else if (evidence.getState().open !== shown) evidence.setState({ open: shown });
    if (projectId !== null && stagePrefs.getState().byProject[projectId]?.split !== split)
      stagePrefs.getState().update(projectId, { split });
    const sh = shell.getState();
    // set as one, not through setStageMode: a mode the app chose for a video-first project is
    // still the app's choice after an undo
    if (sh.stageMode !== stageMode || sh.stageAuto !== stageAuto)
      shell.setState({ stageMode, stageAuto });
    sh.setAgentDock(agentDockCollapsed);
    if (shell.getState().screen !== screenBefore) sh.go(screenBefore);
  };
}

function viewFilters(): ViewFilters {
  const media = mediaView.getState();
  const issues = issueView.getState();
  return {
    photos: {
      onlyFindings: media.onlyFindings,
      order: media.order,
      severity: media.severity,
      scope: media.scope?.label ?? null,
    },
    issues: {
      severity: issues.sev,
      classId: issues.classId || null,
      status: issues.status || null,
      text: issues.text,
      sort: issues.sort,
      scope: issues.scope?.label ?? null,
    },
  };
}

/** Register the hooks, once at startup (bootstrap). Returns the function that takes them back. */
export function registerAgentHooks(): () => void {
  return registerAppHooks({
    screen,
    openScreen,
    showPhotos,
    showIssues,
    showEvidence: openEvidence,
    captureView,
    viewFilters,
  });
}
