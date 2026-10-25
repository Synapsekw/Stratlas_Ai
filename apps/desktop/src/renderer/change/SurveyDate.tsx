import { isAnnotateReadOnly } from '@aio/annotate';
import type { LayerPatch } from '@aio/schema';
import { formatDate, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useState } from 'react';
import { bridge } from '../shell';
import { announceDateMove } from '../shell/dateMoveNote';
import { priorCaptures } from '../shell/dateUndo';

/**
 * The survey date layers belong to (M8, `Layer.capture`): wins over the date in their names
 * (data-conventions section 13). Saved through `builder:updateLayers` with `{ capture }`; the
 * first option clears it ("work it out from the name").
 */
export async function setLayersCapture(
  layerIds: readonly string[],
  capture: string | null,
): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project || layerIds.length === 0) return 'No project is open.';
  const patch: LayerPatch = { capture };
  const r = await bridge.call('builder:updateLayers', {
    projectId: project.id,
    layerIds: [...layerIds],
    patch,
  });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error;
  workspace.getState().replaceManifest(r.value.manifest);
  return null;
}

/**
 * The survey date of `day` (`builder:ensureCapture`): made when the project has none on that day,
 * else the one it has (`created` says which). Takes the new manifest.
 */
export async function newSurveyDate(
  day: string,
): Promise<{ captureId: string; created: boolean } | { error: string }> {
  const project = workspace.getState().project;
  if (!project) return { error: 'No project is open.' };
  const r = await bridge.call('builder:ensureCapture', { projectId: project.id, date: day });
  if (!r.ok) return { error: r.error };
  if (!r.value.ok) return { error: r.value.error };
  workspace.getState().replaceManifest(r.value.manifest);
  return { captureId: r.value.captureId, created: r.value.created };
}

/**
 * Remove a survey date nothing is filed under any more (`builder:removeCapture`). Checks the open
 * manifest first: a date a layer still names, or one that is not there, is left alone. Returns an
 * error text or null.
 */
export async function removeEmptyCapture(captureId: string): Promise<string | null> {
  const project = workspace.getState().project;
  if (!project) return null;
  const { captures, layers } = project.manifest;
  if (!captures.some((c) => c.id === captureId)) return null;
  if (layers.some((l) => l.capture === captureId)) return null;
  const r = await bridge.call('builder:removeCapture', { projectId: project.id, captureId });
  if (!r.ok) return r.error;
  if (!r.value.ok) return r.value.error;
  workspace.getState().replaceManifest(r.value.manifest);
  return null;
}

/** Today in local time, as `YYYY-MM-DD`. */
function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The select's value for New survey date... (capture ids start with `capture-`). */
const NEW = 'new';

/** What the survey date options show: a date of the project ('' is Not dated), or a new day. */
export type SurveyDateChoice = { kind: 'capture'; id: string } | { kind: 'new'; day: string };

/**
 * The survey date options themselves, controlled: Not dated, each date oldest first, then New
 * survey date... (an inline day field). `onAdd` gives the day field an Add button and submits it;
 * without it the day is only reported through `onChange`. `onCloseNew` goes back to the list.
 */
export function SurveyDateOptions({
  captures,
  value,
  onChange,
  onAdd,
  onCloseNew,
  suggestedDay,
  testId,
  label,
  noneLabel,
  busy = false,
  disabled = false,
  tagged,
}: {
  captures: readonly { id: string; date: string; label: string }[];
  value: SurveyDateChoice;
  onChange: (next: SurveyDateChoice) => void;
  onAdd?: () => void;
  onCloseNew: () => void;
  /** Prefill of New survey date, else today. */
  suggestedDay?: string | undefined;
  testId: string;
  label: string;
  noneLabel: string;
  busy?: boolean;
  /** The select only (a read-only project). */
  disabled?: boolean;
  /** Dates shown with "(new)": the ones an import made. */
  tagged?: ReadonlySet<string> | null;
}) {
  const t = useT();
  const sorted = [...captures].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (value.kind === 'capture')
    return (
      <label className="small">
        <span className="faint" title={t('change.surveyDateTip')}>
          {label}
        </span>{' '}
        <select
          className="input"
          value={value.id}
          disabled={busy || disabled}
          onChange={(e) => {
            const next = e.target.value;
            onChange(
              next === NEW
                ? { kind: 'new', day: suggestedDay ?? today() }
                : { kind: 'capture', id: next },
            );
          }}
        >
          <option value="">{noneLabel}</option>
          {sorted.map((c) => (
            <option key={c.id} value={c.id}>
              {tagged?.has(c.id)
                ? t('change.surveyDateNewTag', { date: formatDate(c.date), label: c.label })
                : `${formatDate(c.date)} · ${c.label}`}
            </option>
          ))}
          <option value={NEW}>{t('change.surveyDateNew')}</option>
        </select>
      </label>
    );
  return (
    <form
      className="small"
      aria-label={t('change.surveyDateNew')}
      onSubmit={(e) => {
        e.preventDefault();
        onAdd?.();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCloseNew();
        }
      }}
    >
      <label>
        <span className="faint">{t('change.surveyDateNewDay')}</span>{' '}
        <input
          type="date"
          className="input"
          value={value.day}
          required
          autoFocus
          disabled={busy}
          data-testid={`${testId}-new`}
          onChange={(e) => {
            onChange({ kind: 'new', day: e.target.value });
          }}
        />
      </label>{' '}
      {onAdd && (
        <>
          <button
            type="submit"
            className="btn primary sm"
            disabled={busy || !value.day}
            data-testid={`${testId}-add`}
          >
            {t('change.surveyDateAdd')}
          </button>{' '}
        </>
      )}
      <button type="button" className="btn ghost sm" disabled={busy} onClick={onCloseNew}>
        {t('change.surveyDateCancel')}
      </button>
    </form>
  );
}

/**
 * The survey date of some layers, with any number of dates in the project: Not dated, each date
 * oldest first, then New survey date... (an inline day field, Add and Cancel).
 *
 * `createdHere` (the import card): the dates the import made. When the layers leave one of them,
 * or a date made here with New survey date, and it is left empty, it is removed. A date that was
 * there before is never removed. Without `createdHere` (the Selection card) nothing is tidied.
 */
export function SurveyDateSelect({
  layerIds,
  label,
  noneLabel,
  testId,
  suggestedDay,
  createdHere,
  source,
}: {
  layerIds: readonly string[];
  label: string;
  noneLabel: string;
  testId: string;
  /** Prefill of New survey date, else today. */
  suggestedDay?: string;
  /** Capture ids the import created: removed when left empty. */
  createdHere?: readonly string[];
  /** Where the import read the date from (the "Read from ..." line). */
  source?: 'photos' | 'video' | 'both' | null;
}) {
  const t = useT();
  const captures = useWorkspace((s) => s.project?.manifest.captures ?? []);
  const layers = useWorkspace((s) => s.project?.manifest.layers ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The day in the New survey date row while it is open, else null. */
  const [day, setDay] = useState<string | null>(null);
  /** Dates made here with New survey date (import card only): tidied like `createdHere`. */
  const [madeHere, setMadeHere] = useState<readonly string[]>([]);
  if (layerIds.length === 0) return null;
  const readOnly = isAnnotateReadOnly();
  const tidy = createdHere ? new Set([...createdHere, ...madeHere]) : null;
  const mine = layers.filter((l) => layerIds.includes(l.id));
  const values = new Set(mine.map((l) => l.capture ?? ''));
  const value = values.size === 1 ? ([...values][0] ?? '') : '';

  /** File the layers under `capture`, then remove the dates made here that are left empty. */
  const fileUnder = async (capture: string | null, made: readonly string[] = []) => {
    // the Selection card (nothing tidied) leaves the same "Moved ... / Undo" note as a drag
    const moved = tidy
      ? []
      : priorCaptures(
          { layers: mine.filter((l) => (l.capture ?? null) !== capture) },
          mine.filter((l) => (l.capture ?? null) !== capture).map((l) => l.id),
        );
    const err = await setLayersCapture(layerIds, capture);
    if (err) return err;
    announceDateMove(moved, capture);
    if (!tidy) return null;
    for (const id of new Set([...tidy, ...made])) {
      if (id === capture) continue;
      const failed = await removeEmptyCapture(id);
      if (failed) return failed;
    }
    return null;
  };
  const run = (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    void work().then((err) => {
      setBusy(false);
      setError(err);
    });
  };
  const add = () => {
    const chosen = day;
    if (!chosen) return;
    run(async () => {
      const r = await newSurveyDate(chosen);
      if ('error' in r) return r.error;
      const made = r.created && tidy ? [r.captureId] : [];
      if (made.length) setMadeHere((m) => [...m, ...made]);
      setDay(null);
      return fileUnder(r.captureId, made);
    });
  };
  const close = () => {
    setDay(null);
  };

  return (
    <div className="survey-date" data-testid={testId}>
      <SurveyDateOptions
        captures={captures}
        value={day === null ? { kind: 'capture', id: value } : { kind: 'new', day }}
        onChange={(next) => {
          if (next.kind === 'new') {
            setError(null);
            setDay(next.day);
            return;
          }
          run(() => fileUnder(next.id || null));
        }}
        onAdd={add}
        onCloseNew={close}
        suggestedDay={suggestedDay}
        testId={testId}
        label={label}
        noneLabel={noneLabel}
        busy={busy}
        disabled={readOnly}
        tagged={tidy}
      />
      {source && <p className="faint small">{t(`change.surveyDateFrom.${source}`)}</p>}
      {error && (
        <p className="notice danger small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** "Belongs to date..." for the selected layer (right panel, Selection). */
export function LayerDatePicker() {
  const t = useT();
  const selection = useWorkspace((s) => s.selection);
  const layer = useWorkspace((s) =>
    s.selection && (s.selection.kind === 'layer' || s.selection.kind === 'clip')
      ? s.project?.manifest.layers.find((l) => l.id === (s.selection?.layer ?? s.selection?.id))
      : undefined,
  );
  if (!selection || !layer || layer.kind === 'basemap' || layer.kind === 'legacy') return null;
  return (
    <SurveyDateSelect
      layerIds={[layer.id]}
      label={t('change.belongsTo')}
      noneLabel={t('change.belongsToNone')}
      testId="layer-survey-date"
    />
  );
}
