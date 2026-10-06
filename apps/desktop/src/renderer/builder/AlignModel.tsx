import { fitSimilarity3D, fromWgs84, toWgs84, type SimilarityFit } from '@aio/geo';
import { LocationPicker } from '@aio/maps';
import type { Layer, Vec3 } from '@aio/schema';
import { Icon } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { modelPoint, parseCoordinate } from './model';
import { hitLayer, useStagePick, usePickMarkers, type Marker } from './pick';
import { builder } from './state';

type MeshLayer = Extract<Layer, { kind: 'mesh' }>;
type TargetSource = 'scene' | 'map' | 'photo' | 'typed';

interface Pair {
  /** Model coordinates (mesh before its transform). */
  src: Vec3;
  /** Target in the local frame; y ignored when `horizontalOnly`. */
  dst: Vec3;
  horizontalOnly: boolean;
  from: TargetSource;
}

type Armed = 'model' | 'scene' | null;

const SOURCES: { id: TargetSource; label: string }[] = [
  { id: 'scene', label: 'Ortho or scene' },
  { id: 'map', label: 'Map' },
  { id: 'photo', label: 'Photo GPS' },
  { id: 'typed', label: 'Typed' },
];

const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);

/**
 * Georeference a model by point pairs: pick a point on the model, then where it really is (on the
 * ortho or other scene content, on the offline map, at a photo's GPS position, or typed survey
 * coordinates). Three or more pairs give a similarity transform with a residual per pair.
 */
export function AlignModel({ layerId }: { layerId: string }) {
  const project = useWorkspace((s) => s.project);
  const layers = useMemo(
    () => (project?.manifest.layers ?? []).filter((l): l is MeshLayer => l.kind === 'mesh'),
    [project],
  );
  const layer = layers.find((l) => l.id === layerId) ?? layers[0];
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [pending, setPending] = useState<Vec3 | null>(null);
  const [source, setSource] = useState<TargetSource>('scene');
  const [armed, setArmed] = useState<Armed>(null);
  const [mode, setMode] = useState<'upright' | 'full'>('upright');
  const [typed, setTyped] = useState('');
  const [say, setSay] = useState<{ text: string; tone?: 'armed' | 'bad' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [previous, setPrevious] = useState<number[] | null>(null);

  const origin = project?.manifest.origin;
  const epsg = project && 'epsg' in project.manifest.crs ? project.manifest.crs.epsg : null;

  const fit = useMemo<{ fit: SimilarityFit | null; error: string | null }>(() => {
    if (pairs.length < 3) return { fit: null, error: null };
    try {
      return {
        fit: fitSimilarity3D(pairs, mode, {
          heightOffset: layer ? (layer.transform[13] ?? 0) : 0,
        }),
        error: null,
      };
    } catch (e) {
      return { fit: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [pairs, mode, layer]);

  // while picking the target on the scene, hide the model so the ortho under it is reachable
  useEffect(() => {
    if (armed !== 'scene' || !layer) return;
    const was = workspace.getState().isLayerVisible(layer.id);
    workspace.getState().setLayerVisible(layer.id, false);
    return () => {
      workspace.getState().setLayerVisible(layer.id, was);
    };
  }, [armed, layer]);

  const addTarget = useCallback(
    (dst: Vec3, horizontalOnly: boolean, from: TargetSource) => {
      if (!pending) return;
      setPairs((p) => [...p, { src: pending, dst, horizontalOnly, from }]);
      setPending(null);
      setArmed(null);
      setSay({ text: 'Pair added. Pick the next point on the model.' });
    },
    [pending],
  );

  useStagePick(armed !== null, (hit) => {
    if (!layer) return;
    if (armed === 'model') {
      if (!hit || hitLayer(hit) !== layer.id) {
        setSay({ text: `That is not on ${layer.name}. Click a point on the model.`, tone: 'bad' });
        return;
      }
      setPending(modelPoint(layer.transform, [hit.point.x, hit.point.y, hit.point.z]));
      setArmed(null);
      setSay({ text: 'Now give the true position of that point.', tone: 'armed' });
    } else if (armed === 'scene') {
      if (!hit) {
        setSay({
          text: 'Nothing under the cursor. Click the ortho or another layer.',
          tone: 'bad',
        });
        return;
      }
      addTarget([hit.point.x, hit.point.y, hit.point.z], false, 'scene');
    }
  });

  const markers = useMemo<Marker[]>(() => {
    if (!layer) return [];
    const t = fit.fit?.matrix ?? layer.transform;
    const apply = (p: Vec3): Vec3 => [
      (t[0] ?? 0) * p[0] + (t[4] ?? 0) * p[1] + (t[8] ?? 0) * p[2] + (t[12] ?? 0),
      (t[1] ?? 0) * p[0] + (t[5] ?? 0) * p[1] + (t[9] ?? 0) * p[2] + (t[13] ?? 0),
      (t[2] ?? 0) * p[0] + (t[6] ?? 0) * p[1] + (t[10] ?? 0) * p[2] + (t[14] ?? 0),
    ];
    const out: Marker[] = [];
    for (const p of pairs) {
      out.push({ pos: apply(p.src), color: 0x60d3b2 });
      out.push({ pos: p.dst, color: 0xf4b740 });
    }
    if (pending) out.push({ pos: apply(pending), color: 0x60d3b2 });
    return out;
  }, [pairs, pending, layer, fit.fit]);
  usePickMarkers(markers);

  const lonLat = (p: Vec3): [number, number] | null => {
    if (!origin || epsg === null) return null;
    const ll = toWgs84([origin[0] + p[0], origin[1] - p[2], 0], epsg);
    return [ll[0], ll[1]];
  };
  const mapPoints = pairs
    .filter((p) => p.from === 'map')
    .map((p) => lonLat(p.dst))
    .filter((p): p is [number, number] => p !== null);
  const photos = (project?.manifest.layers ?? []).flatMap((l) =>
    l.kind === 'photos' ? l.items.flatMap((p) => (p.pos ? [{ id: p.id, pos: p.pos }] : [])) : [],
  );

  const save = async (transform: number[]) => {
    if (!layer) return;
    setSaving(true);
    const before = [...layer.transform];
    const err = await builder.getState().saveLayers([layer.id], { transform });
    setSaving(false);
    if (err) setSay({ text: err, tone: 'bad' });
    else {
      setPrevious(before);
      setSay({
        text: 'Saved. The model is placed; the previous manifest is kept as manifest.json.bak.',
      });
    }
  };

  if (!project || !layer || !origin || epsg === null)
    return (
      <section className="b-align" aria-label="Georeference model">
        <header role="none">
          <Icon name="target" size={14} />
          <b>Georeference model</b>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              builder.getState().stopAlign();
            }}
          >
            Close
          </button>
        </header>
        <div className="sec say">This project has no model to place.</div>
      </section>
    );

  const centre = lonLat([0, 0, 0]) ?? undefined;
  return (
    <section className="b-align" aria-label="Georeference model" data-testid="align-model">
      <header role="none">
        <Icon name="target" size={14} />
        <b>Georeference model</b>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            builder.getState().stopAlign();
          }}
        >
          Close
        </button>
      </header>
      <div className="scroll">
        <div className="sec">
          {layers.length > 1 && (
            <select
              className="input"
              value={layer.id}
              aria-label="Model"
              onChange={(e) => {
                setPairs([]);
                builder.getState().startAlign({ kind: 'mesh', layerId: e.target.value });
              }}
            >
              {layers.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          <div className="b-inline">
            <span className="faint">Fit</span>
            <div className="seg" role="group" aria-label="Fit">
              <button
                type="button"
                aria-pressed={mode === 'upright'}
                onClick={() => {
                  setMode('upright');
                }}
              >
                Level
              </button>
              <button
                type="button"
                aria-pressed={mode === 'full'}
                onClick={() => {
                  setMode('full');
                }}
              >
                Full 3D
              </button>
            </div>
          </div>
          <p className="say">
            {mode === 'upright'
              ? 'Turn about the vertical, scale and shift; the model stays level. Map targets fix the plan only.'
              : 'Any rotation, scale and shift; every target needs a height.'}
          </p>
        </div>

        <div className="sec">
          <div className="acts">
            <button
              type="button"
              className={`btn${armed === 'model' ? ' primary' : ''}`}
              onClick={() => {
                setArmed(armed === 'model' ? null : 'model');
                setSay({ text: `Click a recognisable point on ${layer.name}.`, tone: 'armed' });
              }}
              data-testid="pick-model"
            >
              <Icon name="point" size={14} />
              {pending ? 'Pick again on model' : 'Pick on model'}
            </button>
          </div>
          {pending && (
            <>
              <p className="say mono" data-testid="align-pending">
                Model point {f2(pending[0])} {f2(pending[1])} {f2(pending[2])}
              </p>
              <div className="b-inline">
                <span className="faint">Target from</span>
                <div className="seg" role="group" aria-label="Target from">
                  {SOURCES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={source === s.id}
                      onClick={() => {
                        setSource(s.id);
                      }}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              {source === 'scene' && (
                <button
                  type="button"
                  className={`btn${armed === 'scene' ? ' primary' : ''}`}
                  onClick={() => {
                    setArmed('scene');
                    setSay({
                      text: 'Click the same point on the ortho or another layer. The model is hidden meanwhile.',
                      tone: 'armed',
                    });
                  }}
                >
                  <Icon name="target" size={14} />
                  Pick on the scene
                </button>
              )}
              {source === 'map' && (
                <LocationPicker
                  className="b-mini-map"
                  {...(centre ? { center: centre, zoom: 16 } : {})}
                  points={mapPoints}
                  onPick={([lon, lat]) => {
                    const p = fromWgs84([lon, lat, 0], epsg);
                    addTarget([p[0] - origin[0], 0, 0 - (p[1] - origin[1])], true, 'map');
                  }}
                />
              )}
              {source === 'photo' && (
                <select
                  className="input"
                  aria-label="Photo"
                  value=""
                  onChange={(e) => {
                    const ph = photos.find((p) => p.id === e.target.value);
                    if (ph) addTarget(ph.pos, false, 'photo');
                  }}
                >
                  <option value="">
                    {photos.length ? 'Choose a photo taken above this point' : 'No photos with GPS'}
                  </option>
                  {photos.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id}
                    </option>
                  ))}
                </select>
              )}
              {source === 'typed' && (
                <form
                  className="b-inline"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const p = parseCoordinate(typed, epsg);
                    if (!p) {
                      setSay({
                        text: 'Type E N H in the project CRS, or lat, lon, h in degrees.',
                        tone: 'bad',
                      });
                      return;
                    }
                    addTarget(
                      [p[0] - origin[0], p[2] - origin[2], 0 - (p[1] - origin[1])],
                      false,
                      'typed',
                    );
                    setTyped('');
                  }}
                >
                  <input
                    className="input mono"
                    value={typed}
                    placeholder="E N H or lat, lon, h"
                    aria-label="Target coordinate"
                    onChange={(e) => {
                      setTyped(e.target.value);
                    }}
                  />
                  <button type="submit" className="btn">
                    Add
                  </button>
                </form>
              )}
            </>
          )}
          {say && <p className={`say ${say.tone ?? ''}`}>{say.text}</p>}
        </div>

        <div className="sec">
          <table className="b-pairs" aria-label="Point pairs">
            <thead>
              <tr>
                <th>#</th>
                <th>Model x y z</th>
                <th>Target E N H</th>
                <th className="r">Residual</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pairs.map((p, i) => {
                const r = fit.fit?.residuals[i];
                return (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>
                      {f1(p.src[0])} {f1(p.src[1])} {f1(p.src[2])}
                    </td>
                    <td>
                      {f1(origin[0] + p.dst[0])} {f1(origin[1] - p.dst[2])}{' '}
                      {p.horizontalOnly ? '-' : f1(origin[2] + p.dst[1])}
                    </td>
                    <td
                      className={`r${r !== undefined && fit.fit && r > 2 * fit.fit.rms && r > 0.05 ? ' hot' : ''}`}
                    >
                      {r === undefined ? '' : `${f2(r)} m`}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn ghost icon sm"
                        aria-label={`Remove pair ${String(i + 1)}`}
                        onClick={() => {
                          setPairs(pairs.filter((_, k) => k !== i));
                        }}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!pairs.length && (
                <tr>
                  <td colSpan={5} className="faint">
                    No pairs yet. Three or more spread around the model give a good fit.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {fit.error && <p className="say bad">{fit.error}</p>}
          {fit.fit && (
            <div className="b-stats" data-testid="align-stats">
              <div>
                <span>RMS</span>
                <b>{f2(fit.fit.rms)} m</b>
              </div>
              <div>
                <span>Max</span>
                <b>{f2(fit.fit.max)} m</b>
              </div>
              <div>
                <span>Scale</span>
                <b>{fit.fit.scale.toFixed(4)}</b>
              </div>
              <div>
                <span>Turn</span>
                <b>{f2(fit.fit.yawDeg)}°</b>
              </div>
              <div>
                <span>Shift E</span>
                <b>{f1(fit.fit.translation[0])}</b>
              </div>
              <div>
                <span>Shift N</span>
                <b>{f1(-fit.fit.translation[2])}</b>
              </div>
            </div>
          )}
          <div className="acts">
            <button
              type="button"
              className="btn primary"
              disabled={!fit.fit || saving}
              onClick={() => {
                if (fit.fit) void save(fit.fit.matrix);
              }}
              data-testid="align-save"
            >
              <Icon name="check" size={14} />
              Apply and save
            </button>
            {previous && (
              <button
                type="button"
                className="btn ghost"
                disabled={saving}
                onClick={() => void save(previous)}
              >
                <Icon name="undo" size={14} />
                Undo
              </button>
            )}
            {pairs.length > 0 && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setPairs([]);
                  setPending(null);
                }}
              >
                Clear pairs
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
