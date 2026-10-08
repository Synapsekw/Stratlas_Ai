/**
 * The saved measurements (M11 G3, PRD SRV-4): folders, search, sort, filters (template, created
 * by me, last 7 days, scope, dropdown values), fly to, and bulk select (move to a folder,
 * delete; G4 adds totals). Changes wait for **Save measurements** unless autosave is on.
 */
import type { EngineStage } from '@aio/engine';
import {
  dropdownFilters,
  effectiveUnits,
  filterMeasurements,
  formatRow,
  groupByFolder,
  measurementReadout,
  sortMeasurements,
  TOOL_LABELS,
  type MeasurementFilter,
  type MeasurementSort,
} from '@aio/survey';
import { Icon } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useMemo, useState } from 'react';
import { authorName } from '../author';
import { focusPoint, frameOf } from './measureScene';
import {
  deleteMeasurements,
  isDirty,
  revertMeasurements,
  saveMeasurements,
  select,
  setAutosave,
  setFolder,
  setListOpen,
  toggleSelected,
  useMeasure,
} from './measureStore';

const SORTS: { v: MeasurementSort; t: string }[] = [
  { v: 'newest', t: 'Newest first' },
  { v: 'oldest', t: 'Oldest first' },
  { v: 'name', t: 'Name' },
  { v: 'tool', t: 'Tool' },
];

export function MeasurementList({ stage }: { stage: EngineStage | null }) {
  const file = useMeasure((s) => s.file);
  const templates = useMeasure((s) => s.templates);
  const settings = useMeasure((s) => s.settings);
  const selected = useMeasure((s) => s.selected);
  const focus = useMeasure((s) => s.focus);
  const readOnly = useMeasure((s) => s.readOnly);
  const autosave = useMeasure((s) => s.autosave);
  const dirty = useMeasure(isDirty);
  const saving = useMeasure((s) => s.saving);
  const message = useMeasure((s) => s.message);
  const status = useMeasure((s) => s.status);
  const error = useMeasure((s) => s.error);
  const manifest = useWorkspace((s) => s.project?.manifest ?? null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<MeasurementSort>('newest');
  const [showFilters, setShowFilters] = useState(false);
  const [template, setTemplate] = useState('');
  const [mine, setMine] = useState(false);
  const [recent, setRecent] = useState(false);
  const [scope, setScope] = useState('');
  const [field, setField] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [folderName, setFolderName] = useState('');

  const allTemplates = useMemo(
    () => [...(templates.project?.templates ?? []), ...templates.user.templates],
    [templates],
  );
  const dropdowns = useMemo(() => dropdownFilters(allTemplates), [allTemplates]);
  const filter: MeasurementFilter = {
    search,
    template: template || null,
    createdBy: mine ? authorName() : null,
    lastSevenDays: recent,
    scope: scope ? (scope as NonNullable<MeasurementFilter['scope']>) : null,
    field: field
      ? { id: field.split('=')[0] ?? '', value: field.slice(field.indexOf('=') + 1) }
      : null,
  };
  const shown = sortMeasurements(filterMeasurements(file.measurements, filter, allTemplates), sort);
  const groups = groupByFolder(shown);
  const filtersOn = [template, mine, recent, scope, field].filter(Boolean).length;
  const allShownSelected = shown.length > 0 && shown.every((m) => selected.includes(m.id));

  const flyTo = (id: string) => {
    const m = file.measurements.find((x) => x.id === id);
    if (!m || !manifest) return;
    const f = focusPoint(m, frameOf(manifest));
    workspace.getState().flyTo({ kind: 'point', p: f.p, distance: f.distance });
    stage?.requestRender();
  };

  return (
    <section className="sv-card sv-list" aria-label="Measurements" data-testid="survey-list">
      <header className="sv-head">
        <h2>
          Measurements <span className="faint">{file.measurements.length}</span>
        </h2>
        <button
          type="button"
          className="btn ghost sm"
          aria-label="Close the measurements list"
          onClick={() => {
            setListOpen(false);
          }}
        >
          <Icon name="x" size={14} />
        </button>
      </header>
      {status === 'error' && (
        <p className="notice danger small" role="alert">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
      <div className="sv-row">
        <input
          type="search"
          className="sv-input sv-grow"
          placeholder="Search"
          aria-label="Search measurements"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
        <select
          className="sv-input"
          aria-label="Sort"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as MeasurementSort);
          }}
        >
          {SORTS.map((s) => (
            <option key={s.v} value={s.v}>
              {s.t}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn sm"
          aria-expanded={showFilters}
          aria-controls="sv-filters"
          onClick={() => {
            setShowFilters(!showFilters);
          }}
        >
          <Icon name="filter" size={12} /> Filters{filtersOn ? ` (${String(filtersOn)})` : ''}
        </button>
      </div>
      {showFilters && (
        <div className="sv-filters" id="sv-filters" role="group" aria-label="Filters">
          <label className="sv-field">
            <span>Template</span>
            <select
              className="sv-input"
              value={template}
              data-testid="survey-filter-template"
              onChange={(e) => {
                setTemplate(e.target.value);
              }}
            >
              <option value="">Any</option>
              <option value="none">No template</option>
              {allTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="sv-field">
            <span>Scope</span>
            <select
              className="sv-input"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value);
              }}
            >
              <option value="">Site and surveys</option>
              <option value="site">Whole site</option>
              <option value="survey">One survey</option>
              {(manifest?.captures ?? []).map((c) => (
                <option key={c.id} value={`survey:${c.id}`}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {dropdowns.length > 0 && (
            <label className="sv-field">
              <span>Field</span>
              <select
                className="sv-input"
                value={field}
                data-testid="survey-filter-field"
                onChange={(e) => {
                  setField(e.target.value);
                }}
              >
                <option value="">Any value</option>
                {dropdowns.flatMap((d) =>
                  d.options.map((o) => (
                    <option key={`${d.id}=${o}`} value={`${d.id}=${o}`}>
                      {d.name}: {o}
                    </option>
                  )),
                )}
              </select>
            </label>
          )}
          <label className="sv-check">
            <input
              type="checkbox"
              checked={mine}
              onChange={(e) => {
                setMine(e.target.checked);
              }}
            />
            Created by me
          </label>
          <label className="sv-check">
            <input
              type="checkbox"
              checked={recent}
              onChange={(e) => {
                setRecent(e.target.checked);
              }}
            />
            Last 7 days
          </label>
        </div>
      )}
      {!readOnly && selected.length > 0 && (
        <div className="sv-bulk" role="group" aria-label="Selected measurements">
          <span className="small">{selected.length} selected</span>
          <input
            className="sv-input sv-grow"
            placeholder="Folder"
            aria-label="Move the selected measurements to a folder"
            value={folderName}
            onChange={(e) => {
              setFolderName(e.target.value);
            }}
          />
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setFolder(selected, folderName.trim());
              setFolderName('');
            }}
          >
            Move
          </button>
          <button
            type="button"
            className="btn sm danger"
            onClick={() => {
              deleteMeasurements(selected);
            }}
          >
            Delete
          </button>
        </div>
      )}
      <div className="sv-scroll">
        {shown.length === 0 && (
          <p className="faint small sv-empty">
            {file.measurements.length === 0
              ? 'No measurements yet. Pick a tool on the toolbar and click on the site.'
              : 'No measurement matches.'}
          </p>
        )}
        {shown.length > 0 && (
          <label className="sv-check sv-all">
            <input
              type="checkbox"
              checked={allShownSelected}
              onChange={() => {
                select(allShownSelected ? [] : shown.map((m) => m.id), null);
              }}
            />
            Select all shown
          </label>
        )}
        {groups.map((g) => {
          const key = g.folder || '(none)';
          const isClosed = closed[key] === true;
          return (
            <div key={key} className="sv-folder">
              {(groups.length > 1 || g.folder) && (
                <button
                  type="button"
                  className="sv-folder-h"
                  aria-expanded={!isClosed}
                  onClick={() => {
                    setClosed({ ...closed, [key]: !isClosed });
                  }}
                >
                  <Icon name={isClosed ? 'chev-r' : 'chev-d'} size={12} />
                  {g.folder || 'Not in a folder'}
                  <span className="faint">{g.measurements.length}</span>
                </button>
              )}
              {!isClosed && (
                <ul className="sv-items">
                  {g.measurements.map((m) => {
                    const tpl = allTemplates.find((t) => t.id === m.template);
                    const row = measurementReadout(m, {}, tpl?.items).find((r) => r.value !== null);
                    const value = row
                      ? formatRow(row, effectiveUnits(settings.units, m.units), settings.precision)
                      : '';
                    return (
                      <li
                        key={m.id}
                        className={focus === m.id ? 'on' : undefined}
                        data-testid="survey-item"
                        data-id={m.id}
                      >
                        <input
                          type="checkbox"
                          aria-label={`Select ${m.label}`}
                          checked={selected.includes(m.id)}
                          onChange={() => {
                            toggleSelected(m.id);
                          }}
                        />
                        <button
                          type="button"
                          className="sv-item-main"
                          onClick={() => {
                            select([m.id], m.id);
                          }}
                        >
                          <span
                            className="sv-swatch"
                            style={{ background: m.style?.color ?? '#ffd166' }}
                          />
                          <span className="sv-item-label">{m.label}</span>
                          <span className="faint small">{tpl?.name ?? TOOL_LABELS[m.tool]}</span>
                          <span className="mono small sv-item-value">{value}</span>
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          aria-label={`Fly to ${m.label}`}
                          title="Fly to"
                          onClick={() => {
                            flyTo(m.id);
                          }}
                        >
                          <Icon name="target" size={12} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      {!readOnly && (
        <footer className="sv-foot">
          <label className="sv-check" title="Off by default: save when you are ready">
            <input
              type="checkbox"
              checked={autosave}
              onChange={(e) => {
                setAutosave(e.target.checked);
              }}
            />
            Autosave
          </label>
          <span className="small faint sv-grow" role="status">
            {message ?? (dirty ? 'Unsaved changes' : 'All saved')}
          </span>
          {dirty && (
            <button type="button" className="btn sm ghost" onClick={revertMeasurements}>
              Revert
            </button>
          )}
          <button
            type="button"
            className="btn sm primary"
            disabled={!dirty || saving}
            data-testid="survey-list-save"
            onClick={() => {
              void saveMeasurements();
            }}
          >
            Save
          </button>
        </footer>
      )}
    </section>
  );
}
