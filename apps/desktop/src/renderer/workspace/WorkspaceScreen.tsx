import { formatDate, neighbourClip, Timeline, type TimelineModel, useT } from '@aio/ui';
import { clock, useWorkspace, workspace } from '@aio/workspace';
import { useCallback, type ReactElement } from 'react';
import { useStore } from 'zustand';
import { useMeasure } from '../survey/measureStore';
import { PANEL_ID, PanelHandle } from '../shell/PanelHandle';
import { CaptionBacking } from '../shell/RightHeader';
import { shell, useShell } from '../shell';
import { ChainageRuler } from '../road/ChainageRuler';
import { useIsRoad } from '../road/useRoadMap';
import { NoProject } from '../screens/NoProject';
import { usesLanes } from './lanes';
import { LayerPlaceholder } from './LayerPlaceholder';
import { pickClip, selectClip } from './pickClip';
import { Stage } from './Stage';
import { useTimeline } from './timeline';
import { timelineActions, useTimelineBinding } from './timelineBinding';
import { DatesStrip } from './dates/DatesStrip';
import {
  bottomPref,
  bottomSlot,
  datedCount,
  offersSwitch,
  useTimelineShown,
  type BottomPref,
  type BottomSlot,
} from './timelinePref';
import { LaneFocusFollow, WorkspaceLanes } from './WorkspaceLanes';
import { Drawer } from './workbench/Drawer';
import { RightSidebar, useSidebarSplit } from './workbench/RightSidebar';

const EMPTY_MODEL: TimelineModel = {
  clips: [],
  groups: [],
  issues: [],
  photos: [],
  captures: [],
  range: null,
};

function WorkspaceTimeline() {
  const { project, playing, rate, activeClip, selectedIssue, model: built } = useTimelineBinding();
  const model = built ?? EMPTY_MODEL;
  const capture = project?.manifest.captures.at(-1);
  // stable while the model is: the memoized timeline then renders only when something it shows changes
  const onClip = useCallback(
    (id: string, atMs?: number) => {
      // A clip bar selects its clip and seeks; Space or Play plays.
      pickClip(
        id,
        atMs,
        model.clips.find((c) => c.layerId === id),
      );
    },
    [model],
  );
  const onStep = useCallback(
    (dir: 1 | -1) => {
      const c = neighbourClip(model, workspace.getState().activeClip, dir);
      if (!c) return;
      selectClip(c.layerId);
      workspace.getState().setTime(c.startMs);
    },
    [model],
  );

  return (
    <Timeline
      {...timelineActions}
      className="ws-tl"
      model={model}
      clock={clock}
      playing={playing}
      rate={rate}
      activeClip={activeClip}
      selectedIssue={selectedIssue}
      context={`${capture ? `${formatDate(capture.date)} · ` : ''}UTC`}
      onClip={onClip}
      onStep={onStep}
    />
  );
}

/** A volume measurement drawn as a polygon: the project has stockpiles for the dates strip. */
const hasPiles = (ms: readonly { tool: string; family: string }[]) =>
  ms.some((m) => m.tool === 'volume' && m.family === 'polygon');

/**
 * What the bottom slot shows for the open project (spec section 5): the dates strip, the footage
 * timeline or nothing, and whether the "Dates | Footage" switch is offered.
 */
function useBottomSlot(): { slot: BottomSlot; switchable: boolean } {
  const project = useWorkspace((s) => s.project);
  const shown = useTimelineShown(project);
  const hasVolumes = useMeasure((s) => hasPiles(s.file.measurements));
  const pref = useStore(bottomPref, (s) => (project ? (s.byProject[project.id] ?? null) : null));
  if (!project) return { slot: 'none', switchable: false };
  const x = {
    hasVideo: project.manifest.layers.some((l) => l.kind === 'video'),
    datedCaptures: datedCount(project.manifest.captures),
    hasVolumes,
    pref,
    shown,
  };
  return { slot: bottomSlot(x), switchable: shown && offersSwitch(x) };
}

/** "Dates | Footage" at the left of the bottom bar, remembered per project. */
function BottomSwitch({ slot }: { slot: BottomSlot }): ReactElement {
  const t = useT();
  const choose = (pref: BottomPref) => {
    const id = workspace.getState().project?.id;
    if (id) bottomPref.getState().set(id, pref);
  };
  return (
    <div className="seg tl-switch" role="group" aria-label={t('strip.switch.aria')}>
      {(['dates', 'footage'] as const).map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={slot === k}
          data-testid={`bottom-switch-${k}`}
          onClick={() => {
            choose(k);
          }}
        >
          {t(k === 'dates' ? 'strip.switch.dates' : 'strip.switch.footage')}
        </button>
      ))}
    </div>
  );
}

export function WorkspaceScreen() {
  const t = useT();
  const hasProject = useWorkspace((s) => s.project !== null);
  const rightCollapsed = useShell((s) => s.rightCollapsed);
  const road = useIsRoad();
  const right = useSidebarSplit(rightCollapsed, hasProject);
  const { containerRef: rightSplitRef, separatorProps: rightResize } = right;
  const project = useWorkspace((s) => s.project);
  const { slot, switchable } = useBottomSlot();
  const dateIndex = useTimeline((s) => s.index);
  const lanes = !road && project !== null && usesLanes(project.manifest, dateIndex);
  if (!hasProject) return <NoProject view="Scene" />;

  return (
    <section
      ref={rightSplitRef}
      className={`screen ws${rightCollapsed ? ' right-off' : ''}${road ? ' road' : ''}`}
      aria-label="Scene"
      data-fold={right.phase ?? undefined}
      onTransitionEnd={right.onTransitionEnd}
      onAnimationEnd={right.onAnimationEnd}
    >
      <h1 className="sr-only">{t('nav.scene')}</h1>
      {lanes && <LaneFocusFollow />}
      <Stage />
      <LayerPlaceholder />
      <div
        className="tl-wrap"
        data-bottom={road ? 'road' : slot}
        data-switch={!road && switchable ? '' : undefined}
      >
        {!road && switchable && <BottomSwitch slot={slot} />}
        {/* folded away, the timeline comes back from the island's View tile */}
        {road ? (
          <ChainageRuler />
        ) : slot === 'none' ? null : slot === 'dates' ? (
          <DatesStrip />
        ) : lanes ? (
          <WorkspaceLanes />
        ) : (
          <WorkspaceTimeline />
        )}
      </div>
      <div
        {...rightResize}
        className="split-handle rp-resize"
        aria-label={t('panel.resizeRight')}
        aria-controls={PANEL_ID.right}
      >
        <span className="kbd split-readout" aria-hidden="true" />
      </div>
      <PanelHandle
        side="right"
        collapsed={rightCollapsed}
        shortcut="global.rightPanel"
        onToggle={shell.getState().toggleRight}
      />
      <RightSidebar />
      <CaptionBacking />
      <Drawer />
    </section>
  );
}
