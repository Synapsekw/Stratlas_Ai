import type { Layer, PanoRef } from '@aio/schema';
import { workspace as appWorkspace, type Workspace } from '@aio/workspace';
import type { Quaternion } from 'three';
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LinearFilter,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  Raycaster,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  TextureLoader,
  Vector2,
  Vector3,
  type Texture,
} from 'three';
import type { StoreApi } from 'zustand/vanilla';
import { FONT_MONO, FONT_UI, PALETTE } from '../palette';
import { isEngineStage } from '../registry';
import { MARKER_GLYPH, markerTexture } from './marker';
import type { AdapterContext, LayerAdapter, LayerHandle, SavedView } from '../types';
import {
  FULL_SPHERE,
  azElToDir,
  coverageFromImage,
  coverageLabel,
  dragLook,
  parsePanoIndex,
  startLook,
  zoomLook,
  type PanoCoverage,
  type PanoLook,
} from './panoMath';

type PanoLayer = Extract<Layer, { kind: 'panoramas' }>;

const CLICK_SLOP_PX = 5;
/** Marker size as a share of the viewport height (sprites without size attenuation). */
const MARKER = 0.034;
const MARKER_HOVER = 0.042;
/** Radius of the panorama sphere around the camera, metres (inside the camera's near/far). */
const SPHERE_R = 50;
/** Camera layer the immersive view renders alone, so the scene behind the sphere costs nothing. */
const PANO_LAYER = 31;
const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** Same mapping as panoUv (panoMath.ts): azimuth clockwise from -Z, image centre at `heading`. */
const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform float hasMap;
uniform float heading;
uniform float hspan;
uniform float vtop;
uniform float vbot;
uniform vec3 backdrop;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float az = degrees(atan(d.x, -d.z));
  float el = degrees(asin(clamp(d.y, -1.0, 1.0)));
  float da = mod(az - heading + 540.0, 360.0) - 180.0;
  vec2 uv = vec2(0.5 + da / hspan, (el + vbot) / (vtop + vbot));
  if (hasMap < 0.5 || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    gl_FragColor = vec4(backdrop, 1.0);
  } else {
    gl_FragColor = vec4(texture2D(map, uv).rgb, 1.0);
  }
  #include <colorspace_fragment>
}
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Style,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e.style, style);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** CSS properties (camelCase) of the HUD plates. */
type Style = Record<string, string>;

const PLATE: Style = {
  background: `var(--scrim, ${PALETTE.plateCss})`,
  border: `1px solid var(--line-strong, ${PALETTE.ovFaintCss})`,
  borderRadius: '4px',
  color: `var(--ov, ${PALETTE.ovCss})`,
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
};

/**
 * Top inset (px) that keeps the HUD clear of the app's UI over the stage (toolbars, status pills):
 * below every keep-out rect that starts in the top third of the stage.
 */
export function hudTopInset(
  host: { top: number; height: number },
  rects: Iterable<{ top: number; bottom: number }>,
): number {
  let inset = 12;
  for (const r of rects) {
    if (r.bottom <= r.top || r.top - host.top > host.height / 3) continue;
    inset = Math.max(inset, r.bottom - host.top + 8);
  }
  return Math.round(inset);
}

/** The immersive view's HTML layer: back button, title with hint, heading readout. */
class PanoHud {
  readonly root: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly title: HTMLSpanElement;
  private readonly sub: HTMLSpanElement;
  private readonly hint: HTMLDivElement;
  private readonly heading: HTMLDivElement;

  constructor(host: HTMLElement, onBack: () => void) {
    this.root = el('div', {
      position: 'absolute',
      inset: '0',
      zIndex: '5',
      cursor: 'grab',
      touchAction: 'none',
      userSelect: 'none',
      font: `400 12px ${FONT_UI}`,
    });
    this.root.className = 'aio-pano-hud';
    this.root.setAttribute('role', 'application');
    this.root.setAttribute(
      'aria-label',
      'Panorama. Drag to look around, scroll to zoom, Esc to return',
    );
    this.root.tabIndex = -1;

    this.bar = el('div', {
      position: 'absolute',
      top: '12px',
      left: '12px',
      right: '12px',
      display: 'flex',
      alignItems: 'flex-start',
      gap: '8px',
      pointerEvents: 'none',
    });

    const back = el('button', {
      ...PLATE,
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      height: '32px',
      padding: '0 10px 0 8px',
      font: `500 13px ${FONT_UI}`,
      cursor: 'pointer',
      pointerEvents: 'auto',
    });
    back.type = 'button';
    back.dataset.testid = 'pano-back';
    back.setAttribute('aria-label', 'Back to the 3D view (Esc)');
    back.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    back.append(document.createTextNode('Back to 3D'));
    back.append(
      el(
        'span',
        {
          font: `500 11px ${FONT_MONO}`,
          color: PALETTE.ovDimCss,
          border: `1px solid ${PALETTE.ovFaintCss}`,
          borderRadius: '2px',
          padding: '0 4px',
          marginLeft: '2px',
        },
        'Esc',
      ),
    );
    back.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
    });
    back.addEventListener('click', (e) => {
      e.stopPropagation();
      onBack();
    });

    const plate = el('div', {
      ...PLATE,
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      padding: '5px 12px 6px',
      minWidth: '0',
    });
    const row = el('div', { display: 'flex', alignItems: 'baseline', gap: '10px' });
    const caps = el(
      'span',
      {
        font: `600 11px ${FONT_MONO}`,
        letterSpacing: '0.08em',
        color: `var(--acc, ${PALETTE.accCss})`,
      },
      'PANORAMA',
    );
    this.title = el('span', { font: `600 13px ${FONT_MONO}` });
    this.sub = el('span', { font: `400 12px ${FONT_UI}`, color: PALETTE.ovDimCss });
    row.append(caps, this.title, this.sub);
    this.hint = el('div', { font: `400 11px ${FONT_UI}`, color: PALETTE.ovDimCss });
    plate.append(row, this.hint);

    this.heading = el('div', {
      ...PLATE,
      marginLeft: 'auto',
      height: '32px',
      display: 'flex',
      alignItems: 'center',
      padding: '0 10px',
      font: `500 12px ${FONT_MONO}`,
    });
    this.bar.append(back, plate, this.heading);
    this.root.append(this.bar);
    host.appendChild(this.root);
  }

  /** Keep the top row below the app's own UI over the stage. */
  setTopInset(px: number): void {
    this.bar.style.top = `${px}px`;
  }

  set(title: string, sub: string): void {
    this.title.textContent = title;
    this.sub.textContent = sub;
  }

  setHint(text: string): void {
    this.hint.textContent = text;
  }

  setLook(look: PanoLook): void {
    const hdg = String(Math.round(look.yawDeg) % 360).padStart(3, '0');
    const pitch = Math.round(look.pitchDeg);
    this.heading.textContent = `HDG ${hdg}°  PITCH ${pitch > 0 ? '+' : ''}${pitch}°  FOV ${Math.round(look.fovDeg)}°`;
  }

  dispose(): void {
    this.root.remove();
  }
}

interface Saved {
  view: SavedView | null;
  position: Vector3;
  quaternion: Quaternion;
  target: Vector3 | null;
  fov: number;
  layers: number;
  controls: {
    enabled: boolean;
    minDistance: number;
    maxDistance: number;
    minPolarAngle: number;
    maxPolarAngle: number;
  } | null;
  hidden: { el: HTMLElement; visibility: string }[];
}

/**
 * `panoramas` layers: every panorama as a small marker at its position with a stem to the ground.
 * Clicking a marker selects it (`{ kind: 'pano', id, layer }`) and enters the immersive view: the
 * camera stands at the panorama's position inside a sphere textured with it (equirectangular, or
 * the covered part of a wide panorama, from `panoramas/panoramas.json`), drag to look, wheel to
 * zoom, Esc or the back button to return to the previous camera.
 */
export function createPanoramasAdapter(
  store: StoreApi<Workspace> = appWorkspace,
): LayerAdapter<'panoramas'> {
  return {
    kind: 'panoramas',
    async create(layer: PanoLayer, ctx: AdapterContext): Promise<LayerHandle> {
      const scene = ctx.scene;
      const items = layer.items;
      const coverage = await loadCoverage(ctx);
      const group = new Group();
      group.name = `panoramas:${layer.id}`;
      group.userData.aioLayer = layer.id;

      // markers and stems
      const texOff = markerTexture(MARKER_GLYPH.pano, false);
      const texOn = markerTexture(MARKER_GLYPH.pano, true);
      const sprites: Sprite[] = [];
      const stemPos = new Float32Array(items.length * 6);
      items.forEach((p, i) => {
        const mat = new SpriteMaterial({
          map: texOff,
          color: texOff ? 0xffffff : PALETTE.hover,
          depthTest: false,
          depthWrite: false,
          sizeAttenuation: false,
          transparent: true,
        });
        const s = new Sprite(mat);
        s.position.set(...p.pos);
        s.scale.set(MARKER, MARKER, 1);
        s.renderOrder = 30;
        s.userData.panoIndex = i;
        s.name = `pano:${p.id}`;
        sprites.push(s);
        stemPos.set([...p.pos, p.pos[0], Math.min(0, p.pos[1]), p.pos[2]], i * 6);
      });
      const stemGeo = new BufferGeometry();
      stemGeo.setAttribute('position', new BufferAttribute(stemPos, 3));
      stemGeo.computeBoundingSphere();
      const stemMat = new LineBasicMaterial({
        color: PALETTE.hover,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
      const stems = new LineSegments(stemGeo, stemMat);
      stems.renderOrder = 3;
      group.add(stems, ...sprites);
      scene.scene.add(group);
      group.updateMatrixWorld(true);

      let hovered = -1;
      let selected = -1;
      const paintMarker = (i: number) => {
        const s = sprites[i];
        if (!s) return;
        const on = i === hovered || i === selected;
        s.material.map = on ? texOn : texOff;
        s.material.color.set(texOff ? 0xffffff : on ? PALETTE.acc : PALETTE.hover);
        const k = i === hovered ? MARKER_HOVER : MARKER;
        s.scale.set(k, k, 1);
      };
      const setHovered = (i: number) => {
        if (i === hovered) return;
        const was = hovered;
        hovered = i;
        paintMarker(was);
        paintMarker(i);
        scene.requestRender();
      };
      const paintSelection = () => {
        const s = store.getState().selection;
        const i =
          s?.kind === 'pano' && (s.layer === undefined || s.layer === layer.id)
            ? items.findIndex((p) => p.id === s.id)
            : -1;
        if (i === selected) return;
        const was = selected;
        selected = i;
        paintMarker(was);
        paintMarker(i);
        scene.requestRender();
      };
      paintSelection();

      // picking: the nearest marker under the pointer (markers draw over everything)
      const canvas = scene.renderer.domElement;
      const rc = new Raycaster();
      const ndc = (e: PointerEvent | MouseEvent): Vector2 => {
        const r = canvas.getBoundingClientRect();
        return new Vector2(
          ((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1,
        );
      };
      const pick = (e: PointerEvent | MouseEvent): number => {
        if (!group.visible || immersed) return -1;
        rc.setFromCamera(ndc(e), scene.camera);
        const hit = rc.intersectObjects(sprites, false)[0];
        const i = hit?.object.userData.panoIndex as number | undefined;
        return i ?? -1;
      };
      let down: { x: number; y: number } | null = null;
      let hoverRaf = 0;
      let hoverEvent: PointerEvent | null = null;
      const onDown = (e: PointerEvent) => {
        down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
      };
      const onUp = (e: PointerEvent) => {
        const d = down;
        down = null;
        if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) return;
        const i = pick(e);
        const p = items[i];
        if (!p) return;
        store.getState().select({ kind: 'pano', id: p.id, layer: layer.id });
        enter(i);
      };
      const onMove = (e: PointerEvent) => {
        if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
        hoverEvent = e;
        if (hoverRaf) return;
        // after the stage's own hover frame, so the marker cursor wins
        hoverRaf = requestAnimationFrame(() => {
          hoverRaf = 0;
          const ev = hoverEvent;
          if (!ev) return;
          const i = pick(ev);
          setHovered(i);
          if (i >= 0) canvas.style.cursor = 'pointer';
        });
      };
      const onLeave = () => {
        hoverEvent = null;
        setHovered(-1);
      };
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerleave', onLeave);

      // immersive view ---------------------------------------------------------------------------
      const uniforms = {
        map: { value: null as Texture | null },
        hasMap: { value: 0 },
        heading: { value: 0 },
        hspan: { value: 360 },
        vtop: { value: 90 },
        vbot: { value: 90 },
        backdrop: { value: new Color(PALETTE.bg0) },
      };
      const sphereMat = new ShaderMaterial({
        uniforms,
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        side: BackSide,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        toneMapped: false,
      });
      const sphereGeo = new SphereGeometry(SPHERE_R, 96, 48);
      const sphere = new Mesh(sphereGeo, sphereMat);
      sphere.name = `panorama-sphere:${layer.id}`;
      sphere.frustumCulled = false;
      sphere.renderOrder = 1e6;
      sphere.layers.set(PANO_LAYER);
      sphere.visible = false;

      let immersed = false;
      let current = -1;
      let look: PanoLook = { yawDeg: 0, pitchDeg: 0, fovDeg: 70 };
      let saved: Saved | null = null;
      let hud: PanoHud | null = null;
      let loadToken = 0;
      let drag: { x: number; y: number; look: PanoLook } | null = null;
      let unFrame: (() => void) | null = null;
      const center = new Vector3();
      const dirV = new Vector3();

      /** Camera at the panorama centre, looking along `look` (no redraw request). */
      const pin = () => {
        const cam = scene.camera;
        cam.position.copy(center);
        const [dx, dy, dz] = azElToDir(look.yawDeg, look.pitchDeg);
        dirV.set(dx, dy, dz);
        // keep the orbit target one metre ahead, so the stage's controls agree with the view
        if (isEngineStage(scene)) scene.controls.target.copy(center).add(dirV);
        cam.up.set(0, 1, 0);
        cam.lookAt(center.x + dx, center.y + dy, center.z + dz);
        if (cam.fov !== look.fovDeg) {
          cam.fov = look.fovDeg;
          cam.updateProjectionMatrix();
        }
        sphere.position.copy(center);
        sphere.updateMatrixWorld(true);
      };
      const applyLook = () => {
        pin();
        hud?.setLook(look);
        scene.requestRender();
      };

      const coverageOf = (p: PanoRef): PanoCoverage => coverage.get(p.id) ?? FULL_SPHERE;

      const loadPano = (p: PanoRef) => {
        const token = ++loadToken;
        uniforms.hasMap.value = 0;
        hud?.setHint('Loading panorama');
        new TextureLoader().load(
          ctx.url(p.src),
          (tex) => {
            if (token !== loadToken || !immersed) {
              tex.dispose();
              return;
            }
            tex.colorSpace = SRGBColorSpace;
            tex.generateMipmaps = false;
            tex.minFilter = LinearFilter;
            if (!coverage.has(p.id)) {
              const img = tex.image as { width?: number; height?: number } | undefined;
              const cov = coverageFromImage(img?.width ?? 0, img?.height ?? 0);
              uniforms.hspan.value = cov.hspanDeg;
              uniforms.vtop.value = cov.vtopDeg;
              uniforms.vbot.value = cov.vbotDeg;
            }
            uniforms.map.value?.dispose();
            uniforms.map.value = tex;
            uniforms.hasMap.value = 1;
            hud?.setHint('Drag to look around · scroll to zoom · Esc to return');
            scene.requestRender();
          },
          undefined,
          () => {
            if (token === loadToken) hud?.setHint('The panorama image could not be loaded');
          },
        );
      };

      const show = (i: number) => {
        const p = items[i];
        if (!p) return;
        current = i;
        const cov = coverageOf(p);
        center.set(...p.pos);
        uniforms.heading.value = p.headingDeg;
        uniforms.hspan.value = cov.hspanDeg;
        uniforms.vtop.value = cov.vtopDeg;
        uniforms.vbot.value = cov.vbotDeg;
        look = startLook(p.headingDeg, cov);
        hud?.set(p.id, coverageLabel(cov));
        loadPano(p);
        applyLook();
      };

      const onKey = (e: KeyboardEvent) => {
        if (!immersed) return;
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          leave();
          return;
        }
        const step: Record<string, [number, number]> = {
          ArrowLeft: [-5, 0],
          ArrowRight: [5, 0],
          ArrowUp: [0, 5],
          ArrowDown: [0, -5],
        };
        const s = step[e.key];
        if (s) {
          e.preventDefault();
          look = {
            ...look,
            yawDeg: (((look.yawDeg + s[0]) % 360) + 360) % 360,
            pitchDeg: Math.max(-89, Math.min(89, look.pitchDeg + s[1])),
          };
          applyLook();
        } else if (e.key === '+' || e.key === '=' || e.key === '-') {
          look = zoomLook(look, e.key === '-' ? 1 : -1);
          applyLook();
        }
      };

      const hudDown = (e: PointerEvent) => {
        if (e.button !== 0 || !hud) return;
        hud.root.setPointerCapture(e.pointerId);
        hud.root.style.cursor = 'grabbing';
        drag = { x: e.clientX, y: e.clientY, look };
      };
      const hudMove = (e: PointerEvent) => {
        if (!drag || !hud) return;
        look = dragLook(drag.look, e.clientX - drag.x, e.clientY - drag.y, hud.root.clientHeight);
        applyLook();
      };
      const hudUp = (e: PointerEvent) => {
        if (!hud) return;
        if (hud.root.hasPointerCapture(e.pointerId)) hud.root.releasePointerCapture(e.pointerId);
        hud.root.style.cursor = 'grab';
        drag = null;
      };
      const hudWheel = (e: WheelEvent) => {
        e.preventDefault();
        look = zoomLook(look, e.deltaY);
        applyLook();
      };

      const enter = (i: number) => {
        if (!items[i]) return;
        if (immersed) {
          show(i);
          return;
        }
        const host = canvas.parentElement;
        const stage = isEngineStage(scene) ? scene : null;
        const c = stage?.controls;
        saved = {
          view: stage ? stage.saveView() : null,
          position: scene.camera.position.clone(),
          quaternion: scene.camera.quaternion.clone(),
          target: c ? c.target.clone() : null,
          fov: scene.camera.fov,
          layers: scene.camera.layers.mask,
          controls: c
            ? {
                enabled: c.enabled,
                minDistance: c.minDistance,
                maxDistance: c.maxDistance,
                minPolarAngle: c.minPolarAngle,
                maxPolarAngle: c.maxPolarAngle,
              }
            : null,
          hidden: [],
        };
        // stop any camera flight and load-time framing before taking the camera over
        if (stage && saved.view) stage.restoreView(saved.view);
        if (c) {
          c.enabled = false;
          c.minDistance = 0;
          c.maxDistance = Infinity;
          c.minPolarAngle = 0;
          c.maxPolarAngle = Math.PI;
        }
        if (host) {
          // callouts and compass belong to the 3D view
          for (const child of Array.from(host.children)) {
            if (child === canvas || !(child instanceof HTMLElement)) continue;
            saved.hidden.push({ el: child, visibility: child.style.visibility });
            child.style.visibility = 'hidden';
          }
          hud = new PanoHud(host, leave);
          const hb = host.getBoundingClientRect();
          hud.setTopInset(hudTopInset(hb, stage ? stage.uiKeepOut() : []));
          hud.root.addEventListener('pointerdown', hudDown);
          hud.root.addEventListener('pointermove', hudMove);
          hud.root.addEventListener('pointerup', hudUp);
          hud.root.addEventListener('pointercancel', hudUp);
          hud.root.addEventListener('wheel', hudWheel, { passive: false });
          hud.root.focus({ preventScroll: true });
        }
        setHovered(-1);
        immersed = true;
        scene.scene.add(sphere);
        sphere.visible = true;
        scene.camera.layers.set(PANO_LAYER);
        window.addEventListener('keydown', onKey, true);
        // the stage's controls and flights move the camera each frame; pin it to the panorama
        unFrame = scene.onFrame(() => {
          if (immersed) pin();
        });
        show(i);
      };

      function leave() {
        if (!immersed) return;
        immersed = false;
        loadToken++;
        drag = null;
        unFrame?.();
        unFrame = null;
        window.removeEventListener('keydown', onKey, true);
        sphere.visible = false;
        scene.scene.remove(sphere);
        uniforms.map.value?.dispose();
        uniforms.map.value = null;
        uniforms.hasMap.value = 0;
        hud?.dispose();
        hud = null;
        const s = saved;
        saved = null;
        current = -1;
        const cam = scene.camera;
        if (s) {
          cam.layers.mask = s.layers;
          cam.fov = s.fov;
          cam.updateProjectionMatrix();
          for (const h of s.hidden) h.el.style.visibility = h.visibility;
          if (isEngineStage(scene)) {
            const c = scene.controls;
            if (s.controls) Object.assign(c, s.controls);
            if (s.view) scene.restoreView(s.view);
          } else {
            cam.position.copy(s.position);
            cam.quaternion.copy(s.quaternion);
            cam.updateMatrixWorld();
          }
        }
        scene.requestRender();
      }

      const unsub = store.subscribe((s, prev) => {
        if (s.selection === prev.selection) return;
        paintSelection();
        if (!immersed) return;
        const sel = s.selection;
        const i =
          sel?.kind === 'pano' && (sel.layer === undefined || sel.layer === layer.id)
            ? items.findIndex((p) => p.id === sel.id)
            : -1;
        if (i < 0) leave();
        else if (i !== current) show(i);
      });

      scene.requestRender();
      return {
        setVisible(visible: boolean) {
          group.visible = visible;
          if (!visible) {
            setHovered(-1);
            leave();
          }
          scene.requestRender();
        },
        dispose() {
          leave();
          unsub();
          if (hoverRaf) cancelAnimationFrame(hoverRaf);
          canvas.removeEventListener('pointerdown', onDown);
          canvas.removeEventListener('pointerup', onUp);
          canvas.removeEventListener('pointermove', onMove);
          canvas.removeEventListener('pointerleave', onLeave);
          scene.scene.remove(group);
          for (const s of sprites) s.material.dispose();
          texOff?.dispose();
          texOn?.dispose();
          stemGeo.dispose();
          stemMat.dispose();
          sphereGeo.dispose();
          sphereMat.dispose();
          scene.requestRender();
        },
      };
    },
  };
}

/** Partial coverage from `panoramas/panoramas.json`, when the project has one. */
async function loadCoverage(ctx: AdapterContext): Promise<Map<string, PanoCoverage>> {
  try {
    const res = await fetch(ctx.url({ path: 'panoramas/panoramas.json' }));
    if (!res.ok) return new Map();
    return parsePanoIndex(await res.json());
  } catch {
    return new Map();
  }
}

export const panoramasAdapter = createPanoramasAdapter();
