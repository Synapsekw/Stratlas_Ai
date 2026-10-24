/**
 * The antenna inventory inside the Antennas group: the filter chips with their counts, a transient
 * note, the column header, then one flat row per unit in the filter's order (the review walk's)
 * with the selected unit's details open under its row. The rows scroll inside the group beyond
 * eight; the open details count beside the eight rows, never as rows (`--pl-details-h`).
 */
import type { AntennaKind, AntennasFile } from '@aio/schema';
import { Button, EmptyState, Tip, t } from '@aio/ui';
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
} from 'react';
import { AntennaDetails } from './AntennaDetails';
import { AntennaRow, northOf } from './AntennaRow';
import { filteredUnits } from './antennaStore';
import { isAntennaDrawn, type AntennaFilter } from './antennaVisibility';

export interface AntennaInventoryProps {
  file: AntennasFile | null;
  selected: string | null;
  /** The rows ticked for the bulk bar. */
  ticked: Record<string, true>;
  hidden: Record<string, true>;
  solo: AntennaKind | null;
  filter: AntennaFilter;
  readOnly: boolean;
  /** A transient status line shown under the tabs. */
  note?: string | null;
  onSelect: (id: string) => void;
  onTick: (id: string) => void;
  onFilter: (f: AntennaFilter) => void;
  onContextMenu?: (e: MouseEvent, id: string) => void;
}

const FILTERS: readonly AntennaFilter[] = ['draft', 'accepted', 'rejected', 'all'];

/** The selected filter tab (aria-selected carries the state; a tab takes no aria-pressed). */
const TAB_ON: CSSProperties = {
  background: 'var(--acc-a20)',
  borderColor: 'var(--acc-a40)',
  color: 'var(--acc-strong)',
};

/** The open details' height, measured, so the rows' scroller holds eight rows beside them. */
function useDetailsHeight(open: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      setHeight(0);
      return;
    }
    const measure = () => {
      setHeight(el.offsetHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [open]);
  return { ref, height };
}

function Tabs(props: AntennaInventoryProps & { file: AntennasFile }): ReactElement {
  const { file } = props;
  return (
    <div
      role="tablist"
      aria-label={t('telecom.antennas.title')}
      style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' }}
    >
      {FILTERS.map((f) => (
        <Button
          key={f}
          size="sm"
          role="tab"
          aria-selected={props.filter === f}
          tabIndex={props.filter === f ? 0 : -1}
          style={props.filter === f ? TAB_ON : undefined}
          data-testid={`antenna-filter-${f}`}
          onClick={() => {
            props.onFilter(f);
          }}
          onKeyDown={(e) => {
            const at = FILTERS.indexOf(f);
            const next =
              e.key === 'ArrowRight'
                ? (at + 1) % FILTERS.length
                : e.key === 'ArrowLeft'
                  ? (at + FILTERS.length - 1) % FILTERS.length
                  : e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? FILTERS.length - 1
                      : -1;
            if (next < 0) return;
            e.preventDefault();
            const target = FILTERS[next];
            if (!target) return;
            props.onFilter(target);
            e.currentTarget.parentElement
              ?.querySelector<HTMLElement>(`[data-testid="antenna-filter-${target}"]`)
              ?.focus();
          }}
        >
          {`${t(`telecom.antennas.filter.${f}`)} ${filteredUnits(file, f).length}`}
        </Button>
      ))}
    </div>
  );
}

export function AntennaInventory(props: AntennaInventoryProps): ReactElement {
  const { file } = props;
  const listed = filteredUnits(file, props.filter);
  const open = listed.some((u) => u.id === props.selected) ? props.selected : null;
  const details = useDetailsHeight(open);
  if (!file)
    return (
      <EmptyState
        title={t('telecom.antennas.empty.none.title')}
        body={t('telecom.antennas.empty.none.body')}
      />
    );
  if (file.units.length === 0)
    return (
      <EmptyState
        title={t('telecom.antennas.empty.nothing.title')}
        body={t('telecom.antennas.empty.nothing.body')}
      />
    );
  const north = northOf(file.units);
  const vis = { selected: props.selected, hidden: props.hidden, solo: props.solo };
  return (
    // minmax(0, 1fr): a long row ellipsizes in a narrow aside instead of widening the column
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 'var(--sp-3)' }}>
      <Tabs {...props} file={file} />
      {props.note ? (
        <p className="telecom-help telecom-note" role="status" data-testid="antenna-note">
          {props.note}
        </p>
      ) : null}
      {listed.length === 0 ? (
        <EmptyState title={t('telecom.antennas.filter.empty')} />
      ) : (
        <div>
          {/* the column names; each field also carries its own accessible name */}
          <div className="antenna-cols" data-testid="antenna-cols">
            <span />
            <span />
            <span>{t('project.antennas.col.id')}</span>
            <span>{t('project.antennas.col.kind')}</span>
            {north ? (
              // the north every azimuth of the list reads in, once for the column
              <Tip content={t(`telecom.antennas.summary.north.${north}`)} placement="top">
                <span tabIndex={0} data-testid="antenna-col-az">
                  {t('project.antennas.col.az')}
                </span>
              </Tip>
            ) : (
              <span>{t('project.antennas.col.az')}</span>
            )}
            <span>{t('project.antennas.col.tilt')}</span>
            <span>{t('project.antennas.col.height')}</span>
            <span>{t('project.antennas.col.status')}</span>
            <span />
          </div>
          {/* the review keys step the selection from a focused row (useAntennaKeys) */}
          <ul
            className="pl-rows antenna-rows"
            role="tree"
            data-antenna-tree=""
            aria-label={t('telecom.antennas.title')}
            style={{ '--pl-details-h': `${String(details.height)}px` } as CSSProperties}
          >
            {listed.map((u) => (
              <AntennaRow
                key={u.id}
                unit={u}
                north={north}
                selected={props.selected === u.id}
                ticked={props.ticked[u.id] === true}
                readOnly={props.readOnly}
                drawn={isAntennaDrawn(vis, u)}
                onSelect={props.onSelect}
                onTick={props.onTick}
                {...(props.onContextMenu ? { onContextMenu: props.onContextMenu } : {})}
              >
                {open === u.id ? (
                  <AntennaDetails
                    ref={details.ref}
                    unit={u}
                    readOnly={props.readOnly}
                    position={listed.findIndex((x) => x.id === u.id)}
                    count={listed.length}
                  />
                ) : null}
              </AntennaRow>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
