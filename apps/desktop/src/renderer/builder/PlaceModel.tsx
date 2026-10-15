import {
  composePlacement,
  createPlaceGizmo,
  decomposePlacement,
  getActiveStage,
  type GizmoMode,
  type PlaceGizmoHandle,
} from '@aio/engine';
import {
  fromWgs84,
  layerTransformToGeoref,
  localToProject,
  projectToLocal,
  toWgs84,
  upAxisOf,
  type UpAxis,
} from '@aio/geo';
import { LocationPicker } from '@aio/maps';
import type { Layer, Mat4, Vec3 } from '@aio/schema';
import { Icon, useT, type MessageKey } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useShell } from '../shell';
import { ExtractPackage } from '../shell/ExtractPackage';
import { parseCoordinate } from './model';
import { terrainHeightAt, useStagePick } from './pick';
import { builder } from './state';

type MeshLayer = Extract<Layer, { kind: 'mesh' }>;
type Field = 'east' | 'north' | 'up' | 'heading' | 'tiltX' | 'tiltZ' | 'scale';

const MODES: { id: GizmoMode; label: MessageKey }[] = [
  { id: 'move', label: 'place.mode.move' },
  { id: 'rotate', label: 'place.mode.rotate' },
  { id: 'tilt', label: 'place.mode.tilt' },
  { id: 'scale', label: 'place.mode.scale' },
];
const FIELDS: { id: Field; label: MessageKey }[] = [
  { id: 'east', label: 'place.east' },
  { id: 'north', label: 'place.north' },
  { id: 'up', label: 'place.up' },
  { id: 'heading', label: 'place.heading' },
  { id: 'tiltX', label: 'place.tiltX' },
  { id: 'tiltZ', label: 'place.tiltZ' },
  { id: 'scale', label: 'place.scale' },
];

const num = (v: number) => String(Number(v.toFixed(3)));

/**
 * Height under a plan point for Drop to ground: the top of the other models and clouds there
 * (the model being placed is left out), else the ground plane.
 */
function groundBelow(layerId: string): (x: number, z: number) => number | null {
  return (x, z) => {
    const group = getActiveStage()?.scene.getObjectByName(`layer:${layerId}`);
    const was = group?.visible;
    if (group) group.visible = false;
    try {
      return terrainHeightAt(x, z) ?? 0;
    } finally {
      if (group && was !== undefined) group.visible = was;
    }
  };
}

/**
 * Place model: put any model (GLB or OBJ, engineering or not) where it belongs. Click a point in
 * the scene, pick it on the map or type E N H or latitude and longitude; then move, turn, tilt and
 * scale it with the handle in the 3D view or the number fields. Drop to ground sets its height on
 * request only. Nothing is saved until Done; Undo steps back, Reset starts over, Cancel leaves
 * the model where it was. A saved placement can be undone too (the previous transform is saved
 * back). A model with a georeference gets one set by the person (statuses `user`), and one that
 * waited for placing is marked placed.
 */
export function PlaceModel({
  layerId,
  groundAt,
}: {
  layerId: string;
  /** Height under a plan point (tests); default: the scene below, without this model. */
  groundAt?: (x: number, z: number) => number | null;
}) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg);
  const layer = project?.manifest.layers.find(
    (l): l is MeshLayer => l.kind === 'mesh' && l.id === layerId,
  );
  const origin = project?.manifest.origin;
  const epsg = project && 'epsg' in project.manifest.crs ? project.manifest.crs.epsg : null;
  const up: UpAxis = layer ? upAxisOf(layer.transform) : 'y';

  const [start, setStart] = useState<Mat4 | null>(layer ? [...layer.transform] : null);
  const [current, setCurrent] = useState<Mat4 | null>(layer ? [...layer.transform] : null);
  const [history, setHistory] = useState<Mat4[]>([]);
  const [previous, setPrevious] = useState<Mat4 | null>(null);
  const [mode, setMode] = useState<GizmoMode>('move');
  const [armed, setArmed] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [drafts, setDrafts] = useState<Partial<Record<Field, string>>>({});
  const [say, setSay] = useState<{ text: string; tone?: 'armed' | 'bad' } | null>(null);
  const [saving, setSaving] = useState(false);
  const gizmo = useRef<PlaceGizmoHandle | null>(null);
  // the transform as last set, for the handle's callbacks (kept in step by `keep`)
  const currentRef = useRef(current);
  const keep = useCallback((next: Mat4 | null) => {
    currentRef.current = next;
    setCurrent(next);
  }, []);
  useLayoutEffect(() => {
    currentRef.current = current;
  }, [current]);
  const readOnly = pkg !== null;

  // A moved origin (a re-centre) changes the local frame: everything held belongs to the old one.
  const frame = origin ? origin.join(' ') : '';
  const [heldFrame, setHeldFrame] = useState(frame);
  if (heldFrame !== frame) {
    setHeldFrame(frame);
    setStart(layer ? [...layer.transform] : null);
    setCurrent(layer ? [...layer.transform] : null);
    setHistory([]);
    setPrevious(null);
  }

  // the handle in the 3D view, for as long as the panel is open
  useEffect(() => {
    if (readOnly || !layer) return;
    const stage = getActiveStage();
    if (!stage) return;
    const g = createPlaceGizmo(stage);
    gizmo.current = g;
    g.attach(layer.id, currentRef.current ?? layer.transform);
    g.setMode('move');
    const offChange = g.onChange((next) => {
      keep(next);
    });
    const offDrag = g.onDrag((dragging) => {
      // one Undo step per drag
      const at = currentRef.current;
      if (dragging && at) setHistory((h) => [...h, at]);
    });
    return () => {
      offChange();
      offDrag();
      g.detach();
      gizmo.current = null;
    };
    // the handle is made once per model; later transforms reach it through `show`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, layer?.id]);

  /** Show a transform on the model and the handle, and keep it (one Undo step). */
  const apply = useCallback(
    (next: Mat4, record = true) => {
      const at = currentRef.current;
      if (record && at) setHistory((h) => [...h, at]);
      keep(next);
      gizmo.current?.set(next);
    },
    [keep],
  );

  // while picking in the scene, hide the model so what is under it can be clicked
  useEffect(() => {
    if (!armed || !layer) return;
    const was = workspace.getState().isLayerVisible(layer.id);
    workspace.getState().setLayerVisible(layer.id, false);
    return () => {
      workspace.getState().setLayerVisible(layer.id, was);
    };
  }, [armed, layer]);

  const placement = current ? decomposePlacement(current, up) : null;
  const base = start ? decomposePlacement(start, up) : null;
  const moveTo = (anchor: Vec3) => {
    if (!placement) return;
    apply(composePlacement({ ...placement, anchor, up }));
  };

  useStagePick(armed, (hit) => {
    if (!hit) {
      setSay({ text: t('place.pickNothing'), tone: 'bad' });
      return;
    }
    setArmed(false);
    setSay(null);
    moveTo([hit.point.x, hit.point.y, hit.point.z]);
  });

  if (!project || !layer || !origin || epsg === null || !current || !placement || !base)
    return (
      <Shell t={t}>
        <div className="sec say">{t('place.noModel')}</div>
      </Shell>
    );

  if (readOnly)
    return (
      <Shell t={t}>
        <div className="sec" data-testid="place-readonly">
          <p className="say">{t('place.readOnly')}</p>
          <ExtractPackage projectId={project.id} pkg={pkg} />
        </div>
      </Shell>
    );

  const fieldValue = (f: Field): number => {
    switch (f) {
      case 'east':
        return placement.anchor[0] - base.anchor[0];
      case 'north':
        return -(placement.anchor[2] - base.anchor[2]);
      case 'up':
        return placement.anchor[1] - base.anchor[1];
      case 'heading':
        return placement.headingDeg;
      case 'tiltX':
        return placement.tiltXDeg;
      case 'tiltZ':
        return placement.tiltZDeg;
      case 'scale':
        return placement.scale;
    }
  };
  const commitField = (f: Field) => {
    const text = drafts[f];
    setDrafts((d) => ({ ...d, [f]: undefined }));
    if (text === undefined) return;
    const v = Number(text.replace(',', '.'));
    if (!Number.isFinite(v) || (f === 'scale' && v <= 0) || v === fieldValue(f)) return;
    const p = { ...placement, anchor: [...placement.anchor] as Vec3 };
    if (f === 'east') p.anchor[0] = base.anchor[0] + v;
    else if (f === 'north') p.anchor[2] = base.anchor[2] - v;
    else if (f === 'up') p.anchor[1] = base.anchor[1] + v;
    else if (f === 'heading') p.headingDeg = v;
    else if (f === 'tiltX') p.tiltXDeg = v;
    else if (f === 'tiltZ') p.tiltZDeg = v;
    else p.scale = v;
    apply(composePlacement({ ...p, up }));
  };
  const enterCommits = (f: Field) => (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitField(f);
    }
  };

  const save = async (transform: Mat4, after: () => void) => {
    setSaving(true);
    const b = builder.getState();
    let err = await b.saveLayers([layer.id], { transform });
    // a georeferenced model keeps a record of where it sits, now set by the person; a model that
    // waited for placing is placed
    if (!err && (layer.georef || (layer.placement && layer.placement !== 'placed'))) {
      const georef = layer.georef
        ? layerTransformToGeoref(
            transform,
            { crs: project.manifest.crs, origin },
            layer.georef,
            'place-model',
          )
        : undefined;
      err = await b.saveLayers([layer.id], {
        ...(georef ? { georef } : {}),
        placement: 'placed',
      });
    }
    setSaving(false);
    if (err) setSay({ text: err, tone: 'bad' });
    else after();
  };
  const done = () => {
    const before = start ?? layer.transform;
    void save(current, () => {
      setPrevious(before);
      setStart(current);
      setHistory([]);
      setSay({ text: t('place.saved') });
    });
  };
  const undo = () => {
    const last = history.at(-1);
    if (last) {
      setHistory((h) => h.slice(0, -1));
      apply(last, false);
      return;
    }
    if (previous) {
      const back = previous;
      void save(back, () => {
        setPrevious(null);
        setStart(back);
        apply(back, false);
        setSay(null);
      });
    }
  };
  const close = () => {
    // what was not saved goes: the model is drawn where the manifest has it
    gizmo.current?.set(layer.transform);
    gizmo.current?.detach();
    gizmo.current = null;
    builder.getState().stopAlign();
  };

  const world = localToProject(placement.anchor, origin);
  const lonLat = (p: Vec3): [number, number] => {
    const ll = toWgs84([origin[0] + p[0], origin[1] - p[2], 0], epsg);
    return [ll[0], ll[1]];
  };
  const changed = current.some((v, i) => v !== start?.[i]);

  return (
    <Shell t={t} onClose={close}>
      <div className="scroll">
        <div className="sec">
          <div className="b-inline">
            <span className="faint">{t('place.handle')}</span>
            <div className="seg" role="group" aria-label={t('place.handle')}>
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={mode === m.id}
                  data-testid={`place-mode-${m.id}`}
                  onClick={() => {
                    setMode(m.id);
                    gizmo.current?.setMode(m.id);
                  }}
                >
                  {t(m.label)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="sec">
          <span className="faint">{t('place.where')}</span>
          <div className="acts">
            <button
              type="button"
              className={`btn${armed ? ' primary' : ''}`}
              data-testid="place-pick-scene"
              onClick={() => {
                setArmed(!armed);
                setSay(armed ? null : { text: t('place.pickSceneArmed'), tone: 'armed' });
              }}
            >
              <Icon name="target" size={14} />
              {t('place.pickScene')}
            </button>
            <button
              type="button"
              className={`btn${mapOpen ? ' primary' : ''}`}
              aria-expanded={mapOpen}
              onClick={() => {
                setMapOpen(!mapOpen);
              }}
            >
              <Icon name="map" size={14} />
              {t('place.pickMap')}
            </button>
            <button
              type="button"
              className="btn"
              data-testid="place-drop"
              onClick={() => {
                const h = (groundAt ?? groundBelow(layer.id))(
                  placement.anchor[0],
                  placement.anchor[2],
                );
                if (h === null) setSay({ text: t('place.dropNothing'), tone: 'bad' });
                else moveTo([placement.anchor[0], h, placement.anchor[2]]);
              }}
            >
              <Icon name="chevdown" size={14} />
              {t('place.drop')}
            </button>
          </div>
          {mapOpen && (
            <LocationPicker
              className="b-mini-map"
              center={lonLat(placement.anchor)}
              zoom={17}
              points={[lonLat(placement.anchor)]}
              onPick={([lon, lat]) => {
                const p = fromWgs84([lon, lat, 0], epsg);
                const local = projectToLocal([p[0], p[1], world[2]], origin);
                moveTo([local[0], placement.anchor[1], local[2]]);
              }}
            />
          )}
          <form
            className="b-inline"
            onSubmit={(e) => {
              e.preventDefault();
              const p = parseCoordinate(typed, epsg);
              if (!p) {
                setSay({ text: t('place.typedBad'), tone: 'bad' });
                return;
              }
              setSay(null);
              setTyped('');
              moveTo(projectToLocal(p, origin));
            }}
          >
            <input
              className="input mono"
              value={typed}
              placeholder={t('place.typed')}
              aria-label={t('place.typedLabel')}
              data-testid="place-typed"
              onChange={(e) => {
                setTyped(e.target.value);
              }}
            />
            <button type="submit" className="btn">
              {t('place.go')}
            </button>
          </form>
          <p className="say mono" data-testid="place-position">
            {t('place.position', {
              e: world[0].toFixed(2),
              n: world[1].toFixed(2),
              h: world[2].toFixed(2),
            })}
          </p>
        </div>

        <div className="sec b-place-fields">
          {FIELDS.map((f) => (
            <label key={f.id}>
              <span className="faint">{t(f.label)}</span>
              <input
                className="input mono"
                inputMode="decimal"
                data-testid={`place-${f.id}`}
                value={drafts[f.id] ?? num(fieldValue(f.id))}
                onChange={(e) => {
                  setDrafts((d) => ({ ...d, [f.id]: e.target.value }));
                }}
                onBlur={() => {
                  commitField(f.id);
                }}
                onKeyDown={enterCommits(f.id)}
              />
            </label>
          ))}
        </div>

        <div className="sec">
          {say && (
            <p className={`say ${say.tone ?? ''}`} data-testid="place-say">
              {say.text}
            </p>
          )}
          <div className="acts">
            <button
              type="button"
              className="btn primary"
              disabled={saving || !changed}
              data-testid="place-done"
              onClick={done}
            >
              <Icon name="check" size={14} />
              {saving ? t('place.saving') : t('place.done')}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={saving || (!history.length && !previous)}
              data-testid="place-undo"
              onClick={undo}
            >
              <Icon name="undo" size={14} />
              {t('place.undo')}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={saving || !changed}
              data-testid="place-reset"
              onClick={() => {
                if (start) apply(start);
              }}
            >
              {t('place.reset')}
            </button>
            <button
              type="button"
              className="btn ghost"
              disabled={saving}
              data-testid="place-cancel"
              onClick={close}
            >
              {t('place.cancel')}
            </button>
          </div>
        </div>
      </div>
    </Shell>
  );
}

/** The panel frame, as the Georeference model panel's. */
function Shell({
  t,
  onClose,
  children,
}: {
  t: ReturnType<typeof useT>;
  onClose?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="b-align" aria-label={t('place.title')} data-testid="place-model">
      <header role="none">
        <Icon name="target" size={14} />
        <b>{t('place.title')}</b>
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => {
            if (onClose) onClose();
            else builder.getState().stopAlign();
          }}
        >
          {t('place.close')}
        </button>
      </header>
      {children}
    </section>
  );
}
