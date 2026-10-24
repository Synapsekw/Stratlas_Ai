/**
 * The Volumes tab's Materials pane (volumetrics redesign, spec section 6, board 5): "Materials and
 * density", a table of the site materials on the date in focus (colour, name, t/m³, swell, piles,
 * m³, tonnes, then "All materials"), and under it the selected material's editor: its density from
 * a survey date with the history and the tonnes impact, the piles of the material with Assign
 * piles, Cancel and Save. Import CSV and Export CSV moved here from the retired dialog.
 *
 * Edits stay in the `materialsDraft` store until Save. The pane is mounted by the Volumes bench.
 */
import { formatNumber, localeOf, type NumberLocale } from '@aio/geo';
import type { SiteMaterial, SurveyMeasurement } from '@aio/schema';
import { densityOn, effectiveUnits, materialColour } from '@aio/survey';
import { EmptyState, Icon, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import { useTimeline } from '../../workspace/timeline';
import { exportMaterialsCsv, importMaterialsCsv } from '../Materials';
import { useMeasure } from '../measureStore';
import { isPile } from '../pile/openPile';
import { massParts, volumeParts } from '../pile/PileHeader';
import {
  captureDateOf,
  datedCaptures,
  densityImpact,
  historyRows,
  materialOf,
  materialRows,
  materialsDraft,
  swatch,
  type DatedCapture,
  type MaterialsDraftState,
} from './materialsDraft';
import './materials.css';

const DENSITY_DECIMALS = 2;
const SWELL_DECIMALS = 2;

/** "10 Jan 2021" from an ISO date. */
function longDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "10 Jan" from an ISO date. */
function shortDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** A typed number, or null when it is not one (a comma reads as the decimal point). */
function parseNumber(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * A number input that commits each valid value as it is typed (within (0, max]) and shows the
 * stored value again when it is left.
 */
function NumField(props: {
  value: number | null;
  decimals: number;
  locale: NumberLocale;
  max: number;
  readOnly: boolean;
  label?: string;
  labelledBy?: string;
  testId?: string;
  emptyOk?: boolean;
  onCommit(v: number | null): void;
}): ReactElement {
  const shown = props.value === null ? '' : props.value.toFixed(props.decimals);
  const [text, setText] = useState(shown);
  const [editing, setEditing] = useState(false);
  // a new stored value shows unless the field is being typed in
  const [last, setLast] = useState(shown);
  if (shown !== last) {
    setLast(shown);
    if (!editing) setText(shown);
  }
  const v = parseNumber(text);
  const bad = text.trim() !== '' && (v === null || v <= 0 || v > props.max);
  return (
    <input
      className="sv-input mp-num"
      inputMode="decimal"
      value={text}
      readOnly={props.readOnly}
      aria-label={props.label}
      aria-labelledby={props.labelledBy}
      aria-invalid={bad || undefined}
      data-testid={props.testId}
      onFocus={() => {
        setEditing(true);
      }}
      onBlur={() => {
        setEditing(false);
        setText(shown);
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseNumber(e.target.value);
        if (n === null && e.target.value.trim() === '' && props.emptyOk) props.onCommit(null);
        else if (n !== null && n > 0 && n <= props.max) props.onCommit(n);
      }}
    />
  );
}

/** The date in focus when it has a date, else the latest dated survey. */
function useCaptureShown(dated: readonly DatedCapture[]): string | null {
  const focus = useTimeline((s) => s.focus);
  if (focus && dated.some((c) => c.id === focus)) return focus;
  return dated.at(-1)?.id ?? null;
}

const same = (a: SiteMaterial | undefined, b: SiteMaterial | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export interface MaterialsPaneProps {
  /** The draft store (the renderer's by default). */
  draft?: StoreApi<MaterialsDraftState>;
}

export function MaterialsPane({ draft = materialsDraft }: MaterialsPaneProps): ReactElement {
  const t = useT();
  const settings = useMeasure((s) => s.settings);
  const readOnly = useMeasure((s) => s.readOnly);
  const measurements = useMeasure((s) => s.file.measurements);
  const manifestCaptures = useWorkspace((s) => s.project?.manifest.captures);
  const state = useStore(draft);
  const captures: readonly DatedCapture[] = useMemo(
    () => manifestCaptures ?? [],
    [manifestCaptures],
  );
  const dated = useMemo(() => datedCaptures(captures), [captures]);
  const dateOf = useMemo(() => captureDateOf(captures), [captures]);
  const capture = useCaptureShown(dated);
  const piles = useMemo(() => measurements.filter(isPile), [measurements]);
  const units = effectiveUnits(settings.units);
  const locale = settings.locale ?? localeOf(units.distance);
  const materials = state.draft ?? settings.materials;
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const colId = useId();

  const table = useMemo(
    () =>
      capture === null ? null : materialRows(materials, piles, state.assignments, capture, dateOf),
    [materials, piles, state.assignments, capture, dateOf],
  );
  const vol = (m3: number) => volumeParts(m3, units, settings.precision.volume, locale).num;
  const mass = (tn: number | null) => (tn === null ? '-' : massParts(tn, units, locale).num);
  const dens = (d: number | null) => (d === null ? '' : formatNumber(d, DENSITY_DECIMALS, locale));

  const current = materials.find((m) => m.id === selected);
  const dirty = state.dirty();

  const save = async () => {
    setNote(null);
    const err = await draft.getState().save();
    setError(err);
  };
  const cancel = () => {
    draft.getState().cancel();
    setError(null);
    setNote(null);
  };
  const footer = !readOnly && (
    <div className="mp-foot">
      <button type="button" className="btn sm ghost" onClick={cancel} disabled={!dirty}>
        {t('materials.cancel')}
      </button>
      <button
        type="button"
        className="btn sm primary"
        data-testid="survey-mat-save"
        disabled={!dirty}
        onClick={() => {
          void save();
        }}
      >
        {t('materials.save')}
      </button>
    </div>
  );

  return (
    <section className="mp" data-testid="materials-pane" aria-labelledby={titleId}>
      <div className="mp-head">
        <h3 id={titleId} className="mp-title">
          {t('materials.title')}
        </h3>
        {!readOnly && (
          <button
            type="button"
            className="btn sm"
            data-testid="survey-mat-add"
            onClick={() => {
              const id = draft
                .getState()
                .add(`${t('materials.col.material')} ${String(materials.length + 1)}`);
              if (id) setSelected(id);
            }}
          >
            {t('materials.add')}
          </button>
        )}
      </div>

      {materials.length === 0 ? (
        <EmptyState title={t('empty.materials.title')} body={t('empty.materials.hint')} />
      ) : (
        <table className="mp-table" data-testid="materials-table">
          <thead>
            <tr>
              <th scope="col" id={`${colId}-m`}>
                {t('materials.col.material')}
              </th>
              <th scope="col" id={`${colId}-d`}>
                {t('materials.col.density')}
              </th>
              <th scope="col" id={`${colId}-s`}>
                {t('materials.col.swell')}
              </th>
              <th scope="col">{t('materials.col.piles')}</th>
              <th scope="col">{t('materials.col.volume')}</th>
              <th scope="col">{t('materials.col.tonnes')}</th>
            </tr>
          </thead>
          <tbody>
            {materials.map((m, i) => {
              const row = table?.rows[i];
              const rowId = `${colId}-r${String(i)}`;
              const on = m.id === selected;
              return (
                <tr
                  key={m.id}
                  data-testid="survey-mat-row"
                  data-id={m.id}
                  data-on={on ? '' : undefined}
                >
                  <th scope="row">
                    <button
                      type="button"
                      className="mp-pick"
                      id={rowId}
                      aria-expanded={on}
                      onClick={() => {
                        setSelected(on ? null : m.id);
                      }}
                    >
                      <span
                        className="mp-swatch"
                        aria-hidden="true"
                        style={{ background: swatch(row?.colour ?? 'var(--mat-none)') }}
                      />
                      <span className="mp-name">{m.name}</span>
                    </button>
                  </th>
                  <td>
                    <NumField
                      value={row?.density ?? m.densityTPerM3 ?? null}
                      decimals={DENSITY_DECIMALS}
                      locale={locale}
                      max={30}
                      readOnly={readOnly || capture === null}
                      labelledBy={`${rowId} ${colId}-d`}
                      testId="survey-mat-density"
                      onCommit={(v) => {
                        if (v !== null && capture) {
                          draft.getState().setDensityFrom(m.id, capture, v);
                          setSelected(m.id);
                        }
                      }}
                    />
                  </td>
                  <td>
                    <NumField
                      value={m.swell?.loose ?? null}
                      decimals={SWELL_DECIMALS}
                      locale={locale}
                      max={5}
                      readOnly={readOnly}
                      labelledBy={`${rowId} ${colId}-s`}
                      testId="survey-mat-swell"
                      emptyOk
                      onCommit={(v) => {
                        if (v === null) {
                          draft.getState().edit(m.id, (x) => {
                            const next = { ...x };
                            delete next.swell;
                            return next;
                          });
                        } else
                          draft.getState().edit(m.id, {
                            swell: { loose: v, compacted: m.swell?.compacted ?? 1 },
                          });
                      }}
                    />
                  </td>
                  <td>{row?.piles ?? 0}</td>
                  <td>{vol(row?.volumeM3 ?? 0)}</td>
                  <td>{mass(row?.tonnes ?? null)}</td>
                </tr>
              );
            })}
            {table && (
              <tr className="mp-total" data-testid="survey-mat-total">
                <th scope="row">{t('materials.allMaterials')}</th>
                <td />
                <td />
                <td>{table.total.piles}</td>
                <td>{vol(table.total.volumeM3)}</td>
                <td>{mass(table.total.tonnes)}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {current ? (
        <MaterialEditor
          key={current.id}
          material={current}
          index={materials.indexOf(current)}
          saved={settings.materials.find((m) => m.id === current.id)}
          draft={draft}
          state={state}
          piles={piles}
          captures={captures}
          dated={dated}
          capture={capture}
          readOnly={readOnly}
          locale={locale}
          mass={mass}
          dens={dens}
          footer={footer}
        />
      ) : (
        dirty && (
          <div className="mp-unsaved">
            <span className="mp-flag">{t('materials.unsaved')}</span>
            {footer}
          </div>
        )
      )}

      {!readOnly && (
        <div className="mp-csv">
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              file.current?.click();
            }}
          >
            <Icon name="import" size={12} /> {t('materials.importCsv')}
          </button>
          <input
            ref={file}
            type="file"
            accept=".csv,text/csv"
            hidden
            aria-label={t('materials.importCsv')}
            data-testid="survey-mat-import"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f)
                void importMaterialsCsv(f, draft).then((r) => {
                  setNote(r.note);
                  setError(r.error);
                });
            }}
          />
          <button
            type="button"
            className="btn sm ghost"
            data-testid="survey-mat-export"
            onClick={() => {
              void exportMaterialsCsv(materials).then((r) => {
                setNote(r.note);
                setError(r.error);
              });
            }}
          >
            <Icon name="download" size={12} /> {t('materials.exportCsv')}
          </button>
        </div>
      )}
      {note && (
        <p className="small" role="status" data-testid="survey-mat-note">
          {note}
        </p>
      )}
      {error && (
        <p className="notice danger small" role="alert" data-testid="survey-mat-error">
          <Icon name="warn" size={14} />
          {error}
        </p>
      )}
    </section>
  );
}

interface EditorProps {
  material: SiteMaterial;
  index: number;
  saved: SiteMaterial | undefined;
  draft: StoreApi<MaterialsDraftState>;
  state: MaterialsDraftState;
  piles: readonly SurveyMeasurement[];
  captures: readonly DatedCapture[];
  dated: readonly DatedCapture[];
  capture: string | null;
  readOnly: boolean;
  locale: NumberLocale;
  mass(tn: number | null): string;
  dens(d: number | null): string;
  footer: ReactElement | false;
}

/** The selected material: colour, name, density from a date, history, impact, piles, Save. */
function MaterialEditor(p: EditorProps): ReactElement {
  const t = useT();
  const { material: m, saved, draft, state, captures, dated, readOnly } = p;
  const [assigning, setAssigning] = useState(false);
  const fromId = useId();
  const edit = state.densityEdits[m.id] ?? null;
  const dateOf = useMemo(() => captureDateOf(captures), [captures]);
  const from = edit?.fromCapture ?? p.capture;
  const dateOfId = (id: string) => captures.find((c) => c.id === id)?.date ?? '';
  const oldDensity = saved && from ? densityOn(saved, from, dateOf) : null;
  const newDensity = edit?.tPerM3 ?? oldDensity;
  const mine = p.piles.filter((x) => materialOf(x, state.assignments) === m.id);
  const unsaved =
    !same(m, saved) ||
    p.piles.some(
      (x) => x.id in state.assignments && (x.material === m.id || state.assignments[x.id] === m.id),
    );
  const impact =
    edit && saved
      ? densityImpact(saved, m, edit.fromCapture, p.piles, state.assignments, captures)
      : null;
  const history = historyRows(m, edit, dateOf);
  const colour = swatch(materialColour(m, p.index));

  // "Density {old} → {new} t/m³ from": the new value is the input, the rest is the sentence
  const MARK = '\u0001';
  const [before = '', after = ''] = t('materials.densityFrom', {
    old: MARK + (oldDensity === null ? '-' : p.dens(oldDensity)) + MARK,
    new: '\u0002',
  }).split('\u0002');
  const sentence = (s: string) =>
    s.split(MARK).map((part, k) =>
      k === 1 ? (
        <s key={k} className="mp-old">
          {part}
        </s>
      ) : (
        <span key={k}>{part}</span>
      ),
    );

  return (
    <div className="mp-editor" data-testid="materials-editor" data-id={m.id}>
      <div className="mp-ed-head">
        <label className="mp-colour">
          <span className="mp-swatch" aria-hidden="true" style={{ background: colour }} />
          <input
            type="color"
            className="sr-only"
            aria-label={t('materials.colour.change')}
            value={m.colour ?? '#808080'}
            disabled={readOnly}
            onChange={(e) => {
              draft.getState().edit(m.id, { colour: e.target.value });
            }}
          />
        </label>
        <input
          className="mp-ed-name"
          value={m.name}
          readOnly={readOnly}
          aria-label={t('materials.col.material')}
          data-testid="survey-mat-name"
          onChange={(e) => {
            draft.getState().edit(m.id, { name: e.target.value });
          }}
        />
        {unsaved && (
          <span className="mp-flag" data-testid="materials-unsaved">
            {t('materials.unsaved')}
          </span>
        )}
      </div>
      {m.colour && !readOnly && (
        <button
          type="button"
          className="btn ghost sm mp-nocolour"
          onClick={() => {
            draft.getState().edit(m.id, (x) => {
              const next = { ...x };
              delete next.colour;
              return next;
            });
          }}
        >
          {t('materials.colour.none')}
        </button>
      )}

      {from !== null && (
        <div className="mp-density" role="group" aria-labelledby={fromId}>
          <span id={fromId} className="mp-sentence">
            {sentence(before)}
          </span>
          <NumField
            value={newDensity}
            decimals={DENSITY_DECIMALS}
            locale={p.locale}
            max={30}
            readOnly={readOnly}
            labelledBy={fromId}
            testId="materials-new-density"
            onCommit={(v) => {
              if (v !== null) draft.getState().setDensityFrom(m.id, from, v);
            }}
          />
          <span className="mp-sentence">{sentence(after)}</span>
          <select
            className="sv-input mp-from"
            value={from}
            disabled={readOnly}
            aria-labelledby={fromId}
            data-testid="materials-from"
            onChange={(e) => {
              const v = newDensity;
              if (v !== null) draft.getState().setDensityFrom(m.id, e.target.value, v);
            }}
          >
            {dated.map((c) => (
              <option key={c.id} value={c.id}>
                {longDate(c.date ?? '')}
              </option>
            ))}
          </select>
        </div>
      )}

      {history.length > 0 && (
        <div className="mp-history" data-testid="materials-history">
          <span className="mp-cap">{t('materials.history')}</span>
          <ul>
            {history.map((h) => {
              const iso = dateOfId(h.fromCapture);
              const vars = { date: longDate(iso), density: p.dens(h.tPerM3) };
              return (
                <li key={h.fromCapture} data-new={h.isNew ? '' : undefined}>
                  {h.isNew
                    ? t('materials.historyNew', vars)
                    : t('materials.historyKept', { ...vars, kept: shortDate(iso) })}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {impact && (
        <p className="mp-impact" data-testid="materials-impact">
          {t('materials.impact', {
            date: shortDate(dateOfId(impact.capture)),
            from: p.mass(impact.from),
            to: p.mass(impact.to),
            other: shortDate(dateOfId(impact.other)),
            otherTonnes: p.mass(impact.otherTonnes),
          })}
        </p>
      )}

      <div className="mp-piles">
        <span className="mp-cap">{t('materials.pilesOf')}</span>
        <div className="mp-chips">
          {mine.map((x) => (
            <span key={x.id} className="mp-chip" data-testid="materials-pile" data-id={x.id}>
              {x.label}
              {!readOnly && (
                <button
                  type="button"
                  aria-label={t('materials.unassign', { pile: x.label })}
                  onClick={() => {
                    draft.getState().unassign(x.id);
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </span>
          ))}
          {!readOnly && (
            <button
              type="button"
              className="btn sm mp-assign"
              aria-expanded={assigning}
              data-testid="materials-assign"
              onClick={() => {
                setAssigning(!assigning);
              }}
            >
              {t('materials.assign')}
            </button>
          )}
        </div>
        {assigning && !readOnly && (
          <fieldset className="mp-checklist" data-testid="materials-checklist">
            <legend className="sr-only">{t('materials.assign')}</legend>
            {p.piles.map((x) => {
              const on = materialOf(x, state.assignments) === m.id;
              return (
                <label key={x.id}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      if (on) draft.getState().unassign(x.id);
                      else draft.getState().assign(m.id, [x.id]);
                    }}
                  />
                  {x.label}
                </label>
              );
            })}
          </fieldset>
        )}
      </div>
      {p.footer}
    </div>
  );
}
