import type { EngineStage } from '@aio/engine';
import { Icon } from '@aio/ui';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Raycaster, Vector2, Vector3, type Object3D } from 'three';
import type { EN } from '../model/edit';
import { CHANGE_RAMP } from '../model/dsm';
import { VolumetricScene } from '../scene/controller';
import { useVolumetric, volumetric } from '../store';
import { f0, sgn } from './format';
import { CUT_CSS, FILL_CSS, ProfileChart } from './ProfileChart';

const short = (label: string) => label.replace(/ 20\d\d$/, '');

function ndcOf(stage: EngineStage, clientX: number, clientY: number): [number, number] {
  const r = stage.renderer.domElement.getBoundingClientRect();
  return [((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1];
}

/** Ground point (E, N, H) under the pointer, from the stage's own picking. */
function pickGround(
  stage: EngineStage,
  clientX: number,
  clientY: number,
): [number, number, number] | null {
  const hit = stage.raycast(...ndcOf(stage, clientX, clientY));
  if (!hit) return null;
  const o = volumetric.getState().origin;
  return [hit.point.x + o[0], o[1] - hit.point.z, hit.point.y + o[2]];
}

/** Orbit controls off while a handle is dragged. */
function setOrbit(stage: EngineStage, on: boolean) {
  stage.controls.enabled = on;
}

function setCursor(stage: EngineStage, cursor: string) {
  stage.renderer.domElement.style.cursor = cursor;
}

function isTyping(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement && (/INPUT|SELECT|TEXTAREA/.test(t.tagName) || t.isContentEditable)
  );
}

/* ------------------------------------------------------------------ boundary handles */

interface Drag {
  index: number;
  insert: boolean;
  ring: EN[];
  z: number[];
  moved: boolean;
}

function Handles({ scene, stage }: { scene: VolumetricScene; stage: EngineStage }) {
  const edit = useVolumetric((s) => s.edit);
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const ring = edit?.ring ?? [];
  const verts = edit?.live?.vertices;

  // vertex heights: the worker's surface under each point, the last known while it computes
  const vertZ = verts?.length === ring.length && !edit?.busy ? verts.map((v) => v[2]) : null;
  const lastZ = useRef<number[]>([]);

  useLayoutEffect(() => {
    if (vertZ) lastZ.current = vertZ;
    const el = host.current;
    if (!el) return;
    const place = () => {
      const r = stage.renderer.domElement.getBoundingClientRect();
      const own = el.getBoundingClientRect();
      const d = drag.current;
      const pts = d ? d.ring : ring;
      const z = d ? d.z : (vertZ ?? lastZ.current);
      const v = new Vector3();
      const at = (E: number, N: number, H: number, node: HTMLElement) => {
        v.copy(scene.world(E, N, H + 0.4)).project(stage.camera);
        const vis = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
        node.style.display = vis ? '' : 'none';
        if (vis)
          node.style.transform = `translate(${(((v.x + 1) / 2) * r.width + r.left - own.left).toFixed(1)}px, ${(((1 - v.y) / 2) * r.height + r.top - own.top).toFixed(1)}px) translate(-50%, -50%)`;
      };
      const n = pts.length;
      el.querySelectorAll<HTMLElement>('[data-v]').forEach((node) => {
        const k = Number(node.dataset.v);
        const p = pts[k];
        if (p) at(p[0], p[1], z[k] ?? 0, node);
      });
      el.querySelectorAll<HTMLElement>('[data-m]').forEach((node) => {
        const k = Number(node.dataset.m);
        const a = pts[k];
        const b = pts[(k + 1) % n];
        if (a && b && !d)
          at((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, ((z[k] ?? 0) + (z[(k + 1) % n] ?? 0)) / 2, node);
        else if (d) node.style.display = 'none';
      });
    };
    place();
    const off = scene.onFrame(place);
    stage.requestRender();
    return off;
  });

  // Delete removes the selected point, Ctrl+Z undoes
  useEffect(() => {
    if (!edit) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const s = volumetric.getState();
      const ed = s.edit;
      if (!ed) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && ed.sel >= 0) {
        e.preventDefault();
        void s.deleteVertex(ed.sel);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        void s.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [edit]);

  if (!edit) return null;

  const begin = (e: ReactPointerEvent<HTMLButtonElement>, index: number, insert: boolean) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = ring.map((q): EN => [q[0], q[1]]);
    const z = [...(vertZ ?? lastZ.current)];
    let k = index;
    if (insert) {
      const a = r[index];
      const b = r[(index + 1) % r.length];
      if (!a || !b) return;
      r.splice(index + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
      z.splice(index + 1, 0, ((z[index] ?? 0) + (z[(index + 1) % z.length] ?? 0)) / 2);
      k = index + 1;
    } else volumetric.getState().selectVertex(index);
    drag.current = { index: k, insert, ring: r, z, moved: false };
    setOrbit(stage, false);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = pickGround(stage, e.clientX, e.clientY);
    if (!p) return;
    d.ring[d.index] = [p[0], p[1]];
    d.z[d.index] = p[2];
    d.moved = true;
    scene.setDragRing({ ring: d.ring, z: d.z });
    stage.requestRender();
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    setOrbit(stage, true);
    scene.setDragRing(null);
    if (!d) return;
    const p = d.ring[d.index];
    if (!p) return;
    lastZ.current = d.z;
    const s = volumetric.getState();
    if (d.insert) void s.insertVertex(d.index - 1, p);
    else if (d.moved) void s.moveVertex(d.index, p);
  };

  return (
    <div className="vol-handles" ref={host}>
      {ring.map((_, k) => (
        <button
          key={`m${String(k)}`}
          type="button"
          className="vol-mh"
          data-m={k}
          title="Drag to add a point here"
          aria-label={`Add a point between points ${String(k + 1)} and ${String(((k + 1) % ring.length) + 1)}`}
          onPointerDown={(e) => {
            begin(e, k, true);
          }}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        />
      ))}
      {ring.map((_, k) => (
        <button
          key={`v${String(k)}`}
          type="button"
          className={`vol-vh${edit.sel === k ? ' sel' : ''}`}
          data-v={k}
          title="Drag to move. Select and press Delete to remove."
          aria-label={`Boundary point ${String(k + 1)}`}
          onPointerDown={(e) => {
            begin(e, k, false);
          }}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onContextMenu={(e) => {
            e.preventDefault();
            void volumetric.getState().deleteVertex(k);
          }}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ bars and panels */

function EditBar() {
  const edit = useVolumetric((s) => s.edit);
  const base = useVolumetric((s) => s.base);
  const piles = useVolumetric((s) => s.piles);
  const saving = useVolumetric((s) => s.saving);
  const captures = useVolumetric((s) => s.file?.captures ?? []);
  if (!edit) return null;
  const auto = piles.find((p) => p.id === edit.pile)?.auto[edit.epoch]?.volumes[base].net;
  const v = edit.live?.result.volumes[base].net;
  const label = captures.find((c) => c.epoch === edit.epoch)?.label ?? edit.epoch;
  let note: string;
  if (!edit.dirty && !edit.resetToAuto)
    note = auto === undefined ? 'No changes yet' : `No changes yet. Automatic ${f0(auto)} m³`;
  else if (auto !== undefined && v !== undefined)
    note = `automatic ${f0(auto)} m³ · ${sgn(v - auto)} m³`;
  else note = 'not detected on this date';
  return (
    <div
      className="vol-editbar overlay-box"
      role="toolbar"
      aria-label="Boundary editor"
      data-testid="vol-editbar"
    >
      <div className="vol-eb-t">
        <span>
          Editing {edit.pile} · {short(label)}
        </span>
        <b data-testid="vol-edit-net">{edit.busy && !edit.live ? '·' : `${f0(v)} m³`}</b>
        <small>{note}</small>
      </div>
      <div className="vol-eb-a">
        <button
          type="button"
          className="btn sm"
          disabled={!edit.hist.length}
          onClick={() => {
            void volumetric.getState().undo();
          }}
        >
          <Icon name="undo" size={14} />
          Undo
        </button>
        <button
          type="button"
          className="btn sm"
          title="Back to the automatic toe line"
          onClick={() => {
            void volumetric.getState().resetEdit();
          }}
        >
          Automatic
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            volumetric.getState().cancelEdit();
            volumetric.getState().setMessage('Edit discarded');
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn sm primary"
          disabled={(!edit.dirty && !edit.resetToAuto) || saving || edit.busy}
          onClick={() => {
            void volumetric.getState().saveEdit();
          }}
        >
          <Icon name="check" size={14} />
          Save
        </button>
      </div>
    </div>
  );
}

function SectionPanel() {
  const section = useVolumetric((s) => s.section);
  const captures = useVolumetric((s) => s.file?.captures ?? []);
  const deadband = useVolumetric((s) => s.file?.deadbandM ?? 0.1);
  if (section.mode === 'idle') return null;
  const first = captures[0];
  const last = captures.at(-1);
  const p = section.profile;
  return (
    <div
      className="vol-secpanel overlay-box"
      role="region"
      aria-label="Section"
      data-testid="vol-section"
    >
      <div className="vol-row">
        <b>{p ? `Section · ${f0(p.lengthM)} m` : 'Section'}</b>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            volumetric.getState().clearSection();
          }}
        >
          {section.mode === 'picking' ? 'Cancel' : 'Clear'}
        </button>
      </div>
      {section.mode === 'picking' ? (
        <p className="vol-note">
          Click two points on the ground: {section.points.length === 0 ? 'start' : 'end'} of the
          line.
        </p>
      ) : p ? (
        <>
          <ProfileChart
            s={p.s}
            series={[
              { z: p.z1, label: short(first?.label ?? ''), color: 'var(--fg-3)' },
              { z: p.z2, label: short(last?.label ?? ''), color: 'var(--acc)' },
            ]}
            deadband={deadband}
            height={170}
            label="Elevation profile along the drawn line for both survey dates"
          />
          <p className="vol-note">
            Area between the two surfaces along the line:{' '}
            <span className="vol-cut" data-testid="vol-sec-cut">
              {f0(p.cutM2)} m² cut
            </span>{' '}
            ·{' '}
            <span className="vol-fill" data-testid="vol-sec-fill">
              {f0(p.fillM2)} m² fill
            </span>
          </p>
        </>
      ) : (
        <p className="vol-note">Profiling…</p>
      )}
    </div>
  );
}

function SwipeDivider() {
  const swipe = useVolumetric((s) => s.swipe);
  const x = useVolumetric((s) => s.swipeX);
  const captures = useVolumetric((s) => s.file?.captures ?? []);
  const ref = useRef<HTMLDivElement>(null);
  if (!swipe) return null;
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!(e.buttons & 1)) return;
    const host = ref.current?.parentElement?.getBoundingClientRect();
    if (host) volumetric.getState().setSwipeX((e.clientX - host.left) / host.width);
  };
  return (
    <>
      <div className="vol-swipe-lbl vol-l">{captures[0]?.label}</div>
      <div className="vol-swipe-lbl vol-r">{captures.at(-1)?.label}</div>
      <div
        ref={ref}
        className="vol-swipe"
        style={{ left: `${(x * 100).toFixed(2)}%` }}
        role="slider"
        aria-label="Swipe between surveys"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(x * 100)}
        tabIndex={0}
        data-testid="vol-swipe"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={onMove}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') volumetric.getState().setSwipeX(x - 0.02);
          else if (e.key === 'ArrowRight') volumetric.getState().setSwipeX(x + 0.02);
        }}
      >
        <span className="knob" aria-hidden>
          <Icon name="split" size={14} />
        </span>
      </div>
    </>
  );
}

function Legend() {
  const surface = useVolumetric((s) => s.surface);
  const body = useVolumetric((s) => s.body);
  const base = useVolumetric((s) => s.file?.bases.find((b) => b.id === s.base)?.label);
  const deadband = useVolumetric((s) => s.file?.deadbandM ?? 0.1);
  const swipe = useVolumetric((s) => s.swipe);
  if (swipe) return null;
  const R = CHANGE_RAMP;
  const rgb = (c: readonly number[]) => `rgb(${c.join(',')})`;
  return (
    <div className="vol-legend overlay-box" aria-label="Legend">
      {surface === 'change' && (
        <>
          <b>Height change</b>
          <div
            className="ramp"
            style={{
              background: `linear-gradient(90deg, ${rgb(R.cutFar)}, ${rgb(R.cutNear)} 45%, ${rgb(R.grey)} 45% 55%, ${rgb(R.fillNear)} 55%, ${rgb(R.fillFar)})`,
            }}
          />
          <div className="ends">
            <span>{`−${String(R.rangeM)} m cut`}</span>
            <span>±{deadband.toFixed(1)}</span>
            <span>+{R.rangeM} m fill</span>
          </div>
        </>
      )}
      {surface === 'elev' && (
        <>
          <b>Elevation</b>
          <div
            className="ramp"
            style={{ background: 'linear-gradient(90deg,#1f6fbf,#3fb56a,#f0e19a,#a8835f,#ffffff)' }}
          />
        </>
      )}
      {body !== 'off' &&
        (surface === 'change' ? (
          <>
            <span className="key">
              <i style={{ background: CUT_CSS }} />
              Material removed
            </span>
            <span className="key">
              <i style={{ background: FILL_CSS }} />
              Material placed
            </span>
          </>
        ) : (
          <>
            <span className="key">
              <i style={{ background: '#ff4d4d' }} />
              Volume above base
            </span>
            <span className="key">
              <i style={{ background: '#e6ebf2' }} />
              {base} base
            </span>
          </>
        ))}
      <span className="key">
        <i className="line" />
        Toe line
      </span>
    </div>
  );
}

function Toast() {
  const message = useVolumetric((s) => s.message);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => {
      volumetric.getState().setMessage(null);
    }, 2600);
    return () => {
      clearTimeout(t);
    };
  }, [message]);
  if (!message) return null;
  return (
    <div className="vol-toast" role="status">
      {message}
    </div>
  );
}

/**
 * The volumetric layer of the 3D stage: draws through `VolumetricScene` and adds the boundary
 * handles, the swipe divider, the section and edit bars, the legend and notices. Mount it inside
 * the 3D pane, over the canvas.
 */
export function VolumetricStage({ stage }: { stage: EngineStage | null }) {
  const ready = useVolumetric((s) => s.status === 'ready');
  const picking = useVolumetric((s) => s.section.mode === 'picking');
  const scene = useMemo(
    () => (stage && ready ? new VolumetricScene(stage, volumetric) : null),
    [stage, ready],
  );

  useEffect(() => {
    if (!scene) return;
    scene.attach();
    return () => {
      scene.detach();
    };
  }, [scene]);

  // Clicks on the stage: section points while picking, and lifted volume bodies select their pile.
  useEffect(() => {
    if (!stage || !scene) return;
    const canvas = stage.renderer.domElement;
    const host = canvas.parentElement;
    if (!host) return;
    let down: { x: number; y: number } | null = null;
    const ray = new Raycaster();
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || stage.tool !== 'select') return;
      const s = volumetric.getState();
      if (s.section.mode === 'picking') {
        e.stopPropagation();
        const p = pickGround(stage, e.clientX, e.clientY);
        if (p) void s.addSectionPoint([p[0], p[1]]);
        return;
      }
      if (s.edit) {
        // the scene selection stays on the pile being edited
        e.stopPropagation();
        return;
      }
      if (s.body !== 'lift') return;
      ray.setFromCamera(new Vector2(...ndcOf(stage, e.clientX, e.clientY)), stage.camera);
      const tops: Object3D[] = [];
      scene.group.traverse((o) => {
        if (o.name === 'body-top' && o.visible) tops.push(o);
      });
      const hit = ray.intersectObjects(tops, false)[0];
      const pile = hit?.object.parent?.userData.pile as string | undefined;
      if (pile) {
        e.stopPropagation();
        s.select(pile);
      }
    };
    // callout plates select on click: not while picking section points or editing a boundary
    const onClick = (e: MouseEvent) => {
      const s = volumetric.getState();
      if (s.section.mode === 'picking' || s.edit) e.stopPropagation();
    };
    host.addEventListener('pointerdown', onDown, true);
    host.addEventListener('pointerup', onUp, true);
    host.addEventListener('click', onClick, true);
    return () => {
      host.removeEventListener('pointerdown', onDown, true);
      host.removeEventListener('pointerup', onUp, true);
      host.removeEventListener('click', onClick, true);
    };
  }, [stage, scene]);

  useEffect(() => {
    if (!stage) return;
    setCursor(stage, picking ? 'crosshair' : '');
    return () => {
      setCursor(stage, '');
    };
  }, [stage, picking]);

  if (!ready) return null;
  return (
    <div className="vol-stage">
      {scene && stage && <Handles scene={scene} stage={stage} />}
      <SwipeDivider />
      <Legend />
      <div className="vol-under">
        <SectionPanel />
        <EditBar />
      </div>
      <Toast />
    </div>
  );
}
