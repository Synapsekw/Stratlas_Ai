import { t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { IssueCard } from '../issueCard/IssueCard';
import { useCardFocusSeq } from '../issueCard/state';
import { exportAllowed } from '../player';
import { bridge, useShell } from '../shell';
import { defectsCsv, pciRating, type DefectRow, type DefectSort } from './model';
import { setFilter, setRoad, useRoad } from './store';
import { focusDefect, useFilteredDefects } from './useRoadMap';

const ROW_H = 44;
const OVERSCAN = 8;

const SORTS: { id: DefectSort; label: string }[] = [
  { id: 'severity', label: 'Worst first' },
  { id: 'chainage', label: 'Chainage' },
  { id: 'area', label: 'Largest area' },
  { id: 'code', label: 'Code' },
];

const nf = new Intl.NumberFormat('en-GB');

function useLevels() {
  const manifest = useWorkspace((s) => s.project?.manifest);
  return useMemo(
    () => [...(manifest?.severityModels[0]?.levels ?? [])].sort((a, b) => b.value - a.value),
    [manifest],
  );
}

function useClasses() {
  const manifest = useWorkspace((s) => s.project?.manifest);
  return useMemo(
    () =>
      (manifest?.classCatalogues ?? []).flatMap((c) =>
        c.classes.map((k) => ({ id: k.id, label: k.label, color: k.color })),
      ),
    [manifest],
  );
}

/** Toggle a value in a filter set; an empty or full set means no filter. */
function toggled<T>(set: ReadonlySet<T> | null, value: T, all: readonly T[]): Set<T> | null {
  const next = new Set(set ?? all);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next.size === 0 || next.size === all.length ? null : next;
}

/* ----------------------------------------------------------------------- summary */

function RoadSummary() {
  const road = useRoad((s) => s.road);
  const rows = useRoad((s) => s.rows);
  const sev = useRoad((s) => s.pciSeverity);
  const levels = useLevels();
  const classes = useClasses();
  const classFilter = useRoad((s) => s.filter.classes);
  if (!road) return null;
  const pci = road.pci.network[sev];
  const rating = pciRating(road.pci.ratings, pci);
  const pavement = road.pci.sections.reduce((a, s) => a + (s.pavementM2 ?? 0), 0);
  const mapped = rows.reduce((a, r) => a + (r.areaM2 ?? 0), 0);
  const byClass = classes
    .map((c) => ({ ...c, n: rows.filter((r) => r.classId === c.id).length }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n);
  const maxClass = Math.max(1, ...byClass.map((c) => c.n));
  const lo = road.pci.network.low;
  const hi = road.pci.network.high;

  return (
    <div className="rr-sum">
      <div className="rr-pci-card">
        <div className="rr-pci-v" style={{ color: rating?.color }}>
          {pci === null ? 'n/a' : Math.round(pci)}
        </div>
        <div className="rr-pci-t">
          <b>Network PCI · {rating?.label ?? 'not rated'}</b>
          <span>
            {road.pci.standard}, {sev} severity assumed
          </span>
          {lo !== null && hi !== null && (
            <span className="faint">
              Low to High severity assumption: {Math.round(lo)} to {Math.round(hi)}
            </span>
          )}
        </div>
      </div>
      <div className="seg rr-sev-seg" role="group" aria-label="PCI severity assumed">
        {(['low', 'medium', 'high'] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={sev === k}
            onClick={() => {
              setRoad({ pciSeverity: k });
            }}
          >
            {k[0]?.toUpperCase()}
            {k.slice(1)}
          </button>
        ))}
      </div>
      <div className="mini-stats rr-stats">
        {levels.map((l) => (
          <div key={l.value}>
            <div className="v sv">
              <i className="rr-dot" style={{ background: l.color }} />
              {nf.format(rows.filter((r) => r.severity === l.value).length)}
            </div>
            <div className="k">{l.label}</div>
          </div>
        ))}
      </div>
      <dl className="rr-kv">
        <dt>Length</dt>
        <dd className="mono">{road.centreline.lengthKm.toFixed(2)} km</dd>
        <dt>Defects</dt>
        <dd className="mono">{nf.format(rows.length)}</dd>
        <dt>Mapped area</dt>
        <dd className="mono">
          {nf.format(Math.round(mapped))} m²
          {pavement > 0 && ` · ${((mapped / pavement) * 100).toFixed(1)}% of pavement`}
        </dd>
        <dt>Sample units</dt>
        <dd className="mono">
          {road.pci.layout === 'chainage'
            ? t('road.unitsAlong', {
                count: nf.format(road.pci.units.length),
                length: road.pci.grid.cellM,
              })
            : `${nf.format(road.pci.units.length)} · ${String(road.pci.grid.cellM)} m grid`}
        </dd>
      </dl>
      <div className="rr-types" role="list" aria-label="Defect types">
        <div className="rr-h">Defect types</div>
        {byClass.map((c) => (
          <button
            key={c.id}
            type="button"
            role="listitem"
            className="rr-type"
            aria-pressed={classFilter?.has(c.id) ?? false}
            title={`Show only ${c.label}`}
            onClick={() => {
              setFilter({ classes: classFilter?.has(c.id) ? null : new Set([c.id]) });
            }}
          >
            <span className="rr-type-l">
              <i className="rr-dot" style={{ background: c.color }} />
              {c.label}
            </span>
            <span className="rr-type-bar">
              <i style={{ width: `${(c.n / maxClass) * 100}%`, background: c.color }} />
            </span>
            <span className="mono">{nf.format(c.n)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- defect list */

/** Save the listed defects as CSV through the native save dialog. */
function ExportCsv({ rows, filtered }: { rows: readonly DefectRow[]; filtered: boolean }) {
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg);
  const [note, setNote] = useState<string | null>(null);
  // a package that does not allow CSV exports shows no CSV button
  if (!project || !exportAllowed(pkg, 'issues-csv')) return null;
  return (
    <button
      type="button"
      className="btn sm ghost"
      title={note ?? `Save these ${nf.format(rows.length)} defects as CSV`}
      disabled={!rows.length}
      onClick={() => {
        const name = `${project.id}-defects${filtered ? '-filtered' : ''}.csv`;
        void bridge
          .call('dialog:saveFile', {
            defaultName: name,
            data: defectsCsv(rows, project.manifest.origin),
            title: 'Export defects',
          })
          .then((r) => {
            setNote(r.ok ? (r.value.error ?? null) : r.error);
          });
      }}
    >
      CSV
    </button>
  );
}

function DefectFilters({ rows }: { rows: readonly DefectRow[] }) {
  const shown = rows.length;
  const filter = useRoad((s) => s.filter);
  const sort = useRoad((s) => s.sort);
  const total = useRoad((s) => s.rows.length);
  const levels = useLevels();
  const classes = useClasses();
  const allSev = levels.map((l) => l.value);
  const allCls = classes.map((c) => c.id);
  const active =
    filter.severities !== null ||
    filter.classes !== null ||
    filter.kmRange !== null ||
    filter.search.trim() !== '';
  return (
    <div className="rr-filters">
      <input
        className="input rr-search"
        type="search"
        placeholder="Search code, type or km"
        aria-label="Search defects"
        value={filter.search}
        onChange={(e) => {
          setFilter({ search: e.target.value });
        }}
      />
      <div className="rr-chips" role="group" aria-label="Severity">
        {levels.map((l) => (
          <button
            key={l.value}
            type="button"
            className="rr-chip"
            aria-pressed={filter.severities?.has(l.value) ?? true}
            onClick={() => {
              setFilter({ severities: toggled(filter.severities, l.value, allSev) });
            }}
          >
            <i className="rr-dot" style={{ background: l.color }} />
            {l.label}
          </button>
        ))}
      </div>
      <div className="rr-chips" role="group" aria-label="Defect type">
        {classes.map((c) => (
          <button
            key={c.id}
            type="button"
            className="rr-chip"
            aria-pressed={filter.classes?.has(c.id) ?? true}
            onClick={() => {
              setFilter({ classes: toggled(filter.classes, c.id, allCls) });
            }}
          >
            <i className="rr-dot" style={{ background: c.color }} />
            {c.label}
          </button>
        ))}
      </div>
      <div className="rr-count">
        <span data-testid="defect-count">
          {nf.format(shown)} of {nf.format(total)} defects
          {filter.kmRange &&
            ` · km ${filter.kmRange[0].toFixed(2)} to ${filter.kmRange[1].toFixed(2)}`}
        </span>
        <span className="rr-sp" />
        {active && (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              setRoad({
                filter: { severities: null, classes: null, kmRange: null, search: '' },
              });
            }}
          >
            Reset
          </button>
        )}
        <ExportCsv rows={rows} filtered={active} />
        <select
          className="rr-sort"
          aria-label="Sort defects"
          value={sort}
          onChange={(e) => {
            setRoad({ sort: e.target.value as DefectSort });
          }}
        >
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function DefectRowView({ row, selected }: { row: DefectRow; selected: boolean }) {
  return (
    <div
      className={`rr-row${selected ? ' sel' : ''}`}
      role="option"
      aria-selected={selected}
      data-issue={row.id}
      onClick={() => {
        focusDefect(row);
      }}
    >
      <i className="rr-sevbar" style={{ background: row.severityColor }} />
      <div className="rr-row-m">
        <div className="rr-row-t">
          <b className="mono">{row.code}</b>
          <span>{row.classLabel}</span>
        </div>
        <div className="rr-row-s">
          <span style={{ color: row.severityColor }}>{row.severityLabel}</span>
          <span className="mono">km {row.km.toFixed(3)}</span>
          {row.areaM2 !== null && <span className="mono">{row.areaM2.toFixed(1)} m²</span>}
        </div>
      </div>
    </div>
  );
}

/** The filtered defects, virtualised: only the rows in view (plus a few) are in the DOM. */
export function DefectList() {
  const rows = useFilteredDefects();
  const selectedId = useWorkspace((s) => (s.selection?.kind === 'issue' ? s.selection.id : null));
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setHeight(el.clientHeight);
    });
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => {
      ro.disconnect();
    };
  }, []);

  // Keep the selected defect in view.
  const index = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1;
  useEffect(() => {
    const el = box.current;
    if (!el || index < 0) return;
    const top = index * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight)
      el.scrollTop = top + ROW_H - el.clientHeight;
  }, [index]);

  const first = Math.max(0, Math.floor(scroll / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW_H) + OVERSCAN);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    let i = index;
    if (e.key === 'ArrowDown') i = Math.min(rows.length - 1, i + 1);
    else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = rows.length - 1;
    else return;
    e.preventDefault();
    const row = rows[i];
    if (row) focusDefect(row);
  };

  return (
    <div className="rr-list-wrap">
      <DefectFilters rows={rows} />
      <div
        className="rr-list"
        data-issue-list
        ref={box}
        role="listbox"
        aria-label="Defects"
        tabIndex={0}
        onKeyDown={onKey}
        onScroll={(e) => {
          setScroll(e.currentTarget.scrollTop);
        }}
      >
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          <div style={{ position: 'absolute', top: first * ROW_H, left: 0, right: 0 }}>
            {rows.slice(first, last).map((r) => (
              <DefectRowView key={r.id} row={r} selected={r.id === selectedId} />
            ))}
          </div>
        </div>
        {!rows.length && <p className="rr-empty muted">No defects match the filters.</p>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------- panel */

type Tab = 'road' | 'defects' | 'selection';

/** The selected defect's card; previous and next walk the filtered, sorted defect list. */
function DefectCard({ issueId }: { issueId: string }) {
  const rows = useFilteredDefects();
  const order = useMemo(() => rows.map((r) => r.id), [rows]);
  return (
    <IssueCard
      issueId={issueId}
      place="road"
      order={order}
      onStep={(id) => {
        const row = rows.find((r) => r.id === id);
        if (row) focusDefect(row);
      }}
      className="ctx-fill"
    />
  );
}

/** The right panel of the road workspace: road summary, the defect list and the selection. */
export function RoadPanel() {
  const issueId = useWorkspace((s) => (s.selection?.kind === 'issue' ? s.selection.id : null));
  const count = useRoad((s) => s.rows.length);
  const [tab, setTab] = useState<Tab>('defects');
  // a defect picked on the map or in the list opens its card
  const focusSeq = useCardFocusSeq();
  const [seenSeq, setSeenSeq] = useState(focusSeq);
  if (seenSeq !== focusSeq) {
    setSeenSeq(focusSeq);
    setTab('selection');
  }
  const tabs: { id: Tab; label: string }[] = [
    { id: 'road', label: 'Road' },
    { id: 'defects', label: 'Defects' },
    { id: 'selection', label: 'Selection' },
  ];
  return (
    <div className="ctx-wrap tall rr-panel">
      <div className="seg ctx-tabs" role="tablist" aria-label="Road">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-pressed={tab === t.id}
            onClick={() => {
              setTab(t.id);
            }}
          >
            {t.label}
            {t.id === 'defects' && <span className="mono faint"> {nf.format(count)}</span>}
          </button>
        ))}
      </div>
      <div className="ctx-fill rr-fill">
        {tab === 'road' && <RoadSummary />}
        {tab === 'defects' && <DefectList />}
        {tab === 'selection' &&
          (issueId ? (
            <DefectCard issueId={issueId} />
          ) : (
            <p className="rr-empty muted">Select a defect on the map or in the list.</p>
          ))}
      </div>
    </div>
  );
}
