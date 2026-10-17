import {
  basisShape,
  createPlaceGizmo,
  getActiveStage,
  placeOnBasis,
  placementOnBasis,
  splitPlacement,
  type GizmoMode,
  type PlaceGizmoHandle,
} from '@aio/engine';
import { fromWgs84, localToProject, projectToLocal, toWgs84 } from '@aio/geo';
import { LocationPicker } from '@aio/maps';
import {
  drawnTransform,
  storedTransform,
  type Layer,
  type LayerPatch,
  type Mat4,
  type Vec3,
} from '@aio/schema';
import { Icon, useT, type MessageKey } from '@aio/ui';
import { dateShiftOf, shiftKey, useWorkspace, workspace } from '@aio/workspace';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useShell } from '../shell';
import { ExtractPackage } from '../shell/ExtractPackage';
import { parseCoordinate } from './model';
import { terrainHeightAt, useStagePick } from './pick';
import { modelBaseY, patchOf, placedPatch, type SavedPlacement } from './modelPlacement';
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
 * How far the model's lowest point lies below its origin, as drawn now (the layer's bounds in the
 * 3D view); 0 without a 3D view. Drop to ground lands that point, not the origin.
 */
function originAboveBase(layerId: string, originY: number): number {
  const base = modelBaseY(layerId);
  return base === null ? 0 : originY - base;
}

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
 *
 * On a lined-up date the panel works where the model is drawn (its transform plus the date
 * shift): the handle, picks, typed positions and the readout are all in that frame, and Done saves
 * the transform less the shift, so the model reloads where it was put.
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
  const shift = project && layer ? dateShiftOf(project.manifest, layer.id) : null;
  const shiftAt = shiftKey(shift);
  // the transform as drawn on its date: what the panel shows and edits
  const stored = layer?.transform;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the shift is keyed by `shiftAt`
  const drawn = useMemo(() => (stored ? drawnTransform(stored, shift) : null), [stored, shiftAt]);
  const epsg = project && 'epsg' in project.manifest.crs ? project.manifest.crs.epsg : null;
  // what the edits keep (the up axis, the model's own scale, a mirroring), fixed at open
  const [basis, setBasis] = useState<Mat4 | null>(() =>
    drawn ? splitPlacement(drawn).basis : null,
  );
  const [start, setStart] = useState<Mat4 | null>(drawn ? [...drawn] : null);
  const [current, setCurrent] = useState<Mat4 | null>(drawn ? [...drawn] : null);
  const [history, setHistory] = useState<Mat4[]>([]);
  const [previous, setPrevious] = useState<SavedPlacement | null>(null);
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
  const basisRef = useRef(basis);
  useLayoutEffect(() => {
    basisRef.current = basis;
  }, [basis]);
  const readOnly = pkg !== null;

  // A moved origin (a re-centre) or a new date shift changes the frame the model is drawn in:
  // everything held belongs to the old one.
  const frame = origin ? `${origin.join(' ')}|${shiftAt}` : '';
  const [heldFrame, setHeldFrame] = useState(frame);
  if (heldFrame !== frame) {
    setHeldFrame(frame);
    setBasis(drawn ? splitPlacement(drawn).basis : null);
    setStart(drawn ? [...drawn] : null);
    setCurrent(drawn ? [...drawn] : null);
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
    g.attach(
      layer.id,
      currentRef.current ?? drawnTransform(layer.transform, shift),
      basisRef.current ?? undefined,
    );
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

  // a re-centre moves the local frame: the handle and the model follow the manifest at once
  const shownFrame = useRef(frame);
  useEffect(() => {
    if (shownFrame.current === frame) return;
    shownFrame.current = frame;
    const at = currentRef.current;
    if (at) gizmo.current?.attach(layerId, at, basisRef.current ?? undefined);
  }, [frame, layerId]);

  // Escape: a pick that is armed lets go; otherwise the panel closes as Cancel does. It listens
  // before the 3D view (capture) and marks the key taken, so the same press does not also clear
  // the selection there; a menu or another dialog keeps its own Escape.
  const manifestTransform = drawn;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = e.target;
      if (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable ||
          el.closest('[role="dialog"],[role="menu"],[role="listbox"]') !== null)
      )
        return;
      e.preventDefault();
      if (armed) {
        setArmed(false);
        setSay(null);
        return;
      }
      if (manifestTransform) gizmo.current?.set(manifestTransform);
      gizmo.current?.detach();
      gizmo.current = null;
      builder.getState().stopAlign();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [armed, manifestTransform]);

  // while picking in the scene, hide the model so what is under it can be clicked
  useEffect(() => {
    if (!armed || !layer) return;
    const was = workspace.getState().isLayerVisible(layer.id);
    workspace.getState().setLayerVisible(layer.id, false);
    return () => {
      workspace.getState().setLayerVisible(layer.id, was);
    };
  }, [armed, layer]);

  const placement = current && basis ? placementOnBasis(current, basis) : null;
  const base = start && basis ? placementOnBasis(start, basis) : null;
  const moveTo = (anchor: Vec3) => {
    if (!placement || !basis) return;
    apply(placeOnBasis({ ...placement, anchor }, basis));
  };

  useStagePick(armed, (hit) => {
    // a click on the handle is the handle's
    if (gizmo.current?.busy()) return;
    if (!hit) {
      setSay({ text: t('place.pickNothing'), tone: 'bad' });
      return;
    }
    setArmed(false);
    setSay(null);
    moveTo([hit.point.x, hit.point.y, hit.point.z]);
  });

  if (!project || !layer || !origin || epsg === null || !current || !placement || !base || !basis)
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
    apply(placeOnBasis(p, basis));
  };
  const enterCommits = (f: Field) => (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitField(f);
    }
  };

  /** One manifest write; `after` runs once it is saved. */
  const save = async (patch: LayerPatch, after: () => void) => {
    setSaving(true);
    const err = await builder.getState().saveLayers([layer.id], patch);
    setSaving(false);
    if (err) setSay({ text: err, tone: 'bad' });
    else after();
  };
  const done = () => {
    const before: SavedPlacement = {
      transform: start ? storedTransform(start, shift) : layer.transform,
      georef: layer.georef,
      placement: layer.placement,
    };
    // a georeferenced model keeps a record of where it sits, now set by the person; a model that
    // waited for placing is placed; all with the transform, in one write. Saved in the date's own
    // frame: the engine adds the shift again when it draws the model.
    const toSave = storedTransform(current, shift);
    void save(placedPatch(layer, toSave, { crs: project.manifest.crs, origin }), () => {
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
      void save(patchOf(back), () => {
        const shown = drawnTransform(back.transform, shift);
        setPrevious(null);
        setStart(shown);
        apply(shown, false);
        setSay(null);
      });
    }
  };
  const close = () => {
    // what was not saved goes: the model is drawn where the manifest has it
    gizmo.current?.set(drawnTransform(layer.transform, shift));
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
  const shape = basisShape(basis);

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
                // the model's lowest point lands on the ground, not its origin
                const lift = originAboveBase(layer.id, placement.anchor[1]);
                if (h === null) setSay({ text: t('place.dropNothing'), tone: 'bad' });
                else moveTo([placement.anchor[0], h + lift, placement.anchor[2]]);
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
              // without a height the model keeps the one it has
              const numbers = typed
                .trim()
                .split(/[\s,;]+/)
                .filter(Boolean).length;
              const h = numbers < 3 ? world[2] : p[2];
              setSay(null);
              setTyped('');
              moveTo(projectToLocal([p[0], p[1], h], origin));
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
              {t('place.typedGo')}
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

        {(shape.mirrored || shape.stretched) && (
          <p className="sec say" data-testid="place-kept">
            {t('place.keptBasis')}
          </p>
        )}
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
            <p className={`say ${say.tone ?? ''}`} role="status" data-testid="place-say">
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
