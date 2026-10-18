/**
 * Step 2 of the Coverage panel, Sectors & equipment: one row per sector (its best-server colour,
 * name and bearing, the equipment and band, and a state tag), then a row for the units in no
 * sector. Expanding a row shows its body, which the bench renders (today's sector controls and
 * unit fields); one row is open at a time. The toolbar (group by bearing, add sector) sits above
 * the rows and the orphan settings below them (`children`).
 */
import { getEntry } from '@aio/rf';
import type { RfAntennaSettings } from '@aio/schema';
import { Chip, Icon, useT, type MessageKey } from '@aio/ui';
import { useId, useMemo, type ReactElement, type ReactNode } from 'react';
import { hex, sectorColour } from '../coverageRamp';
import { sectorBearing } from '../rfFields';
import { useRf } from '../rfStore';
import { fmt } from './parts';
import { Step } from './Step';
import { groupTag, type StepTag } from './stepTag';

/** The key of the row of units in no sector. */
export const UNGROUPED = 'ungrouped';

export interface StepSectorsProps {
  /** The open row: a sector id or `UNGROUPED`; null when every row is folded. */
  expanded: string | null;
  onToggle: (key: string) => void;
  toolbar?: ReactNode;
  /** The body of the open row. */
  renderBody: (key: string) => ReactNode;
  /** Under the rows: the settings of antennas no longer found. */
  children?: ReactNode;
}

/** A row tag: a step tag, or `out` for units in no sector that cannot take part in a run. */
type RowTag = StepTag | 'out';

const TAG_TONE: Record<RowTag, 'acc' | 'warn' | undefined> = {
  out: undefined,
  'needs-setup': 'warn',
  'ai-low': 'warn',
  rules: undefined,
  ai: 'acc',
  'from-export': 'acc',
  edited: 'acc',
};

interface RowModel {
  key: string;
  title: string;
  summary: string;
  tag: RowTag;
  colour: string | null;
}

function Row({
  row,
  open,
  onToggle,
  body,
}: {
  row: RowModel;
  open: boolean;
  onToggle: () => void;
  body: ReactNode;
}): ReactElement {
  const t = useT();
  const bodyId = useId();
  const tone = TAG_TONE[row.tag];
  return (
    <div
      className="rf-step-row"
      data-testid={`rf-step-sector-${row.key}`}
      data-tag={row.tag}
      data-open={open}
    >
      <button
        type="button"
        className="rf-step-row-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
      >
        <Icon name="chev-r" size={12} />
        <span
          className="rf-step-swatch"
          data-none={row.colour === null || undefined}
          style={row.colour === null ? undefined : { background: row.colour }}
          aria-hidden="true"
        />
        <span className="rf-step-row-t">
          <span className="rf-step-row-name">{row.title}</span>
          <small className="rf-step-row-sum">{row.summary}</small>
        </span>
        <Chip kind="tag" {...(tone ? { tone } : {})}>
          {t(`rf.steps.tag.${row.tag}` as MessageKey)}
        </Chip>
      </button>
      {open && (
        <div className="rf-step-row-bd" id={bodyId}>
          {body}
        </div>
      )}
    </div>
  );
}

export function StepSectors({
  expanded,
  onToggle,
  toolbar,
  renderBody,
  children,
}: StepSectorsProps): ReactElement {
  const t = useT();
  const sectors = useRf((s) => s.sectors.sectors);
  const units = useRf((s) => s.antennas?.units);
  const rows = useRf((s) => s.rows);
  const includeDrafts = useRf((s) => s.includeUnreviewed);
  const all = useRf((s) => s.catalogue);
  const catalogue = useMemo(() => all.map((c) => c.entry), [all]);

  const summary = (settings: readonly (RfAntennaSettings | null)[]): string => {
    const s = settings.find((x) => x?.equipment);
    const eq = s?.equipment;
    if (!eq) return t('rf.steps.sectors.notPicked', { count: settings.length });
    const id = eq.kind === 'aau' ? eq.aau : eq.antenna;
    const equipment = getEntry(catalogue, id)?.model ?? id;
    const c = s.carriers[0];
    return c
      ? t('rf.steps.sectors.picked', { equipment, band: c.band, bandwidth: c.bandwidthMhz })
      : t('rf.steps.sectors.noBand', { equipment });
  };

  const models: RowModel[] = sectors.map((sec, i) => {
    const bearing = sectorBearing(sec.antennaIds, units ?? []);
    const inSector = rows.filter((r) => r.sectorId === sec.id).map((r) => r.settings);
    return {
      key: sec.id,
      title:
        bearing === null
          ? sec.name
          : t('rf.sector.chip', { name: sec.name, bearing: fmt(bearing, 0) }),
      summary: summary(inSector),
      tag: groupTag(inSector),
      colour: hex(sectorColour(i)),
    };
  });
  // the units in no sector: only those that could take part (accepted panels, and draft ones
  // with drafts included) count towards setup; the rest are listed as not in this run
  const ungrouped = rows.filter((r) => r.sectorId === null);
  const eligible = ungrouped
    .filter(
      (r) =>
        r.kind === 'panel' && r.status !== 'rejected' && (r.status !== 'draft' || includeDrafts),
    )
    .map((r) => r.settings);
  if (ungrouped.length > 0)
    models.push({
      key: UNGROUPED,
      title: t('rf.sector.ungrouped', { count: ungrouped.length }),
      summary:
        eligible.length > 0
          ? summary(eligible)
          : t('rf.steps.sectors.outOfRun', { count: ungrouped.length }),
      tag: eligible.length > 0 ? groupTag(eligible) : 'out',
      colour: null,
    });

  const sectorModels = models.filter((m) => m.key !== UNGROUPED);
  const set = sectorModels.length > 0 && sectorModels.every((m) => m.tag !== 'needs-setup');
  return (
    <Step
      n={2}
      done={set}
      title={t('rf.steps.sectors.title')}
      meta={
        set
          ? t('rf.steps.sectors.count', { count: sectorModels.length })
          : t('rf.steps.sectors.notSet')
      }
      testId="rf-step-sectors"
    >
      <div className="rf-group" data-testid="rf-sectors">
        {sectors.length === 0 && <p className="rf-note">{t('rf.sectors.none')}</p>}
        {toolbar}
        <div className="rf-step-rows">
          {models.map((m) => (
            <Row
              key={m.key}
              row={m}
              open={expanded === m.key}
              onToggle={() => {
                onToggle(m.key);
              }}
              body={expanded === m.key ? renderBody(m.key) : null}
            />
          ))}
        </div>
        {children}
      </div>
    </Step>
  );
}
