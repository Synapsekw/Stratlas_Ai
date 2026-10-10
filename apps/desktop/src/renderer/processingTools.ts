/**
 * The processing tools (the pipeline pack) as the renderer knows them: what is installed, an
 * archive found on this computer, a running install and the start notice.
 *
 * - Settings, Processing tools (`screens/settings/ProcessingTools.tsx`) is the one place that
 *   installs, updates and removes packs.
 * - `openProcessingTools()` takes a person there from anywhere: the one helper behind every
 *   **Update processing tools** (there is no second one in photogrammetry/ any more).
 * - After an install or a removal the Jobs store reads the pack again, so the Jobs header and
 *   every screen that reads `useProcessingTools((s) => s.status)` follow without a restart.
 *   `revision` goes up each time the installed packs change, for views that ask main themselves
 *   (`useEffect(..., [revision])`).
 */
import type { AioBridge } from '@aio/schema';
import { useStore } from 'zustand';
import {
  createProcessingToolsStore,
  type NoticeStorage,
  type ProcessingTools,
} from './processingToolsStore';
import { photoUi } from './photogrammetry/store';
import { bridge, jobs, shell } from './shell';

export { packNoticeKey, type ProcessingTools } from './processingToolsStore';

const aio = window.aio as AioBridge | undefined;
const localStore = (): NoticeStorage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** The app's one store of the processing tools. */
export const processingTools = createProcessingToolsStore(bridge, aio?.on.bind(aio), {
  storage: localStore(),
  // the Jobs header and whoever reads the Jobs store's runtime see the new pack at once
  onChanged: () => void jobs.getState().refresh(),
});

export function useProcessingTools<T>(selector: (s: ProcessingTools) => T): T {
  return useStore(processingTools, selector);
}

/**
 * Open Settings, Processing tools: where the processing tools (the pipeline pack) are installed
 * and updated from a file. The one call behind every **Update processing tools**: the Create maps
 * from photos dialog, the Jobs screen, the start notice and the first-start checklist.
 *
 * The Create maps dialog lies over the screen, so it closes; Settings then offers the way back to
 * it once the tools are installed (`resumeAfterTools`).
 */
export function openProcessingTools(): void {
  const photo = photoUi.getState();
  processingTools.setState({ resume: photo.view?.kind === 'wizard' ? 'create-maps' : null });
  photo.close();
  shell.getState().openSettingsPage('tools');
}

/** Back to what **Update processing tools** interrupted: Create maps from photos, which checks this computer again. */
export function resumeAfterTools(): void {
  if (processingTools.getState().resume !== 'create-maps') return;
  processingTools.setState({ resume: null });
  shell.getState().go('jobs');
  photoUi.getState().openWizard();
}
