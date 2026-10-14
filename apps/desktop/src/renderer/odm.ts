/**
 * The processing engine (ODM) as the renderer knows it: the app's one store of its status and
 * install. Settings, Processing tools (`screens/settings/ProcessingEngine.tsx`) is the one place
 * that installs and removes it; `openProcessingEngine()` takes a person there from anywhere.
 */
import type { AioBridge } from '@aio/schema';
import { useStore } from 'zustand';
import { createOdmStore, type OdmUi } from './odmStore';
import { photoUi } from './photogrammetry/store';
import { processingTools } from './processingTools';
import { bridge, shell } from './shell';

const aio = window.aio as AioBridge | undefined;

/** The app's one store of the processing engine. */
export const odm = createOdmStore(bridge, aio?.on.bind(aio));

export function useOdm<T>(selector: (s: OdmUi) => T): T {
  return useStore(odm, selector);
}

/**
 * Open Settings, Processing tools at the Processing engine card. The Create maps from photos
 * dialog lies over the screen, so it closes; the card then offers the way back to it once ODM is
 * installed (`resumeAfterTools`).
 */
export function openProcessingEngine(): void {
  const photo = photoUi.getState();
  processingTools.setState({ resume: photo.view?.kind === 'wizard' ? 'create-maps' : null });
  photo.close();
  shell.getState().openSettings('processing-engine');
}
