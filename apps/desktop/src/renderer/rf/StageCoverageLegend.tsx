/**
 * The coverage card on the stage (d-ba ruling I3, option b; spec F1 revised): `Stage.tsx` gives it
 * one corner slot (`rfLegend`, a foot corner away from the readout) while `useCoverageLegendShown()`
 * holds, and renders `<StageCoverageLegend />` there: the Coverage chip, and the legend under it.
 * Everything the card shows is read here, from the RF stores, so the stage's block stays small.
 */
import { useMemo } from 'react';
import { useT } from '@aio/ui';
import { CoverageChip, useChipState } from './CoverageChip';
import { CoverageLegend, type CoverageLegendProps } from './CoverageLegend';
import { useRfLayer } from './coverageDisplay';
import { shownGrids, useCoverage } from './coverageStore';
import { useRf } from './rfStore';

/** A run's time of day, as the legend's title tag shows it. */
function timeOfDay(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** The legend's props for what the Coverage layer draws now; null when it draws nothing. */
export function useCoverageLegendProps(): CoverageLegendProps | null {
  const visible = useRfLayer((s) => s.visible);
  const dirty = useRf((s) => s.dirty);
  const grids = useCoverage((c) => shownGrids(c, { dirty }));
  const view = useRf((s) => s.view);
  const sectors = useRf((s) => s.sectors);
  const runs = useRf((s) => s.runs);
  const selectedRunId = useRf((s) => s.selectedRunId);
  return useMemo(() => {
    if (!visible || !grids) return null;
    const run =
      grids.source === 'run' ? (runs.find((r) => r.runId === selectedRunId) ?? null) : null;
    // a run is drawn with the study and sector names it ran with; the preview with the edits
    const file = run ? run.inputs.sectors : sectors;
    const names = new Map(file.sectors.map((s) => [s.id, s.name]));
    return {
      view,
      study: file.study,
      // in the drawn grid's sector order, which the best-server colours follow
      sectors: grids.sectorIds.map((id) => ({ id, name: names.get(id) ?? id })),
      // the run's time of day keeps the title on one line (the RF tab names the whole date)
      source: run ? { kind: 'run', at: timeOfDay(run.createdAt) } : { kind: 'preview' },
      reduced: grids.reducedFrom ?? null,
    };
  }, [visible, grids, view, sectors, runs, selectedRunId]);
}

/**
 * Whether the stage gives the coverage card a corner: the project has antennas (the Coverage chip
 * shows, spec F1 revised), or the layer is on and draws something.
 */
export function useCoverageLegendShown(): boolean {
  const chip = useChipState().kind !== 'hidden';
  return useCoverageLegendProps() !== null || chip;
}

/**
 * The coverage card in its stage corner: the Coverage chip as its header, and under it the legend
 * while the layer draws something. While dates are compared the chip gives way (rf.css).
 */
export function StageCoverageLegend() {
  const t = useT();
  const p = useCoverageLegendProps();
  const chip = useChipState().kind !== 'hidden';
  if (p) return <CoverageLegend {...p} header={chip ? <CoverageChip /> : null} />;
  if (!chip) return null;
  return (
    <section
      className="rf-card overlay-box"
      data-surface="dark"
      aria-label={t('rf.chip.label')}
      data-testid="rf-card"
    >
      <CoverageChip />
    </section>
  );
}
