import { getActiveScene, isEngineStage, onActiveScene, type SceneHandle } from '@aio/engine';
import type { Vec3 } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Matrix4,
  Points,
  SRGBColorSpace,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { StoreApi } from 'zustand/vanilla';
import { hitItem, layoutPins, type PinItem, type PinLabel } from './declutter';
import { issuePins, type IssuePin } from './mesh';
import { pinDisplay as defaultDisplay, type PinDisplayState } from './pinDisplay';

/** Screen radius (CSS px) within which pins merge into a count badge. */
const CLUSTER_RADIUS = 26;
const DRAG_PX = 4;
/** Most rows in the list a co-located cluster opens on click. */
const LIST_MAX = 80;

const DISC_VERT = /* glsl */ `
attribute vec3 color;
attribute float size;
attribute float kind;
uniform float uDpr;
varying vec3 vColor;
varying float vKind;
varying float vSize;
void main() {
  vColor = color;
  vKind = kind;
  vSize = size * uDpr;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = vSize;
}`;

// kind: 0 pin, 1 draft pin, 2 selected pin, 3 cluster badge
const DISC_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vKind;
varying float vSize;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  float aa = 2.0 / vSize;
  float alpha = 1.0 - smoothstep(1.0 - aa, 1.0, r);
  if (alpha <= 0.0) discard;
  bool selected = vKind > 1.5 && vKind < 2.5;
  bool cluster = vKind > 2.5;
  float ringAt = cluster ? 0.84 : (selected ? 0.66 : 0.72);
  float ring = smoothstep(ringAt - aa, ringAt, r);
  vec3 ink = selected ? vec3(0.93, 0.95, 0.97) : vec3(0.03, 0.04, 0.05);
  vec3 col = mix(vColor, ink, ring);
  float a = alpha * ((vKind > 0.5 && vKind < 1.5) ? 0.72 : 1.0);
  gl_FragColor = vec4(col, a);
}`;

// World-sized soft splats, pulled towards the camera so the surface under them does not cut
// them; additive, so overlapping issues run from red through orange to yellow-white.
const HEAT_VERT = /* glsl */ `
attribute float weight;
uniform float uRadius;
uniform float uScale;
varying float vWeight;
void main() {
  vWeight = weight;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(-mv.z, 0.001);
  mv.xyz -= normalize(mv.xyz) * min(uRadius, d * 0.5);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(2.0 * uRadius * uScale / max(-mv.z, 0.001), 2.0, 512.0);
}`;

const HEAT_FRAG = /* glsl */ `
varying float vWeight;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float w = exp(-r2 * 3.5) * vWeight;
  gl_FragColor = vec4(vec3(0.95, 0.26, 0.07) * w * 0.16, 1.0);
}`;

const srgb = new Color();
const rgbOf = (css: string): [number, number, number] => {
  srgb.setStyle(css);
  const o = { r: 0, g: 0, b: 0 };
  srgb.getRGB(o, SRGBColorSpace);
  return [o.r, o.g, o.b];
};

/** Growable float buffers for one Points object. */
class PointBuffer {
  readonly geometry = new BufferGeometry();
  private cap = 0;
  constructor(private readonly attrs: Record<string, number>) {
    this.ensure(64);
  }
  ensure(n: number): void {
    if (n <= this.cap) return;
    this.cap = Math.max(n, this.cap * 2);
    for (const [name, size] of Object.entries(this.attrs)) {
      const a = new BufferAttribute(new Float32Array(this.cap * size), size);
      a.setUsage(35048); // DynamicDrawUsage
      this.geometry.setAttribute(name, a);
    }
    this.geometry.setDrawRange(0, 0);
  }
  array(name: string): Float32Array {
    return (this.geometry.getAttribute(name) as BufferAttribute).array as Float32Array;
  }
  commit(n: number): void {
    for (const name of Object.keys(this.attrs)) {
      const a = this.geometry.getAttribute(name) as BufferAttribute;
      a.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, n);
    // positions change every layout: skip three's bounding sphere culling
    this.geometry.boundingSphere = null;
  }
}

const LABEL_CSS = [
  'position:absolute',
  'left:0',
  'top:0',
  'pointer-events:none',
  'white-space:nowrap',
  'will-change:transform',
].join(';');

/** Pooled DOM labels over the canvas: only the labels in view exist. */
class LabelLayer {
  readonly root: HTMLDivElement | null;
  private pool: HTMLDivElement[] = [];
  constructor(host: HTMLElement | null) {
    if (!host || typeof document === 'undefined') {
      this.root = null;
      return;
    }
    const root = document.createElement('div');
    root.className = 'ann-pin-labels';
    root.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:1';
    host.append(root);
    this.root = root;
  }
  render(labels: readonly PinLabel[]): void {
    const root = this.root;
    if (!root) return;
    while (this.pool.length < labels.length) {
      const el = document.createElement('div');
      el.style.cssText = LABEL_CSS;
      root.append(el);
      this.pool.push(el);
    }
    this.pool.forEach((el, i) => {
      const l = labels[i];
      if (!l) {
        if (el.style.display !== 'none') el.style.display = 'none';
        return;
      }
      el.style.display = '';
      if (el.textContent !== l.text) el.textContent = l.text;
      const count = l.kind === 'count';
      el.dataset.kind = l.kind;
      el.style.font = count
        ? '700 11px/1 "IBM Plex Mono", Consolas, monospace'
        : '600 11px/16px "IBM Plex Mono", Consolas, monospace';
      el.style.color = count ? '#0b0d10' : '#eef1f5';
      el.style.padding = count ? '0' : '0 5px 0 6px';
      el.style.background = count ? 'transparent' : 'rgba(14, 17, 22, 0.86)';
      el.style.borderLeft = count ? '0' : `2px solid ${l.color}`;
      el.style.borderRadius = count ? '0' : '2px';
      el.style.transform = count
        ? `translate(${l.x.toFixed(1)}px, ${l.y.toFixed(1)}px) translate(-50%, -50%)`
        : `translate(${l.x.toFixed(1)}px, ${(l.y - 8).toFixed(1)}px)`;
    });
  }
  dispose(): void {
    this.root?.remove();
    this.pool = [];
  }
}

/** A small list of the issues in a cluster that zooming cannot separate. */
function openClusterList(
  host: HTMLElement,
  at: { x: number; y: number },
  pins: readonly IssuePin[],
  pick: (id: string) => void,
): () => void {
  const box = document.createElement('div');
  box.className = 'ann-cluster-list';
  box.setAttribute('role', 'listbox');
  box.setAttribute('aria-label', `${pins.length} issues here`);
  box.style.cssText = [
    'position:absolute',
    `left:${Math.round(at.x + 12)}px`,
    `top:${Math.round(at.y - 12)}px`,
    'z-index:5',
    'max-height:240px',
    'overflow-y:auto',
    'min-width:150px',
    'padding:4px',
    'background:var(--bg-1, #12161c)',
    'border:1px solid var(--line-strong, #39424e)',
    'border-radius:6px',
    'box-shadow:0 12px 32px rgba(0,0,0,.45)',
    'font:500 12px/1 "IBM Plex Mono", Consolas, monospace',
    'color:var(--fg-0, #eef1f5)',
  ].join(';');
  const sorted = [...pins].sort((a, b) => b.rank - a.rank || a.code.localeCompare(b.code));
  for (const p of sorted.slice(0, LIST_MAX)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.setAttribute('role', 'option');
    row.style.cssText =
      'display:flex;align-items:center;gap:8px;width:100%;height:24px;padding:0 6px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left';
    const dot = document.createElement('i');
    dot.style.cssText = `width:8px;height:8px;border-radius:2px;background:${p.color};flex:none`;
    row.append(dot, document.createTextNode(p.code));
    row.onmouseenter = () => {
      row.style.background = 'var(--bg-3, #222a34)';
    };
    row.onmouseleave = () => {
      row.style.background = 'transparent';
    };
    row.onclick = () => {
      pick(p.issueId);
    };
    box.append(row);
  }
  if (pins.length > LIST_MAX) {
    const more = document.createElement('div');
    more.style.cssText = 'padding:6px;color:var(--fg-3, #7d8794)';
    more.textContent = `${pins.length - LIST_MAX} more: zoom in`;
    box.append(more);
  }
  host.append(box);
  const away = (e: PointerEvent) => {
    if (!box.contains(e.target as Node)) close();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  function close() {
    box.remove();
    window.removeEventListener('pointerdown', away, true);
    window.removeEventListener('keydown', esc);
  }
  window.addEventListener('pointerdown', away, true);
  window.addEventListener('keydown', esc);
  return close;
}

const heatWeight = (rank: number, top: number) =>
  rank < 0 ? 0.35 : 0.45 + 0.55 * (top > 1 ? (rank - 1) / (top - 1) : 1);

/**
 * Issue pins in the active scene, built for thousands of issues: one GPU point draw for every
 * pin and cluster badge (severity colour, constant screen size), screen-space clustering
 * with count badges coloured by the worst member, codes only for the selected and hovered
 * pin or while the view is uncrowded (pooled DOM labels, only those in view), the pin filter
 * and an optional severity heat map. A pin click selects its issue; a badge click flies in
 * to separate its pins, or lists them when they share one spot. Follows the active scene
 * through `onActiveScene`. Returns an uninstall function.
 */
export function installIssueOverlay(
  store: StoreApi<Workspace>,
  display: StoreApi<PinDisplayState> = defaultDisplay,
): () => void {
  let detach: (() => void) | null = null;

  const attach = (handle: SceneHandle) => {
    const group = new Group();
    group.name = 'annotate-issue-pins';
    group.renderOrder = 1000;
    handle.scene.add(group);

    const discBuf = new PointBuffer({ position: 3, color: 3, size: 1, kind: 1 });
    const discMat = new ShaderMaterial({
      vertexShader: DISC_VERT,
      fragmentShader: DISC_FRAG,
      uniforms: { uDpr: { value: 1 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const discs = new Points(discBuf.geometry, discMat);
    discs.name = 'annotate-pin-discs';
    discs.frustumCulled = false;
    discs.renderOrder = 1001;
    group.add(discs);

    const heatBuf = new PointBuffer({ position: 3, weight: 1 });
    const heatMat = new ShaderMaterial({
      vertexShader: HEAT_VERT,
      fragmentShader: HEAT_FRAG,
      uniforms: { uRadius: { value: 1 }, uScale: { value: 1 } },
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const heat = new Points(heatBuf.geometry, heatMat);
    heat.name = 'annotate-issue-heat';
    heat.frustumCulled = false;
    heat.renderOrder = 999;
    heat.visible = false;
    group.add(heat);

    const el = handle.renderer.domElement;
    const host = (el as Partial<HTMLElement>).parentElement ?? null;
    const labels = new LabelLayer(host);

    let pins: IssuePin[] = [];
    let items: PinItem[] = [];
    let obstacles: Vector3[] = [];
    let hoverId: string | null = null;
    let dirty = true;
    const lastView = new Matrix4();
    const lastProj = new Matrix4();
    let lastW = 0;
    let lastH = 0;
    let closeList: (() => void) | null = null;

    // component callouts keep their plates off the drawn pins and badges
    const offObstacles = isEngineStage(handle) ? handle.addLabelObstacles(() => obstacles) : null;

    const rebuild = () => {
      const s = store.getState();
      const d = display.getState();
      const sel = s.selection?.kind === 'issue' ? s.selection.id : null;
      const models = s.project?.manifest.severityModels ?? [];
      pins = issuePins(s.issues, models, sel, d.filter);
      // the heat map follows a severity threshold, and still shows with the pins off
      const heatPins = d.heat
        ? issuePins(s.issues, models, null, d.filter === 'off' ? 'all' : d.filter)
        : [];
      heatBuf.ensure(heatPins.length);
      const hp = heatBuf.array('position');
      const hw = heatBuf.array('weight');
      const top = Math.max(1, ...heatPins.map((p) => p.rank));
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      heatPins.forEach((p, i) => {
        for (let k = 0; k < 3; k++) {
          const v = p.p[k] ?? 0;
          hp[i * 3 + k] = v;
          lo[k] = Math.min(lo[k] ?? v, v);
          hi[k] = Math.max(hi[k] ?? v, v);
        }
        hw[i] = heatWeight(p.rank, top);
      });
      heatBuf.commit(heatPins.length);
      const diag = heatPins.length
        ? Math.hypot(
            (hi[0] ?? 0) - (lo[0] ?? 0),
            (hi[1] ?? 0) - (lo[1] ?? 0),
            (hi[2] ?? 0) - (lo[2] ?? 0),
          )
        : 0;
      (heatMat.uniforms.uRadius as { value: number }).value = Math.min(
        60,
        Math.max(0.5, diag / 22),
      );
      heat.visible = d.heat && heatPins.length > 0;
      dirty = true;
      handle.requestRender();
    };

    const v = new Vector3();
    const project = (w: number, h: number) => (p: Vec3) => {
      v.set(p[0], p[1], p[2]).project(handle.camera);
      if (v.z < -1 || v.z > 1) return null;
      const x = (v.x * 0.5 + 0.5) * w;
      const y = (-v.y * 0.5 + 0.5) * h;
      if (x < -40 || y < -40 || x > w + 40 || y > h + 40) return null;
      return { x, y };
    };

    const layout = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      const cam = handle.camera;
      const out = layoutPins({
        pins,
        screen: project(w, h),
        radius: CLUSTER_RADIUS,
        hoverId,
        width: w,
        height: h,
      });
      items = out.items;
      group.userData.layout = out;
      discBuf.ensure(items.length);
      const pos = discBuf.array('position');
      const col = discBuf.array('color');
      const size = discBuf.array('size');
      const kind = discBuf.array('kind');
      items.forEach((it, i) => {
        pos.set(it.world, i * 3);
        col.set(rgbOf(it.color), i * 3);
        size[i] = it.size;
        kind[i] = it.kind === 'cluster' ? 3 : it.selected ? 2 : it.draft ? 1 : 0;
      });
      discBuf.commit(items.length);
      obstacles = items.map((it) => new Vector3(...it.world));
      labels.render(out.labels);
      const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
      (discMat.uniforms.uDpr as { value: number }).value = dpr;
      (heatMat.uniforms.uScale as { value: number }).value =
        (h * dpr) / (2 * Math.tan((cam.fov * Math.PI) / 360));
    };

    const offFrame = handle.onFrame(() => {
      const cam = handle.camera;
      cam.updateMatrixWorld();
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (
        !dirty &&
        w === lastW &&
        h === lastH &&
        lastView.equals(cam.matrixWorldInverse) &&
        cam.projectionMatrix.equals(lastProj)
      ) {
        return;
      }
      dirty = false;
      lastW = w;
      lastH = h;
      lastView.copy(cam.matrixWorldInverse);
      lastProj.copy(cam.projectionMatrix);
      layout();
    });

    const unsub = store.subscribe((s, prev) => {
      if (s.issues !== prev.issues || s.selection !== prev.selection || s.project !== prev.project)
        rebuild();
    });
    const unsubDisplay = display.subscribe(rebuild);

    const local = (e: { clientX: number; clientY: number }) => {
      const r = (el as Partial<HTMLElement>).getBoundingClientRect?.();
      return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: e.clientX, y: e.clientY };
    };

    const expand = (it: PinItem, at: { x: number; y: number }) => {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const m of it.members) {
        for (let k = 0; k < 3; k++) {
          lo[k] = Math.min(lo[k] ?? 0, m.p[k] ?? 0);
          hi[k] = Math.max(hi[k] ?? 0, m.p[k] ?? 0);
        }
      }
      const spread = Math.hypot(
        (hi[0] ?? 0) - (lo[0] ?? 0),
        (hi[1] ?? 0) - (lo[1] ?? 0),
        (hi[2] ?? 0) - (lo[2] ?? 0),
      );
      const distance = Math.max(spread * 1.4, 2);
      const now = v.set(...it.world).distanceTo(handle.camera.position);
      if (spread > 0.05 && now > distance * 1.25) {
        store.getState().flyTo({ kind: 'point', p: it.world, distance });
        return;
      }
      // the pins share one spot: list them instead
      closeList?.();
      if (!host) return;
      closeList = openClusterList(host, at, it.members, (id) => {
        closeList?.();
        closeList = null;
        store.getState().select({ kind: 'issue', id });
      });
    };

    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) {
        down = null;
        return;
      }
      down = null;
      const at = local(e);
      const hit = hitItem(items, at.x, at.y);
      if (!hit) return;
      const first = hit.members[0];
      if (hit.kind === 'pin' && first)
        store.getState().select({ kind: 'issue', id: first.issueId });
      else expand(hit, at);
    };
    let hoverCursor = false;
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return;
      const at = local(e);
      const hit = hitItem(items, at.x, at.y);
      const id = hit?.kind === 'pin' ? (hit.members[0]?.issueId ?? null) : null;
      const style = (el as Partial<HTMLElement>).style;
      if (style) {
        if (hit && (style.cursor === '' || hoverCursor)) {
          style.cursor = 'pointer';
          hoverCursor = true;
        } else if (!hit && hoverCursor) {
          style.cursor = '';
          hoverCursor = false;
        }
        (el as Partial<HTMLElement>).title =
          hit?.kind === 'cluster' ? `${hit.members.length} issues: click to expand` : '';
      }
      if (id !== hoverId) {
        hoverId = id;
        dirty = true;
        handle.requestRender();
      }
    };
    el.addEventListener('pointerdown', onDown as EventListener);
    el.addEventListener('pointerup', onUp as EventListener);
    el.addEventListener('pointermove', onMove as EventListener);
    rebuild();

    detach = () => {
      unsub();
      unsubDisplay();
      offFrame();
      offObstacles?.();
      closeList?.();
      el.removeEventListener('pointerdown', onDown as EventListener);
      el.removeEventListener('pointerup', onUp as EventListener);
      el.removeEventListener('pointermove', onMove as EventListener);
      labels.dispose();
      handle.scene.remove(group);
      discBuf.geometry.dispose();
      heatBuf.geometry.dispose();
      discMat.dispose();
      heatMat.dispose();
      handle.requestRender();
    };
  };

  const off = onActiveScene((h) => {
    detach?.();
    detach = null;
    if (h) attach(h);
  });
  const current = getActiveScene();
  if (current) attach(current);
  return () => {
    off();
    detach?.();
    detach = null;
  };
}
