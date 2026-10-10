/**
 * The processing tools (the pipeline pack) as the renderer knows them: what is installed, an
 * archive found on this computer, a running install and the start notice.
 *
 * - Settings, Processing tools (`screens/settings/ProcessingTools.tsx`) is the one place that
 *   installs, updates and removes packs.
 * - `openProcessingTools()` takes a person there from anywhere: call it from a "pack missing" or
 *   "pack too old" message instead of describing folders.
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
 * Open Settings, Processing tools: where the pipeline pack is installed and updated from a file.
 * The one call for every "the pack is missing" or "the pack is too old" message.
 */
export function openProcessingTools(): void {
  shell.getState().openSettingsPage('tools');
}
