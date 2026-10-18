import { createStore } from 'zustand/vanilla';
import { workspace } from '@aio/workspace';
import { isIssueEditing } from '../issueCard/state';
import { shell } from '../shell';
import { showBench } from '../workspace/workbench/followTool';
import { orderTabs } from '../workspace/workbench/tabsModel';
import { workbench } from '../workspace/workbench/workbenchStore';
import { engineeringUiOn } from './flags';
import { setCorrectionDraftKey } from './correctionDraft';

export { ENGINEERING_SOURCES, engineeringUiOn } from './flags';

/** Whether the setup or the run panel is open, and which layers the setup starts with. */
export const engineerUi = createStore<{
  open: boolean;
  review: boolean;
  reviewMode: 'components' | 'corrections';
  /** Scene initialization survives moving this content between sidebar and drawer. */
  framedReview: string | null;
  readyReview: string | null;
  /** Layers chosen as sources when the setup opens (the layer it was opened from). */
  preselect: string[];
  show(preselect?: readonly string[]): void;
  hide(): void;
}>((set) => ({
  open: false,
  review: false,
  reviewMode: 'components',
  framedReview: null,
  readyReview: null,
  preselect: [],
  show: (preselect = []) => {
    set({
      open: true,
      review: false,
      reviewMode: 'components',
      framedReview: null,
      readyReview: null,
      preselect: [...preselect],
    });
    workbench.getState().close('review');
  },
  hide: () => {
    set({
      open: false,
      review: false,
      reviewMode: 'components',
      framedReview: null,
      readyReview: null,
    });
    workbench.getState().close('review');
  },
}));

/** Completed results preserve other panels and wait behind issue edits without starting a tool. */
export function openEngineeringReview(automatic = false): void {
  engineerUi.setState({ open: true, review: true });
  const waitingForIssue = automatic && isIssueEditing();
  if (automatic)
    workbench.setState((state) => {
      const waiting =
        waitingForIssue && !state.waiting.includes('review')
          ? [...state.waiting, 'review' as const]
          : state.waiting;
      return {
        // open() replaces an unpinned panel. A background result must keep that work available.
        tabs: orderTabs(
          state.tabs.some((tab) => tab.id === 'review')
            ? state.tabs
            : [...state.tabs, { id: 'review', live: false, pinned: false, fixed: false }],
        ),
        waiting,
        attention: waiting[0] ?? null,
      };
    });
  if (!waitingForIssue) showBench('review');
}

/** Closing the review is presentation-only. The run and its saved corrections remain intact. */
export function followEngineeringReview(): () => void {
  const offBench = workbench.subscribe((next, prev) => {
    if (
      engineerUi.getState().review &&
      prev.tabs.some((tab) => tab.id === 'review') &&
      !next.tabs.some((tab) => tab.id === 'review')
    )
      engineerUi.getState().hide();
  });
  const offProject = workspace.subscribe((next, prev) => {
    if (next.project?.id !== prev.project?.id) {
      engineerUi.getState().hide();
      setCorrectionDraftKey(null);
    }
  });
  return () => {
    offBench();
    offProject();
  };
}

/**
 * Create engineering model from anywhere (the palette, a layer's right-click menu, the Model
 * builder, an import result): opens the setup with those layers chosen, or the run panel during a
 * run. It only opens: nothing is measured or sent until the person starts.
 */
export function createEngineeringModel(preselect: readonly string[] = []): void {
  if (!engineeringUiOn()) return;
  const s = shell.getState();
  s.setPalette(false);
  if (s.screen !== 'scene') s.go('scene');
  engineerUi.getState().show(preselect);
}
