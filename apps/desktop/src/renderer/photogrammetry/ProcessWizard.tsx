/**
 * **Create maps from photos**: choose the photos, then start. One screen: a photos layer or
 * folders (dropped or chosen, read in place), a plain summary with the time on this computer, and
 * **Create maps**. Everything else starts from `SIMPLE_DEFAULTS` and stays under **Options**
 * (quality, what to create, coordinate system, heights, survey date, ground control first).
 *
 * What makes processing impossible on this computer is checked the moment the dialog opens and
 * shown in place of the form, with the one button that fixes it. A question shows inline only
 * when the photos raise it (another UTM zone, no GPS, a drive too small, a very long run).
 *
 * Start runs `photo.align`; the outputs start by themselves when the matching finishes
 * (`PhotoProcessLayer`), unless the person marks ground control first.
 */
import { crsOption, searchCrs } from '@aio/geo';
import type {
  AioBridge,
  HardwareProbe,
  PhotoEstimate,
  PhotoPreset,
  PhotoProduct,
  PhotoSource,
} from '@aio/schema';
import { Icon, useFocusTrap } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { bridge, useShell } from '../shell';
import { startAlign } from './actions';
import {
  cameraGroups,
  defaultProducts,
  diskNeed,
  fasterPreset,
  formatBytes,
  formatMinutes,
  gpsNote,
  isLongRun,
  longRunHint,
  memoryNote,
  newRunId,
  photoSummary,
  presetLabel,
  PRESETS,
  PRODUCTS,
  SIMPLE_DEFAULTS,
  splitNotes,
  suggestedEpsg,
  summaryLine,
  zoneQuestion,
} from './estimate';
import { gpuLine, machineLine, processingLine } from './hardware';
import { openProcessingTools } from '../processingTools';
import { photoUi } from './store';

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

const TITLE = 'Create maps from photos';

const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? p;
const parentFolder = (p: string) => p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, '');

/** The folders of a drop: a dropped folder as it is, a dropped photo as the folder it is in. */
function droppedFolders(e: DragEvent): string[] {
  const aio = (window as { aio?: AioBridge }).aio;
  const out: string[] = [];
  for (const item of [...e.dataTransfer.items]) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    const path = file ? (aio?.pathForFile?.(file) ?? '') : '';
    if (!path) continue;
    const folder = item.webkitGetAsEntry()?.isDirectory ? path : parentFolder(path);
    if (folder && !out.includes(folder)) out.push(folder);
  }
  return out;
}

interface Estimated {
  key: string;
  photosKey: string;
  estimate: PhotoEstimate;
}

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
  const [kind, setKind] = useState<'layer' | 'folders'>(layers.length ? 'layer' : 'folders');
  const [layerId, setLayerId] = useState(layers[0]?.id ?? '');
  const [folders, setFolders] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const projectEpsg = project && 'epsg' in project.manifest.crs ? project.manifest.crs.epsg : null;
  const [epsg, setEpsg] = useState<number | null>(projectEpsg);
  const [crsQuery, setCrsQuery] = useState('');
  const [gnss, setGnss] = useState<Gnss>(SIMPLE_DEFAULTS.gnss);
  const [preset, setPreset] = useState<PhotoPreset>(SIMPLE_DEFAULTS.preset);
  const [products, setProducts] = useState<PhotoProduct[]>(defaultProducts(SIMPLE_DEFAULTS.preset));
  const [capture, setCapture] = useState('');
  const [gcpFirst, setGcpFirst] = useState<boolean>(SIMPLE_DEFAULTS.groundControlFirst);
  /** `undefined` until this computer answered; null when it cannot say (the form then shows). */
  const [probe, setProbe] = useState<HardwareProbe | null | undefined>(undefined);
  const [result, setResult] = useState<Estimated | null>(null);
  const [quicker, setQuicker] = useState<(Estimated & { preset: PhotoPreset }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const photos: PhotoSource | null =
    kind === 'layer' ? (layerId ? { layer: layerId } : null) : folders.length ? { folders } : null;
  const photosKey = JSON.stringify(photos);
  const key = JSON.stringify([photos, preset, products]);

  // whether this computer can do it at all comes first, before anything is chosen
  useEffect(() => {
    let live = true;
    void bridge.call('photo:probe', {}).then((r) => {
      if (live) setProbe(r.ok && r.value.ok ? r.value.probe : null);
    });
    return () => {
      live = false;
    };
  }, []);

  const verdict = probe ? processingLine(probe) : null;
  const blocked = pkg
    ? {
        title: 'This project is a read-only package',
        text: 'Extract the package to create maps from its photos.',
        fix: null,
      }
    : verdict && !verdict.ok
      ? verdict
      : null;
  const ready = probe !== undefined && !blocked;

  // the estimate follows the photos, the quality and what to create
  useEffect(() => {
    if (!photos || !project || !ready) return;
    let live = true;
    void bridge
      .call('photo:estimate', { projectId: project.id, photos, preset, products })
      .then((r) => {
        if (!live) return;
        if (!r.ok) setError(r.error);
        else if (!r.value.ok) setError(r.value.error);
        else {
          setError(null);
          setResult({ key, photosKey, estimate: r.value.estimate });
        }
      });
    return () => {
      live = false;
    };
    // `key` stands for photos, preset and products
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready, project?.id]);

  const fresh = result !== null && result.key === key;
  const estimate = result?.photosKey === photosKey ? result.estimate : null;
  const estimating = photos !== null && !fresh && !error;
  const long = fresh && estimate !== null && isLongRun(estimate);
  const alt = fasterPreset(preset);

  // a very long run: how long the next quicker quality would take, to offer it in one click
  useEffect(() => {
    if (!long || !alt || !photos || !project) return;
    let live = true;
    void bridge
      .call('photo:estimate', {
        projectId: project.id,
        photos,
        preset: alt,
        products: defaultProducts(alt),
      })
      .then((r) => {
        if (live && r.ok && r.value.ok)
          setQuicker({ key, photosKey, preset: alt, estimate: r.value.estimate });
      });
    return () => {
      live = false;
    };
    // `key` stands for photos, preset and products
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, long, alt, project?.id]);

  if (!project) return null;

  const layer = layers.find((l) => l.id === layerId);
  const summary = estimate
    ? photoSummary(estimate, kind === 'layer' ? layer?.items.length : undefined)
    : null;
  const noPhotos = fresh && estimate !== null && estimate.minutes[1] === 0;
  const disk = fresh && estimate ? diskNeed(estimate) : null;
  const suggested = estimate ? suggestedEpsg(estimate) : null;
  const zone = estimate && !noPhotos ? zoneQuestion(projectEpsg, suggested) : null;
  const gps = summary && !noPhotos ? gpsNote(summary) : null;
  const slow =
    fresh && estimate && !disk && !noPhotos
      ? longRunHint(preset, estimate, quicker?.key === key ? quicker : null)
      : null;
  const notes = estimate ? splitNotes(estimate) : null;
  const groups = estimate ? cameraGroups(estimate) : null;
  const crsList = searchCrs(crsQuery);
  const crsChoices = [
    ...(projectEpsg !== null ? [projectEpsg] : []),
    ...(suggested !== null && suggested !== projectEpsg ? [suggested] : []),
    ...crsList.map((c) => c.epsg).filter((e) => e !== projectEpsg && e !== suggested),
  ];
  const datum = project.manifest.verticalDatum;

  /** What is still missing before a start, said once beside the button. */
  const missing = !photos
    ? kind === 'layer'
      ? 'Choose a photos layer.'
      : 'Choose a folder of photos to begin.'
    : !products.length
      ? 'Choose at least one thing to create in Options.'
      : null;
  const cannotStart = missing !== null || noPhotos || disk !== null;

  const choosePreset = (p: PhotoPreset) => {
    setPreset(p);
    setProducts(defaultProducts(p));
  };
  const addFolders = (paths: readonly string[]) => {
    if (!paths.length) return;
    setKind('folders');
    setFolders((f) => [...f, ...paths.filter((p) => !f.includes(p))]);
  };
  const chooseFolder = async () => {
    const r = await bridge.call('dialog:openFolder', { title: 'Folder of photos' });
    if (r.ok && r.value.path) addFolders([r.value.path]);
  };

  const go = async () => {
    if (!photos || cannotStart || !ready) return;
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

  // the one hint about time: beside the summary, or beside the quality choice while Options is open
  const timeHint = slow && (
    <div className="ph-q quiet" role="group" aria-label="Time" data-testid="ask-time">
      <p>
        <Icon name="clock" size={14} />
        <span>{slow.text}</span>
      </p>
      {slow.switchTo && (
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            if (slow.switchTo) choosePreset(slow.switchTo);
          }}
        >
          Use {presetLabel(slow.switchTo)}
        </button>
      )}
    </div>
  );

  // a drop on this dialog chooses photos; it never reaches the window's import
  const dragProps = ready
    ? {
        onDragEnter: (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        },
        onDragOver: (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: (e: DragEvent) => {
          e.stopPropagation();
          if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)))
            setOver(false);
        },
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          addFolders(droppedFolders(e));
        },
      }
    : {};

  return (
    <div
      ref={dlg}
      className="b-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={TITLE}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      {...dragProps}
    >
      <div className="ph-simple" data-testid="photo-wizard">
        <header className="ph-head" role="none">
          <div>
            <h2>{TITLE}</h2>
            {ready && (
              <p className="small faint">
                Choose the photos, then start. They are read where they are and never changed.
              </p>
            )}
          </div>
          <button type="button" className="btn ghost sm" onClick={close} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </header>

        {probe === undefined && !blocked && (
          <div className="b-body">
            <p className="faint small" role="status">
              Checking this computer
            </p>
          </div>
        )}

        {blocked && (
          <div className="b-body">
            <section className="ph-blocked" aria-label="Cannot start" data-testid="photo-blocked">
              <Icon name="warn" size={20} />
              <h3>{blocked.title}</h3>
              <p>{blocked.text}</p>
              <div className="ph-acts">
                {blocked.fix === 'tools' && (
                  <button
                    type="button"
                    className="btn primary"
                    data-testid="photo-fix"
                    onClick={openProcessingTools}
                  >
                    Update processing tools
                  </button>
                )}
                <button type="button" className="btn ghost" onClick={close}>
                  Close
                </button>
              </div>
            </section>
          </div>
        )}

        {ready && (
          <>
            <div className="b-body">
              {layers.length > 0 && (
                <div className="b-cards ph-source" role="group" aria-label="Photo source">
                  <button
                    type="button"
                    className="b-card"
                    aria-pressed={kind === 'layer'}
                    onClick={() => {
                      setKind('layer');
                    }}
                  >
                    <Icon name="photo" size={16} />
                    <b>Photos in this project</b>
                    <small>A photos layer you already imported.</small>
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
                    <small>A flight&apos;s folders on this computer.</small>
                  </button>
                </div>
              )}
              {kind === 'layer' ? (
                <label className="b-field">
                  <span>Photos</span>
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
                <div className={`ph-drop${over ? ' over' : ''}`} data-testid="photo-drop">
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
                  <div className="ph-drop-act">
                    {folders.length === 0 && <p>Drop a folder of photos here, or</p>}
                    <button
                      type="button"
                      className={folders.length ? 'btn sm' : 'btn'}
                      data-testid="photo-add-folder"
                      onClick={() => void chooseFolder()}
                    >
                      <Icon name="plus" size={14} />
                      {folders.length ? 'Add another folder' : 'Choose a folder'}
                    </button>
                  </div>
                  <p className="hint">JPEG or TIFF photos. Folders inside are read too.</p>
                </div>
              )}

              {photos && (
                <section className="ph-sum" aria-label="Summary" aria-live="polite">
                  {!summary && !error && <p className="faint small">Reading the photos</p>}
                  {noPhotos && (
                    <p className="notice warn small" data-testid="photo-none">
                      <Icon name="warn" size={14} />
                      No photos were found there. Choose a folder with JPEG or TIFF photos.
                    </p>
                  )}
                  {summary && estimate && !noPhotos && (
                    <>
                      <p className="ph-sum-line" data-testid="photo-summary">
                        {summaryLine(summary)}
                      </p>
                      <p className="ph-sum-time" data-testid="photo-estimate">
                        {fresh
                          ? `${formatMinutes(estimate.minutes)} on this computer`
                          : 'Working out the time'}
                      </p>
                      {fresh && (
                        <p className="small faint" data-testid="photo-needs">
                          Uses about {formatBytes(estimate.diskBytes)} of disk space and{' '}
                          {formatBytes(estimate.memoryBytes)} of memory while it runs.
                        </p>
                      )}
                    </>
                  )}
                </section>
              )}

              {disk && (
                <div className="ph-q" role="group" aria-label="Disk space" data-testid="ask-disk">
                  <p>
                    <Icon name="warn" size={14} />
                    <span>
                      Not enough free disk space: this needs {disk.needs} on the data drive, and it
                      has {disk.has}. Free some space
                      {alt ? `, or use ${presetLabel(alt)} quality, which needs less.` : '.'}
                    </span>
                  </p>
                  {alt && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        choosePreset(alt);
                      }}
                    >
                      Use {presetLabel(alt)}
                    </button>
                  )}
                </div>
              )}

              {!optionsOpen && timeHint}

              {zone && (
                <div
                  className="ph-q"
                  role="group"
                  aria-label="Coordinate system"
                  data-testid="ask-zone"
                >
                  <p>
                    <Icon name="globe" size={14} />
                    <span>
                      These photos were taken in {zone.photos.name}, but this project uses{' '}
                      {zone.project.name}. Which should the maps use?
                    </span>
                  </p>
                  <div className="ph-q-choice">
                    <button
                      type="button"
                      className="btn sm"
                      aria-pressed={epsg === zone.project.epsg}
                      onClick={() => {
                        setEpsg(zone.project.epsg);
                      }}
                    >
                      The project&apos;s ({zone.project.name})
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      aria-pressed={epsg === zone.photos.epsg}
                      onClick={() => {
                        setEpsg(zone.photos.epsg);
                      }}
                    >
                      The photos&apos; ({zone.photos.name})
                    </button>
                  </div>
                </div>
              )}

              {gps && (
                <p className="ph-note small" data-testid="photo-gps">
                  <Icon name="pin" size={14} />
                  <span>{gps}</span>
                </p>
              )}

              <details
                className="ph-options"
                data-testid="photo-options"
                onToggle={(e) => {
                  setOptionsOpen(e.currentTarget.open);
                }}
              >
                <summary>Options</summary>
                <div className="ph-options-body">
                  <div className="b-field">
                    <span id="ph-quality">Quality</span>
                    <div className="b-cards ph-presets" role="group" aria-labelledby="ph-quality">
                      {PRESETS.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="b-card"
                          aria-pressed={preset === p.id}
                          onClick={() => {
                            choosePreset(p.id);
                          }}
                        >
                          <Icon
                            name={
                              p.id === 'fast' ? 'play' : p.id === 'standard' ? 'layers' : 'target'
                            }
                            size={16}
                          />
                          <b>{p.label}</b>
                          <small>
                            {p.hint} {p.detail}
                          </small>
                        </button>
                      ))}
                    </div>
                    {/* beside the choice it is about, while that choice is in view */}
                    {optionsOpen && timeHint}
                  </div>

                  <fieldset className="ph-products">
                    <legend>What to create</legend>
                    {PRODUCTS.map((p) => (
                      <label key={p.id} className="ph-check">
                        <input
                          type="checkbox"
                          checked={products.includes(p.id)}
                          onChange={(e) => {
                            setProducts((x) =>
                              e.target.checked
                                ? PRODUCTS.map((y) => y.id).filter(
                                    (y) => y === p.id || x.includes(y),
                                  )
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

                  <div className="b-field">
                    <span>Coordinate system</span>
                    {projectEpsg === null ? (
                      <p className="small">The project&apos;s own coordinate system is used.</p>
                    ) : (
                      <>
                        <input
                          className="input"
                          type="search"
                          value={crsQuery}
                          placeholder="Search zone, country or EPSG code"
                          aria-label="Search coordinate systems"
                          onChange={(e) => {
                            setCrsQuery(e.target.value);
                          }}
                        />
                        <div className="b-list" role="listbox" aria-label="Coordinate system">
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
                    <span id="ph-gnss">Camera positions (GNSS)</span>
                    <div className="ph-radios" role="radiogroup" aria-labelledby="ph-gnss">
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

                  <div className="b-field">
                    <span>Heights</span>
                    <p className="small" data-testid="photo-heights">
                      {datum
                        ? `Absolute altitude ${datum.absAltOffsetM >= 0 ? '+' : ''}${datum.absAltOffsetM.toFixed(2)} m (the project's vertical datum${datum.note ? `: ${datum.note}` : ''}). Every run states the heights it used.`
                        : 'The photos’ altitudes as recorded; ground control corrects them. Every run states the heights it used.'}
                    </p>
                  </div>

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
                        <small>
                          Stop after matching the photos, to mark the points before the maps are
                          built.
                        </small>
                      </span>
                    </label>
                  </div>

                  <div className="b-field ph-machine">
                    <span>This computer and the cameras</span>
                    {probe && (
                      <p className="small faint" data-testid="photo-probe">
                        {machineLine(probe)}
                      </p>
                    )}
                    {probe && (
                      <p className="small faint" data-testid="photo-gpu">
                        {gpuLine(probe, preset)}
                      </p>
                    )}
                    {estimate && memoryNote(estimate) && (
                      <p className="small faint">{memoryNote(estimate)}</p>
                    )}
                    {groups && groups.length > 0 && (
                      <ul className="ph-groups" aria-label="Cameras" data-testid="photo-groups">
                        {groups.map((g) => (
                          <li key={g}>
                            <Icon name="camera" size={14} />
                            {g}
                          </li>
                        ))}
                      </ul>
                    )}
                    {groups && groups.length > 1 && (
                      <p className="small faint">
                        Each camera is calibrated on its own, which needs more overlap per camera.
                      </p>
                    )}
                  </div>
                </div>
              </details>
            </div>

            <footer className="b-foot">
              {error ? (
                <span className="err" role="alert">
                  {error}
                </span>
              ) : (
                <span className="grow hint faint small" data-testid="photo-missing">
                  {missing}
                </span>
              )}
              <button type="button" className="btn ghost" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                data-testid="photo-start"
                disabled={busy || cannotStart || estimating}
                onClick={() => void go()}
              >
                <Icon name="play" size={14} />
                {busy ? 'Starting' : 'Create maps'}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
