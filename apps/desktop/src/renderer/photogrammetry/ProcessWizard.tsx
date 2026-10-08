/**
 * **Process photos** (G4): pick the photos (a photos layer, or folders read in place), see the
 * camera groups, choose the CRS and how GNSS heights weigh, a preset and the products, then an
 * estimate for this computer before anything starts. Start runs `photo.align`; the products the
 * person chose start by themselves when the alignment finishes, unless ground control comes first.
 */
import { crsOption, searchCrs } from '@aio/geo';
import type {
  HardwareProbe,
  PhotoEstimate,
  PhotoPreset,
  PhotoProduct,
  PhotoSource,
} from '@aio/schema';
import { Icon, useFocusTrap } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { bridge, useShell } from '../shell';
import { startAlign } from './actions';
import {
  cameraGroups,
  defaultProducts,
  diskShort,
  formatBytes,
  formatMinutes,
  newRunId,
  PRESETS,
  PRODUCTS,
  splitNotes,
  suggestedEpsg,
} from './estimate';
import { gpuLine, machineLine, processingLine } from './hardware';
import { photoUi } from './store';

const STEPS = ['Photos', 'Cameras', 'Place and heights', 'Quality', 'Estimate'] as const;

type Gnss = 'auto' | 'rtk' | 'standard' | 'ignore';
const GNSS: readonly { id: Gnss; label: string; hint: string }[] = [
  {
    id: 'auto',
    label: 'Read each photo',
    hint: 'RTK fixed photos count to the centimetre, the others to a few metres.',
  },
  { id: 'rtk', label: 'RTK on every photo', hint: 'Every position is trusted to centimetres.' },
  {
    id: 'standard',
    label: 'Standard GNSS',
    hint: 'Positions trusted to a few metres; ground control sets the accuracy.',
  },
  {
    id: 'ignore',
    label: 'Ignore GNSS',
    hint: 'Shape from matching only; ground control places the model.',
  },
];

const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? p;

export function ProcessWizard() {
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg);
  const dlg = useRef<HTMLDivElement>(null);
  const close = () => {
    photoUi.getState().close();
  };
  useFocusTrap(dlg, true, { onEscape: close });

  const layers = useMemo(
    () => (project?.manifest.layers ?? []).filter((l) => l.kind === 'photos'),
    [project],
  );
  const [step, setStep] = useState(0);
  const [kind, setKind] = useState<'layer' | 'folders'>(layers.length ? 'layer' : 'folders');
  const [layerId, setLayerId] = useState(layers[0]?.id ?? '');
  const [folders, setFolders] = useState<string[]>([]);
  const projectEpsg = project && 'epsg' in project.manifest.crs ? project.manifest.crs.epsg : null;
  const [epsg, setEpsg] = useState<number | null>(projectEpsg);
  const [crsQuery, setCrsQuery] = useState('');
  const [gnss, setGnss] = useState<Gnss>('auto');
  const [preset, setPreset] = useState<PhotoPreset>('standard');
  const [products, setProducts] = useState<PhotoProduct[]>(defaultProducts('standard'));
  const [capture, setCapture] = useState('');
  const [gcpFirst, setGcpFirst] = useState(false);
  const [probe, setProbe] = useState<HardwareProbe | null>(null);
  const [result, setResult] = useState<{ key: string; estimate: PhotoEstimate } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const photos: PhotoSource | null =
    kind === 'layer' ? (layerId ? { layer: layerId } : null) : folders.length ? { folders } : null;
  const key = JSON.stringify([photos, preset, products]);

  useEffect(() => {
    void bridge.call('photo:probe', {}).then((r) => {
      if (r.ok && r.value.ok) setProbe(r.value.probe);
    });
  }, []);

  // the estimate follows the photos, the preset and the products (read from step 2 on)
  useEffect(() => {
    if (!photos || step < 1 || !project) return;
    let live = true;
    void bridge
      .call('photo:estimate', { projectId: project.id, photos, preset, products })
      .then((r) => {
        if (!live) return;
        if (!r.ok) setError(r.error);
        else if (!r.value.ok) setError(r.value.error);
        else {
          setError(null);
          setResult({ key, estimate: r.value.estimate });
        }
      });
    return () => {
      live = false;
    };
    // `key` stands for photos, preset and products
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, step >= 1, project?.id]);

  const estimate = result?.estimate ?? null;
  const estimating = photos !== null && step >= 1 && result?.key !== key && !error;
  if (!project) return null;
  const notes = estimate ? splitNotes(estimate) : null;
  const verdict = probe ? processingLine(probe) : null;
  const crsList = searchCrs(crsQuery);
  const suggested = estimate ? suggestedEpsg(estimate) : null;
  const groups = estimate ? cameraGroups(estimate) : null;
  const crsChoices = [
    ...(projectEpsg !== null ? [projectEpsg] : []),
    ...(suggested !== null && suggested !== projectEpsg ? [suggested] : []),
    ...crsList.map((c) => c.epsg).filter((e) => e !== projectEpsg && e !== suggested),
  ];

  const stepBlocked = (i: number): string | null => {
    if (pkg) return 'This project is a read-only package. Extract it to process photos.';
    if (i === 0 && !photos)
      return kind === 'layer' ? 'Choose a photos layer.' : 'Choose a folder of photos.';
    if (i === 2 && projectEpsg !== null && epsg === null) return 'Choose a CRS.';
    if (i === 3 && !products.length) return 'Choose at least one product.';
    return null;
  };
  const blocked = stepBlocked(step);
  const noPhotos = estimate !== null && !estimating && estimate.minutes[1] === 0;
  const startBlocked =
    STEPS.map((_, i) => stepBlocked(i)).find(Boolean) ??
    (verdict && !verdict.ok ? verdict.text : null) ??
    (noPhotos ? 'No photos were found.' : null) ??
    (estimate && diskShort(estimate) ? 'Not enough free disk for this run.' : null);

  const chooseFolder = async () => {
    const r = await bridge.call('dialog:openFolder', { title: 'Folder of photos' });
    if (r.ok && r.value.path) {
      const p = r.value.path;
      setFolders((f) => (f.includes(p) ? f : [...f, p]));
    }
  };

  const go = async () => {
    if (!photos || startBlocked) return;
    setBusy(true);
    setError(null);
    const runs = await bridge.call('photo:runs', { projectId: project.id });
    const taken = runs.ok && runs.value.ok ? runs.value.runs.map((r) => r.id) : [];
    const run = newRunId(new Date(), taken);
    const err = await startAlign({
      root: project.root,
      run,
      photos,
      preset,
      gnss,
      ...(epsg !== null && epsg !== projectEpsg ? { crs: { epsg } } : {}),
    });
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    const ui = photoUi.getState();
    if (!gcpFirst)
      ui.setPending(run, {
        root: project.root,
        preset,
        products,
        ...(capture ? { capture } : {}),
      });
    ui.openRun(run, 'progress');
  };

  return (
    <div
      ref={dlg}
      className="b-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Process photos"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="b-sheet ph-sheet" data-testid="photo-wizard">
        <nav className="b-steps" aria-label="Steps">
          <h2>Process photos</h2>
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
              <header role="none">
                <h3>Which photos?</h3>
                <p>
                  Photos are read where they are and never changed. Processing adds new layers next
                  to what the project has.
                </p>
              </header>
              <div className="b-cards" role="group" aria-label="Photo source">
                <button
                  type="button"
                  className="b-card"
                  aria-pressed={kind === 'layer'}
                  disabled={!layers.length}
                  onClick={() => {
                    setKind('layer');
                  }}
                >
                  <Icon name="photo" size={16} />
                  <b>A photos layer</b>
                  <small>
                    {layers.length
                      ? 'Photos already imported into this project.'
                      : 'This project has no photos layer yet.'}
                  </small>
                </button>
                <button
                  type="button"
                  className="b-card"
                  aria-pressed={kind === 'folders'}
                  onClick={() => {
                    setKind('folders');
                  }}
                >
                  <Icon name="import" size={16} />
                  <b>Folders of photos</b>
                  <small>A flight&apos;s folders, read in place (JPEG or TIFF).</small>
                </button>
              </div>
              {kind === 'layer' ? (
                <label className="b-field">
                  <span>Photos layer</span>
                  <select
                    className="input"
                    value={layerId}
                    onChange={(e) => {
                      setLayerId(e.target.value);
                    }}
                  >
                    {layers.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.items.length} photos)
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="b-field">
                  <span>Folders</span>
                  {folders.length > 0 && (
                    <ul className="ph-folders" aria-label="Chosen folders">
                      {folders.map((f) => (
                        <li key={f}>
                          <span className="mono">{f}</span>
                          <button
                            type="button"
                            className="btn ghost sm"
                            aria-label={`Remove ${baseName(f)}`}
                            onClick={() => {
                              setFolders((x) => x.filter((y) => y !== f));
                            }}
                          >
                            <Icon name="x" size={12} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div>
                    <button type="button" className="btn sm" onClick={() => void chooseFolder()}>
                      <Icon name="plus" size={14} />
                      Add a folder
                    </button>
                  </div>
                  <p className="hint">Subfolders are read too, up to four levels deep.</p>
                </div>
              )}
            </>
          )}

          {step === 1 && (
            <>
              <header role="none">
                <h3>Cameras</h3>
                <p>
                  Each camera body and lens is calibrated on its own during alignment, from the
                  photos themselves.
                </p>
              </header>
              {estimating && !estimate && <p className="faint small">Reading the photos</p>}
              {groups && (
                <ul className="ph-groups" aria-label="Camera groups" data-testid="photo-groups">
                  {groups.length === 0 && <li className="faint">No photos found yet.</li>}
                  {groups.map((g) => (
                    <li key={g}>
                      <Icon name="camera" size={14} />
                      {g}
                    </li>
                  ))}
                </ul>
              )}
              {notes?.other
                .filter((n) => /GPS|Mixed cameras/.test(n))
                .map((n) => (
                  <p key={n} className="notice warn small">
                    <Icon name="warn" size={14} />
                    {n}
                  </p>
                ))}
            </>
          )}

          {step === 2 && (
            <>
              <header role="none">
                <h3>Place and heights</h3>
                <p>
                  Results are written in the project&apos;s coordinate system unless you choose
                  another. Heights follow the project&apos;s vertical datum.
                </p>
              </header>
              <div className="b-field">
                <span>Coordinate reference system</span>
                {projectEpsg === null ? (
                  <p className="small">The project&apos;s own CRS (WKT) is used.</p>
                ) : (
                  <>
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
                      {crsChoices.map((code) => {
                        const c = crsOption(code);
                        return (
                          <button
                            key={code}
                            type="button"
                            role="option"
                            aria-selected={epsg === code}
                            onClick={() => {
                              setEpsg(code);
                            }}
                          >
                            <span>{c?.name ?? `EPSG:${String(code)}`}</span>
                            <span className="mono">
                              EPSG:{code}
                              {code === projectEpsg ? ' · project' : ''}
                              {code === suggested ? ' · photos' : ''}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
                {notes?.zone && <p className="hint">{notes.zone.text}</p>}
              </div>
              <div className="b-field">
                <span>Camera positions (GNSS)</span>
                <div className="ph-radios" role="radiogroup" aria-label="Camera positions">
                  {GNSS.map((g) => (
                    <label key={g.id} className="ph-radio">
                      <input
                        type="radio"
                        name="ph-gnss"
                        checked={gnss === g.id}
                        onChange={() => {
                          setGnss(g.id);
                        }}
                      />
                      <span>
                        <b>{g.label}</b>
                        <small>{g.hint}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <p className="small faint" data-testid="photo-heights">
                {project.manifest.verticalDatum
                  ? `Heights: absolute altitude ${project.manifest.verticalDatum.absAltOffsetM >= 0 ? '+' : ''}${project.manifest.verticalDatum.absAltOffsetM.toFixed(2)} m (the project's vertical datum${project.manifest.verticalDatum.note ? `: ${project.manifest.verticalDatum.note}` : ''}). Every run states the heights it used.`
                  : 'Heights: the photos’ altitudes as recorded; ground control corrects them. Every run states the heights it used.'}
              </p>
            </>
          )}

          {step === 3 && (
            <>
              <header role="none">
                <h3>Quality and products</h3>
                <p>Quicker presets use smaller images. You can create more products later.</p>
              </header>
              <div className="b-cards ph-presets" role="group" aria-label="Preset">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="b-card"
                    aria-pressed={preset === p.id}
                    onClick={() => {
                      setPreset(p.id);
                      setProducts(defaultProducts(p.id));
                    }}
                  >
                    <Icon
                      name={p.id === 'fast' ? 'play' : p.id === 'standard' ? 'layers' : 'target'}
                      size={16}
                    />
                    <b>{p.label}</b>
                    <small>
                      {p.hint} {p.detail}
                    </small>
                  </button>
                ))}
              </div>
              <fieldset className="ph-products">
                <legend>Products</legend>
                {PRODUCTS.map((p) => (
                  <label key={p.id} className="ph-check">
                    <input
                      type="checkbox"
                      checked={products.includes(p.id)}
                      onChange={(e) => {
                        setProducts((x) =>
                          e.target.checked
                            ? PRODUCTS.map((y) => y.id).filter((y) => y === p.id || x.includes(y))
                            : x.filter((y) => y !== p.id),
                        );
                      }}
                    />
                    <span>
                      <b>{p.label}</b>
                      <small>{p.hint}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
              <div className="b-row">
                <label className="b-field">
                  <span>Survey date</span>
                  <select
                    className="input"
                    value={capture}
                    onChange={(e) => {
                      setCapture(e.target.value);
                    }}
                  >
                    <option value="">None</option>
                    {project.manifest.captures.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label} ({c.date})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ph-check ph-gcpfirst">
                  <input
                    type="checkbox"
                    checked={gcpFirst}
                    onChange={(e) => {
                      setGcpFirst(e.target.checked);
                    }}
                  />
                  <span>
                    <b>I have ground control points</b>
                    <small>Products wait until you have marked them and adjusted.</small>
                  </span>
                </label>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <header role="none">
                <h3>Estimate for this computer</h3>
                <p>From the photos, the preset and this computer. Nothing has started yet.</p>
              </header>
              {probe && verdict && (
                <div className="ph-machine" data-testid="photo-probe">
                  <p className={verdict.ok ? 'small' : 'notice warn small'}>
                    {!verdict.ok && <Icon name="warn" size={14} />}
                    {verdict.text}
                  </p>
                  <p className="small faint">{machineLine(probe)}</p>
                  <p className="small" data-testid="photo-gpu">
                    {gpuLine(probe, preset)}
                  </p>
                </div>
              )}
              {estimate ? (
                <dl className="ph-estimate" data-testid="photo-estimate">
                  <div>
                    <dt>Time</dt>
                    <dd>{formatMinutes(estimate.minutes)}</dd>
                  </div>
                  <div>
                    <dt>Disk</dt>
                    <dd>{formatBytes(estimate.diskBytes)}</dd>
                  </div>
                  <div>
                    <dt>Memory</dt>
                    <dd>{formatBytes(estimate.memoryBytes)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="faint small">{estimating ? 'Estimating' : 'No estimate yet.'}</p>
              )}
              {notes && (
                <ul className="ph-notes">
                  {notes.other.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <footer className="b-foot">
          {error ? (
            <span className="err" role="alert">
              {error}
            </span>
          ) : (
            <span className="grow" />
          )}
          {(step < STEPS.length - 1 ? blocked : startBlocked) && (
            <span className="hint faint small">
              {step < STEPS.length - 1 ? blocked : startBlocked}
            </span>
          )}
          <button type="button" className="btn ghost" onClick={close}>
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
              data-testid="photo-start"
              disabled={busy || Boolean(startBlocked) || estimating}
              onClick={() => void go()}
            >
              <Icon name="play" size={14} />
              {busy ? 'Starting' : 'Start'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
