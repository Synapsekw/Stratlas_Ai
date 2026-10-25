// The volumetric report editor (spec section 6), in the Reports screen's viewer area: the fields
// on the left (title, Prepared for and by, Compare with, the "In short" summary, intro, method
// note, pile notes, closing remarks, pages A, B and C), the live preview of the same page
// components the PDF prints on the right, the pictures bar, and Export PDF and Export HTML at the
// foot. Edits save on their own through `useVolumetric`; a package is read only and still exports.
import type { VolumetricModel } from '@aio/project/export';
import {
  reportViewsDir,
  type ReportPageId,
  type SurveyMeasurement,
  type VolumetricTextId,
} from '@aio/schema';
import { Icon, Tip, t } from '@aio/ui';
import { assetUrl } from '@aio/workspace';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useStore } from 'zustand';
import { runExportAction } from '../../exports/exports';
import { reportViews, volumetricTemplate, type ResolvedText } from '../../reportPage/types';
import { dateText } from '../../reportPage/volumetric/chrome';
import { PAGE_IDS, PILE_NOTE_MAX } from './editorModel';
import {
  figuresKey,
  picturesFingerprint,
  picturesTaken,
  reportPiles,
  volumetricView,
} from './editorView';
import { takeReportPictures } from './liveStage';
import { showPictureProgress } from './PictureProgress';
import { useVolumetric } from './useVolumetric';
import './volumetricEditor.css';

type Key = Parameters<typeof t>[0];
const tk = (key: string, vars?: Record<string, string | number>) => t(key as Key, vars);

/** The A4 page width in CSS pixels (210 mm at 96 dpi). */
const PAGE_PX = (210 / 25.4) * 96;
/** A draft is handed to the saved edits after this pause, or when its field loses focus. */
const COMMIT_MS = 500;

interface FieldSpec {
  id: VolumetricTextId;
  label: string;
  hint?: string;
  multiline?: boolean;
  /** Has a generated text Reset can put back. */
  resettable: boolean;
}

const FIELDS_TOP: FieldSpec[] = [
  { id: 'title', label: 'vreport.field.title', resettable: true },
  {
    id: 'preparedFor',
    label: 'vreport.field.preparedFor',
    hint: 'vreport.field.preparedFor.hint',
    resettable: true,
  },
  {
    id: 'preparedBy',
    label: 'vreport.field.preparedBy',
    hint: 'vreport.field.preparedBy.hint',
    resettable: true,
  },
];
const FIELDS_TEXT: FieldSpec[] = [
  {
    id: 'summary',
    label: 'vreport.field.summary',
    hint: 'vreport.field.summary.hint',
    multiline: true,
    resettable: true,
  },
  {
    id: 'intro',
    label: 'vreport.field.intro',
    hint: 'vreport.field.intro.hint',
    multiline: true,
    resettable: false,
  },
  {
    id: 'method',
    label: 'vreport.field.method',
    hint: 'vreport.field.method.hint',
    multiline: true,
    resettable: true,
  },
];
const FIELD_CLOSING: FieldSpec = {
  id: 'closing',
  label: 'vreport.field.closing',
  hint: 'vreport.field.closing.hint',
  multiline: true,
  resettable: false,
};
/** Fields a click on their text in the preview focuses (the longer, distinctive texts). */
const FOCUSABLE: readonly VolumetricTextId[] = ['title', 'summary', 'intro', 'method', 'closing'];

export interface VolumetricEditorProps {
  projectId: string;
  /** The project's customer: the Prepared for default. */
  customer: string | null | undefined;
  /** Settings, Report branding, company name: the Prepared by default. */
  companyName: string | null | undefined;
  /** The project's survey measurements (the piles the pictures frame). */
  measurements: readonly SurveyMeasurement[];
  /** The package allows report exports (always for a folder project). */
  exportsAllowed: boolean;
  onClose: () => void;
}

/** The preview pane's width, for the page scale. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(entry?.contentRect.width ?? 0);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);
  return [ref, width];
}

function Field(props: {
  spec: FieldSpec;
  value: string;
  generated: boolean;
  readOnly: boolean;
  onChange: (v: string) => void;
  onCommit: () => void;
  onReset: () => void;
  bindInput: (el: HTMLInputElement | HTMLTextAreaElement | null) => void;
}) {
  const { spec, bindInput } = props;
  const label = tk(spec.label);
  const common = {
    id: `vre-${spec.id}`,
    className: spec.multiline ? 'nar-text vre-text' : 'input vre-input',
    value: props.value,
    readOnly: props.readOnly,
    'aria-label': label,
    ...(spec.hint ? { 'aria-describedby': `vre-${spec.id}-hint` } : {}),
    onBlur: props.onCommit,
  };
  return (
    <div className="vre-field" data-field={spec.id}>
      <div className="vre-field-h">
        <label htmlFor={common.id} className="caps">
          {label}
        </label>
        {spec.resettable ? (
          <span className={`vre-source${props.generated ? '' : ' edited'}`}>
            {props.generated ? t('vreport.source.generated') : t('vreport.source.edited')}
          </span>
        ) : (
          <span className="vre-source">{t('vreport.field.optional')}</span>
        )}
        <span className="grow" />
        {spec.resettable && !props.generated && !props.readOnly && (
          <button
            type="button"
            className="btn ghost sm"
            aria-label={`${t('vreport.reset')}: ${label}`}
            onClick={props.onReset}
          >
            <Icon name="history" size={12} />
            {t('vreport.reset')}
          </button>
        )}
      </div>
      {spec.multiline ? (
        <textarea
          {...common}
          ref={bindInput}
          rows={spec.id === 'method' ? 4 : 5}
          onChange={(e) => {
            props.onChange(e.target.value);
          }}
        />
      ) : (
        <input
          {...common}
          ref={bindInput}
          type="text"
          onChange={(e) => {
            props.onChange(e.target.value);
          }}
        />
      )}
      {spec.hint && (
        <p id={`vre-${spec.id}-hint`} className="faint small vre-hint">
          {tk(spec.hint)}
        </p>
      )}
    </div>
  );
}

/** The pictures bar: none saved yet, or stale, with Take pictures; and the last failure. */
function PicturesBar(props: {
  state: 'none' | 'stale' | 'current';
  error: string | null;
  busy: boolean;
  onTake: () => void;
}) {
  if (props.state === 'current' && !props.error) return null;
  return (
    <div
      className={`notice vre-pictures${props.error ? ' danger' : ''}`}
      role="status"
      data-testid="volumetric-pictures"
    >
      <Icon name="camera" size={14} />
      <span className="grow">
        {props.error
          ? t('vreport.pictures.failed', { error: props.error })
          : props.state === 'none'
            ? t('vreport.pictures.none')
            : t('vreport.pictures.stale')}
      </span>
      <button type="button" className="btn sm" disabled={props.busy} onClick={props.onTake}>
        {props.state === 'none' ? t('vreport.pictures.take') : t('vreport.pictures.retake')}
      </button>
    </div>
  );
}

function Preview(props: {
  model: VolumetricModel;
  text: ResolvedText;
  projectId: string;
  taken: number;
  onPick: (target: EventTarget) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { model, text, projectId, taken } = props;
  const pages = useMemo(() => {
    const dir = reportViewsDir('volumetric');
    const bust = taken > 0 ? `?v=${String(taken)}` : '';
    const views = reportViews(
      model.frame,
      (file) => `${assetUrl(projectId, { path: `${dir}/${file}` })}${bust}`,
    );
    return volumetricTemplate.render(model, text, views);
  }, [model, text, projectId, taken]);
  const zoom = width > 0 ? Math.min(1, (width - 32) / PAGE_PX) : 0.6;
  return (
    <div ref={ref} className="vre-preview" aria-label={t('vreport.preview')}>
      {/* a click on a text focuses its field; the fields are the keyboard route */}
      <Tip content={t('vreport.preview.focusField')} placement="top">
        <div
          className="vre-pages"
          style={{ zoom }}
          data-testid="volumetric-preview"
          onClick={(e) => {
            props.onPick(e.target);
          }}
        >
          {pages.map((p, i) => (
            <div key={`${p.page}-${String(i)}`} className="vre-page">
              {p.element}
            </div>
          ))}
        </div>
      </Tip>
    </div>
  );
}

export function VolumetricEditor(props: VolumetricEditorProps) {
  const { projectId, measurements } = props;
  const taken = useStore(volumetricView, (s) => s.taken[projectId] ?? 0);
  const pictureError = useStore(volumetricView, (s) => s.pictureError);
  const figures = useMemo(() => figuresKey(measurements), [measurements]);
  const ed = useVolumetric({
    projectId,
    dataKey: `${figures}#${String(taken)}`,
    customer: props.customer,
    companyName: props.companyName,
  });
  const [drafts, setDrafts] = useState<Partial<Record<VolumetricTextId, string>>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputs = useRef(new Map<VolumetricTextId, HTMLInputElement | HTMLTextAreaElement>());
  // the latest drafts, for the commit on a pause, on blur, before an export and on leaving
  const latest = useRef({ drafts, noteDrafts, ed });
  useEffect(() => {
    latest.current = { drafts, noteDrafts, ed };
  });

  const commit = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { drafts: d, noteDrafts: n, ed: e } = latest.current;
    for (const [id, text] of Object.entries(d) as [VolumetricTextId, string][])
      if (text !== e.texts[id].text) e.setText(id, text);
    for (const [id, text] of Object.entries(n))
      if (text !== (e.pileNotes[id] ?? '')) e.setPileNote(id, text);
    if (Object.keys(d).length > 0) setDrafts({});
    if (Object.keys(n).length > 0) setNoteDrafts({});
  };
  const commitLater = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(commit, COMMIT_MS);
  };
  // hand a pending draft over when the editor closes (the hook then saves it)
  useEffect(
    () => () => {
      commit();
    },
    [],
  );

  const model = ed.preview;
  const latestDate = model?.latest ?? null;
  const compared = model?.compared ?? null;
  const pair = latestDate && compared ? { from: compared.id, to: latestDate.id } : null;
  const dates = useMemo(() => model?.dates.map((d) => d.id) ?? [], [model]);
  const fingerprint = useMemo(
    () => picturesFingerprint(measurements, dates, pair),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [measurements, dates, pair?.from, pair?.to],
  );
  const pictures: 'none' | 'stale' | 'current' = !model?.frame
    ? 'none'
    : model.frame.fingerprint === fingerprint
      ? 'current'
      : 'stale';

  // the preview with the drafts on it, so it follows every key
  const shown = useMemo((): VolumetricModel | null => {
    if (!model) return null;
    const text = { ...model.text, ...drafts };
    const piles = model.piles.map((p) => {
      const draft = noteDrafts[p.id]?.trim();
      return draft === undefined ? p : { ...p, note: draft === '' ? null : draft };
    });
    return { ...model, text, piles };
  }, [model, drafts, noteDrafts]);
  const text = useMemo(
    (): ResolvedText => ({
      parts: shown?.text ?? {},
      pileNotes: Object.fromEntries(
        (shown?.piles ?? []).flatMap((p) => (p.note ? [[p.id, p.note]] : [])),
      ),
    }),
    [shown],
  );

  const takePictures = async () => {
    if (!model) return;
    setBusy(true);
    volumetricView.setState({ pictureError: null });
    const done = showPictureProgress();
    try {
      const r = await takeReportPictures({
        projectId,
        dates,
        pair,
        piles: reportPiles(measurements),
        fingerprint,
      });
      if (r.ok) picturesTaken(projectId);
      else volumetricView.setState({ pictureError: r.error });
    } finally {
      done();
      setBusy(false);
    }
  };

  const exportAs = async (format: 'volumetric-pdf' | 'volumetric-html') => {
    commit();
    await latest.current.ed.flush();
    runExportAction(format);
  };

  const pick = (target: EventTarget) => {
    if (ed.readOnly || !(target instanceof Element)) return;
    for (let el: Element | null = target; el && el !== document.body; el = el.parentElement) {
      const said = el.textContent.trim();
      if (said === '') continue;
      const id = FOCUSABLE.find((f) => (shown?.text[f] ?? '').trim() === said);
      if (id) {
        inputs.current.get(id)?.focus();
        return;
      }
      if (el.classList.contains('vr-page')) return;
    }
  };

  const valueOf = (id: VolumetricTextId) => drafts[id] ?? ed.texts[id].text;
  const field = (spec: FieldSpec) => (
    <Field
      key={spec.id}
      spec={spec}
      value={valueOf(spec.id)}
      generated={drafts[spec.id] === undefined && ed.texts[spec.id].generated}
      readOnly={ed.readOnly}
      onChange={(v) => {
        setDrafts((d) => ({ ...d, [spec.id]: v }));
        commitLater();
      }}
      onCommit={commit}
      onReset={() => {
        setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== spec.id)));
        ed.reset(spec.id);
      }}
      bindInput={(el) => {
        if (el) inputs.current.set(spec.id, el);
        else inputs.current.delete(spec.id);
      }}
    />
  );

  const oneDate = model !== null && model.compared === null;
  const pagesOn = PAGE_IDS.filter((p) => ed.pages[p]);
  const pageOff = (id: ReportPageId) => id === 'change' && oneDate;
  const saveNote: ReactNode =
    ed.saveState === 'saving'
      ? t('vreport.saving')
      : ed.saveState === 'saved'
        ? t('vreport.saved')
        : ed.saveState === 'error'
          ? t('vreport.notSaved', { error: ed.saveError ?? '' })
          : null;

  return (
    <section className="nar vre" aria-label={t('vreport.title')} data-testid="volumetric-editor">
      <header className="nar-h">
        <button type="button" className="btn ghost sm" onClick={props.onClose}>
          <Icon name="back" size={14} />
          {t('vreport.close')}
        </button>
        <h2>{t('vreport.title')}</h2>
        <span className="grow" />
        {saveNote && (
          <span
            className={`nar-state${ed.saveState === 'error' ? ' dirty' : ''}`}
            role={ed.saveState === 'error' ? 'alert' : 'status'}
          >
            {saveNote}
          </span>
        )}
      </header>
      <div className="vre-in">
        <div className="vre-side">
          <div className="vre-fields">
            {ed.readOnly && <p className="notice">{t('vreport.readOnly')}</p>}
            {ed.error && (
              <p className="notice danger" role="alert">
                {t('vreport.preview.failed', { error: ed.error })}
              </p>
            )}
            {model && (
              <PicturesBar
                state={pictures}
                error={pictureError}
                busy={busy}
                onTake={() => void takePictures()}
              />
            )}
            {oneDate && <p className="notice">{t('vreport.oneDate')}</p>}
            {!ed.ready && !ed.error && (
              <p className="muted small" aria-busy="true">
                {t('vreport.preview.loading')}
              </p>
            )}
            {ed.ready && model && (
              <>
                {FIELDS_TOP.map(field)}
                {!oneDate && (
                  <div className="vre-field">
                    <div className="vre-field-h">
                      <label htmlFor="vre-compare" className="caps">
                        {t('vreport.field.compareWith')}
                      </label>
                    </div>
                    <select
                      id="vre-compare"
                      className="input"
                      aria-label={t('vreport.field.compareWith')}
                      aria-describedby="vre-compare-hint"
                      disabled={ed.readOnly}
                      value={compared?.id ?? ''}
                      onChange={(e) => {
                        ed.setCompareWith(e.target.value || null);
                      }}
                    >
                      {[...model.dates]
                        .filter((d) => d.id !== latestDate?.id)
                        .reverse()
                        .map((d) => (
                          <option key={d.id} value={d.id}>
                            {dateText(d.date)}
                          </option>
                        ))}
                    </select>
                    <p id="vre-compare-hint" className="faint small vre-hint">
                      {t('vreport.field.compareWith.hint')}
                    </p>
                  </div>
                )}
                {FIELDS_TEXT.map(field)}
                {model.piles.length > 0 && (
                  <fieldset className="vre-notes">
                    <legend className="caps">{t('vreport.field.pileNotes')}</legend>
                    <p className="faint small vre-hint">
                      {t('vreport.field.pileNote.hint', { max: PILE_NOTE_MAX })}
                    </p>
                    {model.piles.map((p) => {
                      const label = t('vreport.field.pileNote', { pile: p.label });
                      return (
                        <label key={p.id} className="vre-note">
                          <span className="vre-note-n mono">{p.tag}</span>
                          <span className="vre-note-l">{p.label}</span>
                          <input
                            type="text"
                            className="input"
                            aria-label={label}
                            maxLength={PILE_NOTE_MAX}
                            readOnly={ed.readOnly}
                            value={noteDrafts[p.id] ?? ed.pileNotes[p.id] ?? ''}
                            onChange={(e) => {
                              setNoteDrafts((n) => ({ ...n, [p.id]: e.target.value }));
                              commitLater();
                            }}
                            onBlur={commit}
                          />
                        </label>
                      );
                    })}
                  </fieldset>
                )}
                {field(FIELD_CLOSING)}
                <fieldset className="vre-pages-on">
                  <legend className="caps">{t('vreport.field.pages')}</legend>
                  <div className="vre-pages-list">
                    {PAGE_IDS.map((id) => {
                      const on = ed.pages[id] && !pageOff(id);
                      const last = on && pagesOn.filter((p) => !pageOff(p)).length <= 1;
                      const row = (
                        <label className="rep-check">
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={ed.readOnly || last || pageOff(id)}
                            onChange={(e) => {
                              ed.setPage(id, e.target.checked);
                            }}
                          />
                          {tk(`vreport.pages.${id}`)}
                        </label>
                      );
                      return last ? (
                        <Tip key={id} content={t('vreport.pages.keepOne')} placement="top">
                          {row}
                        </Tip>
                      ) : (
                        <Fragment key={id}>{row}</Fragment>
                      );
                    })}
                  </div>
                </fieldset>
              </>
            )}
          </div>
          <footer className="vre-foot">
            {props.exportsAllowed ? (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={!ed.ready}
                  onClick={() => void exportAs('volumetric-html')}
                >
                  <Icon name="download" size={14} />
                  {t('vreport.export.html')}
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!ed.ready}
                  onClick={() => void exportAs('volumetric-pdf')}
                >
                  <Icon name="download" size={14} />
                  {t('vreport.export.pdf')}
                </button>
              </>
            ) : (
              <p className="faint small">This package does not allow PDF exports.</p>
            )}
          </footer>
        </div>
        {shown ? (
          <Preview model={shown} text={text} projectId={projectId} taken={taken} onPick={pick} />
        ) : (
          <div className="vre-preview vre-preview-empty">
            <p className="muted small">
              {ed.error
                ? t('vreport.preview.failed', { error: ed.error })
                : t('vreport.preview.loading')}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
