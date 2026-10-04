import { useWorkspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShell } from '../shell';
import { AlignModel } from './AlignModel';
import { CalibrateVideo } from './CalibrateVideo';
import { EmptyProjectHint, ImportLayer } from './ImportPanel';
import { NewProjectWizard } from './NewProjectWizard';
import { builder, useBuilder } from './state';
import './builder.css';

/** The 3D pane element once the stage is mounted (for overlays drawn on it). */
function usePane(): HTMLElement | null {
  const screen = useShell((s) => s.screen);
  const [pane, setPane] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => {
      setPane(document.querySelector<HTMLElement>('.pane-3d'));
    };
    find();
    const mo = new MutationObserver(find);
    const main = document.querySelector('.main');
    if (main) mo.observe(main, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
    };
  }, [screen]);
  return pane;
}

/** Wizard, drag-and-drop import and the alignment tools, over the whole app. */
export function BuilderLayer() {
  const align = useBuilder((s) => s.align);
  const screen = useShell((s) => s.screen);
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const pane = usePane();

  // a tool belongs to its project
  useEffect(() => {
    builder.getState().stopAlign();
  }, [projectId]);

  return (
    <>
      <NewProjectWizard />
      <ImportLayer />
      {pane && createPortal(<EmptyProjectHint />, pane)}
      {screen === 'scene' && align?.kind === 'mesh' && (
        <AlignModel key={align.layerId} layerId={align.layerId} />
      )}
      {screen === 'scene' && align?.kind === 'video' && pane && (
        <CalibrateVideo key={align.layerId} layerId={align.layerId} />
      )}
    </>
  );
}
