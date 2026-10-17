/**
 * The Coverage group of the Display bench's layer list (spec D12, D23a; ruling R3): built from the
 * RF store, not the manifest. One row with an eye that hides the coverage on the map and in the
 * 3D view together, and the opacity slider the legend also shows (one state, `coverageDisplay.ts`).
 * Shown when the project has an antenna inventory or a coverage run.
 */
import { IconButton, Row, useT } from '@aio/ui';
import { Section } from '../workspace/workbench/Section';
import type { TabId } from '../workspace/workbench/tabsModel';
import { shownGrids, useCoverage } from './coverageStore';
import { setRfLayer, useRfLayer } from './coverageDisplay';
import { useRf } from './rfStore';
import { VIEW_KEY } from './rfText';
import './rf.css';

export function CoverageGroup({ bench }: { bench: TabId }) {
  const t = useT();
  const has = useRf((s) => s.antennas !== null || s.runs.length > 0);
  const view = useRf((s) => s.view);
  const dirty = useRf((s) => s.dirty);
  const previewError = useRf((s) => (s.preview.status === 'error' ? s.preview.error : null));
  const grids = useCoverage((c) => shownGrids(c, { dirty }));
  const runError = useCoverage((c) => c.runError);
  const visible = useRfLayer((s) => s.visible);
  const opacity = useRfLayer((s) => s.opacity);
  if (!has) return null;
  const pct = Math.round(opacity * 100);
  const what =
    grids === null
      ? t('rf.layer.none')
      : grids.source === 'preview'
        ? t('rf.layer.preview', { view: t(VIEW_KEY[view]) })
        : t('rf.layer.run', { view: t(VIEW_KEY[view]) });
  return (
    <Section id="display-coverage" bench={bench} title={t('rf.layer.group')} defaultOpen>
      <Row
        kind="tree"
        className="wb-eye-row"
        data-testid="display-coverage"
        icon="raster"
        label={t('rf.layer.row')}
        actions={
          <IconButton
            icon={visible ? 'eye' : 'eye-off'}
            label={t('rf.layer.eye')}
            pressed={visible}
            data-testid="display-coverage-eye"
            onClick={() => {
              setRfLayer({ visible: !visible });
            }}
          />
        }
      />
      <div className="wb-controls rf-layer-ctl">
        <div className="rf-legend-ctl">
          <label htmlFor="rf-layer-opacity">{t('rf.legend.opacity')}</label>
          <input
            id="rf-layer-opacity"
            type="range"
            min={0}
            max={100}
            step={5}
            value={pct}
            aria-valuetext={`${String(pct)}%`}
            data-testid="display-coverage-opacity"
            onChange={(e) => {
              setRfLayer({ opacity: Number(e.target.value) / 100 });
            }}
          />
          <output className="mono" htmlFor="rf-layer-opacity">
            {pct}%
          </output>
        </div>
        <p className="wb-note" data-testid="display-coverage-what">
          {what}
        </p>
        {runError && (
          <p className="wb-note rf-err">{t('rf.layer.readFailed', { error: runError })}</p>
        )}
        {previewError && (
          <p className="wb-note rf-err">{t('rf.layer.previewFailed', { error: previewError })}</p>
        )}
      </div>
    </Section>
  );
}
