/**
 * The body of each old tab id (stage island D11), as the right panel's sections and the workbench
 * drawer show it: today's benches and panels by import. Selection shows what was clicked on the
 * site, a pile included (founder, 30 Oct), or says to click something; Issues is the summary (D8).
 */
import { IconButton, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { ChangesTab } from '../../change';
import { EnvironmentTab } from '../../environment/EnvironmentTool';
import { IssueCard } from '../../issueCard/IssueCard';
import { CleanupTab } from '../../pointcloud/CleanupTab';
import { RoadPanel } from '../../road/RoadPanel';
import { HydroTab } from '../../survey/Hydro';
import { MeasurementPanel } from '../../survey/MeasurementPanel';
import { useMeasure } from '../../survey/measureStore';
import { OverlaysPanel } from '../../survey/Overlays';
import { isPile } from '../../survey/pile/openPile';
import { PilePanel } from '../../survey/pile/PilePanel';
import { QaSide } from '../../survey/Qa';
import { CutawayTab } from '../CutawayTool';
import { SelectionCard } from '../SelectionCard';
import { AnnotateBench } from './benches/AnnotateBench';
import { CloudBench } from './benches/CloudBench';
import { DisplayBench } from './benches/DisplayBench';
import { JobsBench } from './benches/JobsBench';
import { MeasureBench } from './benches/MeasureBench';
import { ReviewBench } from './benches/ReviewBench';
import { RfBench } from './benches/RfBench';
import { RoadBench } from './benches/RoadBench';
import { ThermalBench } from './benches/ThermalBench';
import { VideoBench } from './benches/VideoBench';
import { VolumesBench } from './benches/VolumesBench';
import { IssuesSummary } from './project/IssuesSummary';
import { sectionStore, useSections } from './sectionState';
import type { TabId } from './tabsModel';

/** A bench's header row: Collapse all or Expand all, one icon button (D16). */
function BenchHead({ bench }: { bench: TabId }) {
  const t = useT();
  const sections = useSections(bench);
  const folded = useStore(sectionStore, (s) => s.byBench[bench]?.all === false);
  return (
    <div className="wb-bench-head">
      <IconButton
        icon={folded ? 'chevdown' : 'chevup'}
        label={folded ? t('wb.expandAll') : t('wb.collapseAll')}
        onClick={() => {
          if (folded) sections.expandAll();
          else sections.collapseAll();
        }}
      />
    </div>
  );
}

/** The focused pile, if the focused measurement is one. */
function useFocusedPile(): string | null {
  return useMeasure((s) => {
    const m = s.file.measurements.find((x) => x.id === s.focus);
    return m && isPile(m) ? m.id : null;
  });
}

/** What Selection shows, in the order it is looked for. */
export type SelectionShows = 'pile' | 'road' | 'issue' | 'measurement' | 'empty' | 'card';

/** What Selection shows now (the body below, and how tall the right panel lets it be). */
export function useSelectionShows(road: boolean): SelectionShows {
  const pile = useFocusedPile();
  const focus = useMeasure((s) => s.focus);
  const issue = useWorkspace((s) => s.selection?.kind === 'issue');
  const selected = useWorkspace((s) => s.selection !== null);
  if (pile) return 'pile';
  if (road) return 'road';
  if (issue) return 'issue';
  // a picked measurement (nothing else selected): its card, as a pile's panel
  if (!selected && focus !== null) return 'measurement';
  return selected ? 'card' : 'empty';
}

/**
 * Selection: a clicked pile's panel, the road, an issue's card, a picked measurement's card, the
 * selected thing, or a hint.
 */
export function SelectionBody({ road }: { road: boolean }) {
  const t = useT();
  const shows = useSelectionShows(road);
  const pile = useFocusedPile();
  const issueId = useWorkspace((s) => (s.selection?.kind === 'issue' ? s.selection.id : null));
  if (shows === 'pile' && pile)
    return (
      <div className="wb-pile" data-testid="selection-pile">
        <PilePanel id={pile} />
      </div>
    );
  if (shows === 'road') return <RoadPanel />;
  if (shows === 'issue' && issueId)
    return <IssueCard issueId={issueId} place="scene" className="ctx-fill" />;
  if (shows === 'measurement')
    return (
      <div className="wb-pile" data-testid="selection-measurement">
        <MeasurementPanel />
      </div>
    );
  if (shows === 'empty')
    return (
      <p className="wb-empty" data-testid="selection-empty">
        {t('wb.selection.empty')}
      </p>
    );
  return <SelectionCard />;
}

/** What an old tab id shows. */
export function FrontBody({ front, road }: { front: TabId; road: boolean }) {
  if (front === 'volumes') return <VolumesBench />;
  if (front === 'changes') return <ChangesTab className="ctx-fill" />;
  if (front === 'issues') return <IssuesSummary />;
  if (front === 'selection') return <SelectionBody road={road} />;
  // Road, Volumes and environment benches
  if (front === 'road')
    return (
      <>
        <BenchHead bench="road" />
        <RoadBench />
      </>
    );
  if (front === 'environment') return <EnvironmentTab />;
  if (front === 'cutaway') return <CutawayTab />;
  // Display and Point cloud benches
  if (front === 'cleanup') return <CleanupTab />;
  if (front === 'display' || front === 'clouds') {
    return (
      <>
        <BenchHead bench={front} />
        {front === 'display' ? <DisplayBench /> : <CloudBench />}
      </>
    );
  }
  // Video, Annotate and Jobs benches
  if (front === 'jobs') return <JobsBench />;
  if (front === 'video' || front === 'annotate') {
    return (
      <>
        <BenchHead bench={front} />
        {front === 'video' ? <VideoBench /> : <AnnotateBench />}
      </>
    );
  }
  // Measure: the catalogue and the live tool card (its "In this project" list is Project's)
  if (front === 'measure')
    return (
      <>
        <BenchHead bench={front} />
        <MeasureBench />
      </>
    );
  if (front === 'qa') return <QaSide />;
  if (front === 'overlays') return <OverlaysPanel />;
  // Engineering model review: uses the same section controls and drawer as other benches.
  if (front === 'review')
    return (
      <>
        <BenchHead bench={front} />
        <ReviewBench />
      </>
    );
  // RF coverage bench (rf-coverage T9): the Site, Sector and Results sections (spec D21)
  if (front === 'rf')
    return (
      <>
        <BenchHead bench={front} />
        <RfBench />
      </>
    );
  // Thermal bench (thermal analysis M1): the photo, its palette, settings and the filmstrip
  if (front === 'thermal') return <ThermalBench />;
  return lastBody(front);
}

/** The one id left once every other has its body above: a new TabId without one fails here. */
function lastBody(front: 'hydro') {
  return <HydroTab key={front} />;
}
