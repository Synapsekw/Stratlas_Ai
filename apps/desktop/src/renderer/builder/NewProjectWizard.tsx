import { crsOption, fromWgs84, searchCrs, toWgs84, utmEpsgFor } from '@aio/geo';
import { LocationPicker } from '@aio/maps';
import type { SeverityTemplate, Vec3 } from '@aio/schema';
import { Icon, t, type IconName } from '@aio/ui';
import { useEffect, useMemo, useState } from 'react';
import { bridge, jobs, shell } from '../shell';
import {
  defaultTemplateFor,
  PROJECT_TYPES,
  parseCoordinate,
  wizardProblems,
  type WizardForm,
} from './model';
import { builder, useBuilder } from './state';
import { buildParams, emptySurvey, noSurveys, surveyProblem, type SurveyInput } from './surveys';
import { VolumetricSurveys } from './VolumetricSurveys';

const TYPE_ICON: Record<WizardForm['type'], IconName> = {
  inspection: 'flare',
  volumetric: 'pile',
  road: 'road',
  twin: 'plant',
  fusion: 'layers',
};

const STEPS = ['Project', 'Place', 'Standards', 'Review'] as const;
type OriginMode = 'photo' | 'typed' | 'map';

/** Where the origin came from: degrees (re-projected when the CRS changes) or CRS metres. */
type OriginSource =
  | { kind: 'll'; lon: number; lat: number; h: number; from: string }
  | { kind: 'en'; e: number; n: number; h: number; from: string };

function originIn(src: OriginSource | null, epsg: number): Vec3 | null {
  if (!src) return null;
  if (src.kind === 'en') return [src.e, src.n, src.h];
  try {
    const p = fromWgs84([src.lon, src.lat, src.h], epsg);
    return [p[0], p[1], src.h];
  } catch {
    return null;
  }
}

function lonLatOf(origin: Vec3 | null, epsg: number): [number, number] | null {
  if (!origin) return null;
  try {
    const p = toWgs84(origin, epsg);
    return [p[0], p[1]];
  } catch {
    return null;
  }
}

const fmt = (v: number, d = 2) => v.toFixed(d);

export function NewProjectWizard() {
  const open = useBuilder((s) => s.wizardOpen);
  if (!open) return null;
  return <Wizard />;
}

function Wizard() {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Omit<WizardForm, 'origin'>>({
    name: '',
    customer: '',
    site: '',
    type: 'inspection',
    epsg: 32639,
    severityTemplate: null,
  });
  const [crsTouched, setCrsTouched] = useState(false);
  const [sevTouched, setSevTouched] = useState(false);
  const [crsQuery, setCrsQuery] = useState('');
  const [originMode, setOriginMode] = useState<OriginMode>('photo');
  const [source, setSource] = useState<OriginSource | null>(null);
  const [typed, setTyped] = useState('');
  const [height, setHeight] = useState('0');
  const [captureDate, setCaptureDate] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [templates, setTemplates] = useState<SeverityTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [surveys, setSurveys] = useState<SurveyInput[]>([emptySurvey()]);

  useEffect(() => {
    void bridge.call('builder:templates', {}).then((r) => {
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setTemplates(r.value.severity);
      setForm((f) => ({
        ...f,
        severityTemplate: f.severityTemplate ?? defaultTemplateFor(f.type, r.value.severity),
      }));
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') builder.getState().closeWizard();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const origin = originIn(source, form.epsg);
  const full: WizardForm = { ...form, origin };
  const problems = wizardProblems(full);
  const ll = lonLatOf(origin, form.epsg);
  const crsList = useMemo(() => searchCrs(crsQuery), [crsQuery]);
  const suggested = ll ? utmEpsgFor(ll[0], ll[1]) : null;

  /** A located origin also proposes its UTM zone, until the person picks a CRS. */
  const place = (s: OriginSource, msg: string) => {
    setSource(s);
    setNote(msg);
    if (s.kind === 'll' && !crsTouched) setForm((f) => ({ ...f, epsg: utmEpsgFor(s.lon, s.lat) }));
  };

  const fromPhoto = async () => {
    const pick = await bridge.call('dialog:openFiles', {
      title: 'Pick a geotagged photo',
      filters: [{ name: 'Photos', extensions: ['jpg', 'jpeg'] }],
      multi: false,
    });
    const path = pick.ok ? pick.value.paths[0] : undefined;
    if (!path) return;
    const r = await bridge.call('builder:photoGps', { path });
    if (!r.ok || !r.value.ok) {
      setNote(r.ok ? (r.value.ok ? null : r.value.error) : r.error);
      return;
    }
    const g = r.value;
    const name = path.split(/[\\/]/).pop() ?? path;
    place(
      {
        kind: 'll',
        lon: g.lon,
        lat: g.lat,
        h: Math.round((g.alt ?? 0) * 10) / 10,
        from: `photo ${name}`,
      },
      `From ${name}${g.alt !== undefined ? ', height from its GPS altitude' : ''}.`,
    );
    setHeight(String(Math.round((g.alt ?? 0) * 10) / 10));
    if (g.takenAt) setCaptureDate(g.takenAt.slice(0, 10));
  };

  const fromTyped = (text: string) => {
    setTyped(text);
    const p = parseCoordinate(text, form.epsg);
    if (!p) {
      setSource(null);
      return;
    }
    const nums = text
      .trim()
      .split(/[\s,;]+/)
      .map(Number);
    const degrees = Math.abs(nums[0] ?? 999) <= 90 && Math.abs(nums[1] ?? 999) <= 180;
    if (degrees)
      place(
        { kind: 'll', lon: nums[1] ?? 0, lat: nums[0] ?? 0, h: p[2], from: 'typed' },
        'Typed latitude and longitude.',
      );
    else
      place(
        { kind: 'en', e: p[0], n: p[1], h: p[2], from: 'typed' },
        `Typed in EPSG:${String(form.epsg)}.`,
      );
  };

  const fromMap = (lngLat: [number, number]) => {
    const h = Number(height) || 0;
    place(
      { kind: 'll', lon: lngLat[0], lat: lngLat[1], h, from: 'map' },
      'Clicked on the offline map.',
    );
  };

  const setH = (v: string) => {
    setHeight(v);
    const h = Number(v);
    if (!Number.isFinite(h) || !source) return;
    setSource({ ...source, h });
  };

  // a volumetric project can start from its survey data: the kit runs as a job once it exists
  const volumetric = form.type === 'volumetric';
  const surveyBlock = volumetric ? surveyProblem(surveys) : null;

  const create = async () => {
    if (Object.keys(problems).length || !origin || surveyBlock) return;
    setBusy(true);
    setError(null);
    const customer = form.customer.trim();
    const site = form.site.trim();
    const r = await bridge.call('builder:createProject', {
      name: form.name.trim(),
      ...(customer ? { customer } : {}),
      ...(site ? { site } : {}),
      type: form.type,
      epsg: form.epsg,
      origin,
      severityTemplate: form.severityTemplate,
      ...(captureDate ? { captureDate } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (!r.value.ok) {
      setError(r.value.error);
      return;
    }
    const build = volumetric && !noSurveys(surveys) ? buildParams(surveys) : null;
    const jobError = build
      ? await jobs
          .getState()
          .start({ pipeline: 'volumetric.build', project: r.value.path, params: build })
      : null;
    await builder.getState().created(r.value.path);
    if (build) {
      shell.getState().go('jobs');
      if (jobError)
        builder.setState({
          importResult: { items: [], error: t('builder.surveys.startFailed', { error: jobError }) },
        });
    }
  };

  const stepBlocked = (i: number): string | null =>
    i === 0 ? (problems.name ?? null) : i === 1 ? (problems.epsg ?? problems.origin ?? null) : null;
  const blocked = stepBlocked(step);
  const template = templates.find((t) => t.id === form.severityTemplate);
  const crs = crsOption(form.epsg);

  return (
    <div
      className="b-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="New project"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) builder.getState().closeWizard();
      }}
    >
      <div className="b-sheet" data-testid="new-project-wizard">
        <nav className="b-steps" aria-label="Steps">
          <h2>New project</h2>
          {STEPS.map((label, i) => (
            <button
              key={label}
              type="button"
              className={`b-step${i < step ? ' done' : ''}`}
              aria-current={i === step ? 'step' : undefined}
              onClick={() => {
                if (i <= step || !STEPS.slice(0, i).some((_, k) => stepBlocked(k))) setStep(i);
              }}
            >
              <i>{i < step ? <Icon name="check" size={12} /> : i + 1}</i>
              {label}
            </button>
          ))}
        </nav>

        <div className="b-body">
          {step === 0 && (
            <>
              <header>
                <h3>What is the project?</h3>
                <p>The name and client show in the library, reports and customer packages.</p>
              </header>
              <label className="b-field">
                <span>Name</span>
                <input
                  className="input"
                  autoFocus
                  value={form.name}
                  placeholder="EBSM flare stack"
                  aria-label="Project name"
                  onChange={(e) => {
                    setForm({ ...form, name: e.target.value });
                  }}
                />
              </label>
              <div className="b-row">
                <label className="b-field">
                  <span>Customer</span>
                  <input
                    className="input"
                    value={form.customer}
                    placeholder="EQUATE"
                    aria-label="Customer"
                    onChange={(e) => {
                      setForm({ ...form, customer: e.target.value });
                    }}
                  />
                </label>
                <label className="b-field">
                  <span>Site</span>
                  <input
                    className="input"
                    value={form.site}
                    placeholder="Shuaiba, Kuwait"
                    aria-label="Site"
                    onChange={(e) => {
                      setForm({ ...form, site: e.target.value });
                    }}
                  />
                </label>
              </div>
              <div className="b-field">
                <span>Type</span>
                <div className="b-cards" role="group" aria-label="Project type">
                  {PROJECT_TYPES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="b-card"
                      aria-pressed={form.type === t.id}
                      onClick={() => {
                        setForm({
                          ...form,
                          type: t.id,
                          // the grading follows the type until the person picks one
                          severityTemplate: sevTouched
                            ? form.severityTemplate
                            : defaultTemplateFor(t.id, templates),
                        });
                      }}
                    >
                      <Icon name={TYPE_ICON[t.id]} size={16} />
                      <b>{t.label}</b>
                      <small>{t.hint}</small>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <header>
                <h3>Where is it?</h3>
                <p>
                  Everything in the project lives in metres around one origin in a projected CRS.
                  Pick the UTM zone of the site and a point near its centre.
                </p>
              </header>
              <div className="b-field">
                <span>Coordinate reference system</span>
                <input
                  className="input"
                  type="search"
                  value={crsQuery}
                  placeholder="Search zone, country or EPSG code"
                  aria-label="Search CRS"
                  onChange={(e) => {
                    setCrsQuery(e.target.value);
                  }}
                />
                <div className="b-list" role="listbox" aria-label="CRS">
                  {crsList.map((c) => (
                    <button
                      key={c.epsg}
                      type="button"
                      role="option"
                      aria-selected={form.epsg === c.epsg}
                      aria-pressed={form.epsg === c.epsg}
                      onClick={() => {
                        setCrsTouched(true);
                        setForm({ ...form, epsg: c.epsg });
                      }}
                    >
                      <span>{c.name}</span>
                      <span className="mono">
                        EPSG:{c.epsg}
                        {suggested === c.epsg ? ' · site zone' : ''}
                      </span>
                      <small>{c.label}</small>
                    </button>
                  ))}
                  {!crsList.length && (
                    <p className="faint small" style={{ padding: 10 }}>
                      No bundled CRS matches. Type a full EPSG code such as 32639.
                    </p>
                  )}
                </div>
                {problems.epsg && <span className="bad">{problems.epsg}</span>}
              </div>
              <div className="b-field">
                <span>Origin</span>
                <div className="seg" role="group" aria-label="Origin from">
                  {(
                    [
                      ['photo', 'First GPS photo'],
                      ['typed', 'Typed coordinate'],
                      ['map', 'Click on the map'],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={originMode === id}
                      onClick={() => {
                        setOriginMode(id);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="b-origin">
                  {originMode === 'photo' && (
                    <div className="b-inline">
                      <button type="button" className="btn" onClick={() => void fromPhoto()}>
                        <Icon name="photo" size={14} />
                        Pick a photo
                      </button>
                      <span className="hint">
                        Uses its GPS position and altitude, and its date as the first capture.
                      </span>
                    </div>
                  )}
                  {originMode === 'typed' && (
                    <label className="b-field">
                      <input
                        className="input mono"
                        value={typed}
                        placeholder="29.0276, 48.1352, 31.7   or   221029.4 3214462 31.7"
                        aria-label="Origin coordinate"
                        onChange={(e) => {
                          fromTyped(e.target.value);
                        }}
                      />
                      <span className="hint">
                        Latitude, longitude and height in degrees and metres, or easting, northing
                        and height in the chosen CRS.
                      </span>
                    </label>
                  )}
                  {originMode === 'map' && (
                    <LocationPicker
                      className="b-map"
                      onPick={fromMap}
                      points={ll ? [ll] : []}
                      {...(ll ? { center: ll } : {})}
                    />
                  )}
                  <div className="b-readout" aria-live="polite" data-testid="origin-readout">
                    <b>Origin</b>
                    {origin && ll ? (
                      <>
                        <span>
                          E {fmt(origin[0])} N {fmt(origin[1])} H {fmt(origin[2], 1)}
                        </span>
                        <span>
                          {fmt(ll[1], 6)}, {fmt(ll[0], 6)}
                        </span>
                      </>
                    ) : (
                      <span className="faint">Not set</span>
                    )}
                  </div>
                  {source && originMode !== 'typed' && (
                    <label className="b-inline">
                      <span className="hint">Height H (m)</span>
                      <input
                        className="input mono"
                        style={{ maxWidth: 120 }}
                        value={height}
                        aria-label="Origin height"
                        onChange={(e) => {
                          setH(e.target.value);
                        }}
                      />
                    </label>
                  )}
                  {note && <span className="hint">{note}</span>}
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <header>
                <h3>How are findings graded?</h3>
                <p>
                  Start from a severity model already used in your projects. Classes come with it;
                  both can be edited later.
                </p>
              </header>
              <div className="b-field">
                <span>Severity model</span>
                <div
                  className="b-list"
                  style={{ maxHeight: 260 }}
                  role="listbox"
                  aria-label="Severity model"
                >
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="option"
                      aria-selected={form.severityTemplate === t.id}
                      aria-pressed={form.severityTemplate === t.id}
                      onClick={() => {
                        setSevTouched(true);
                        setForm({ ...form, severityTemplate: t.id });
                      }}
                    >
                      <span>{t.label}</span>
                      <span className="mono">
                        {t.catalogue ? `${String(t.catalogue.classes.length)} classes` : ''}
                      </span>
                      <small>From {t.source}</small>
                      <span className="b-sev">
                        {t.model.levels.map((l) => (
                          <span key={l.value}>
                            <i style={{ background: l.color }} />
                            {l.value} {l.label}
                          </span>
                        ))}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <p className="faint small">{t('builder.reportBranding')}</p>
            </>
          )}

          {step === 3 && (
            <>
              <header>
                <h3>Create the project</h3>
                <p>
                  A project folder with its manifest and an empty issue register is created in the
                  data folder. Then drop raw data on the window to import it.
                </p>
              </header>
              <dl className="b-summary">
                <dt>Name</dt>
                <dd>{form.name || '-'}</dd>
                <dt>Customer, site</dt>
                <dd>{[form.customer, form.site].filter(Boolean).join(' · ') || '-'}</dd>
                <dt>Type</dt>
                <dd>{PROJECT_TYPES.find((t) => t.id === form.type)?.label}</dd>
                <dt>CRS</dt>
                <dd className="mono">
                  EPSG:{form.epsg} {crs ? `· ${crs.name}` : ''}
                </dd>
                <dt>Origin</dt>
                <dd className="mono">
                  {origin ? `E ${fmt(origin[0])} N ${fmt(origin[1])} H ${fmt(origin[2], 1)}` : '-'}
                </dd>
                <dt>First capture</dt>
                <dd>{captureDate ?? 'From the imported data'}</dd>
                <dt>Severity model</dt>
                <dd>{template?.label ?? '-'}</dd>
                {volumetric && (
                  <>
                    <dt>{t('builder.surveys.title')}</dt>
                    <dd>
                      {noSurveys(surveys)
                        ? t('builder.surveys.none')
                        : t('builder.surveys.count', { count: surveys.length })}
                    </dd>
                  </>
                )}
              </dl>
              {volumetric && <VolumetricSurveys value={surveys} onChange={setSurveys} />}
            </>
          )}
        </div>

        <footer className="b-foot">
          {error ? <span className="err">{error}</span> : <span className="grow" />}
          {blocked && <span className="hint faint">{blocked}</span>}
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              builder.getState().closeWizard();
            }}
          >
            Cancel
          </button>
          {step > 0 && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setStep(step - 1);
              }}
            >
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              className="btn primary"
              disabled={Boolean(blocked)}
              onClick={() => {
                setStep(step + 1);
              }}
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={busy || Object.keys(problems).length > 0 || Boolean(surveyBlock)}
              onClick={() => void create()}
            >
              {busy ? <span className="spin" /> : <Icon name="plus" size={14} />}
              Create project
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
