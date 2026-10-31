import { t, useT } from '@aio/ui';
import { useEffect, type HTMLAttributes } from 'react';
import { shell, useShell } from '../shell';
import { isSidebarFolded } from '../store';
import { useMeasure } from '../survey/measureStore';
import { PANEL_ID } from './PanelHandle';
import { LayersHandle } from './Rail';
import { Datasets } from './Sidebar';
import { SidebarProcessing } from './SidebarProcessing';

export interface LayersColumnProps {
  /** The `shell.sidebar` split's separator (App.tsx): the drag handle on the inner edge. */
  resize?: HTMLAttributes<HTMLDivElement>;
}

/**
 * The Layers column beside the rail, on the Scene only (UI revision W11, D1): the Processing
 * section with "Create maps from photos" in plain sight (founder, 31 Oct 2026), then the dataset
 * tree at full height with its date folders, eyes and import tools. It folds away whole (Ctrl+B,
 * Ctrl+L, the title bar's Layers toggle, the tab on its edge) and is dragged wider or narrower on
 * its inner edge; below 1280 px the Scene folds it on its own (shell/autoFold.ts).
 */
export function LayersColumn({ resize }: LayersColumnProps = {}) {
  useT();
  const screen = useShell((s) => s.screen);
  const collapsed = useShell(isSidebarFolded);
  // a reveal of a measurement (the telecom panel's Measurements) opens a folded column; finishing
  // a shape reveals it without opening
  const revealSeq = useMeasure((s) => s.reveal?.seq);
  const revealOpens = useMeasure((s) => s.reveal?.openSidebar === true);
  useEffect(() => {
    if (revealSeq === undefined || !revealOpens) return;
    const sh = shell.getState();
    if (isSidebarFolded(sh)) void sh.toggleSidebar();
  }, [revealSeq, revealOpens]);
  if (screen !== 'scene') return null;

  return (
    <aside
      className="sidebar layers-col"
      id={PANEL_ID.left}
      aria-label={t('nav.layers')}
      data-testid="layers-column"
      // folded, it slides out of sight and takes no focus (the toggle and Ctrl+B bring it back)
      inert={collapsed}
    >
      {/* Create maps from photos in plain sight, under its own heading (founder, 31 Oct) */}
      <SidebarProcessing />
      <div className="sb-scroll">
        <Datasets collapsed={false} />
      </div>
      {resize && (
        <div
          {...resize}
          className="split-handle sb-resize"
          aria-label={t('panel.resizeLeft')}
          aria-controls={PANEL_ID.left}
        >
          <span className="kbd split-readout" aria-hidden="true" />
        </div>
      )}
      {/* folded, the tab waits on the rail's edge instead (Rail.tsx) */}
      {!collapsed && <LayersHandle collapsed={false} />}
    </aside>
  );
}
