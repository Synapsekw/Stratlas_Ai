import {
  PANO_SPHERE_R,
  azElToDir,
  coverageFromImage,
  panoSphereMaterial,
  type PanoCoverage,
  type PanoLook,
} from '@aio/engine';
import {
  Color,
  LinearFilter,
  Mesh,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  TextureLoader,
  WebGLRenderer,
} from 'three';

/*
 * A still panorama seen from its centre, for the split's Panoramas pane: one sphere with the
 * engine's panorama shader (partial coverage, image centre at the panorama's heading), one camera,
 * drawn only when something changed (the image, the look, the size), as the walk player.
 */

export type PanoViewStatus = 'loading' | 'ready' | 'missing';

export interface PanoImageView {
  /** Show the image at `url` (null: the backdrop only); `cov` null reads it from the image size. */
  setImage(url: string | null, headingDeg: number, cov: PanoCoverage | null): void;
  setLook(look: PanoLook): void;
  dispose(): void;
  readonly status: PanoViewStatus;
}

const FALLBACK_BACKDROP = 0x05080d;

/** The `--bg-1` panel colour as sRGB, through a canvas (the token is written in oklch). */
function backdrop(): Color {
  const out = new Color(FALLBACK_BACKDROP);
  try {
    const css = getComputedStyle(document.documentElement).getPropertyValue('--bg-1').trim();
    if (!css) return out;
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return out;
    ctx.fillStyle = `#${FALLBACK_BACKDROP.toString(16).padStart(6, '0')}`;
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
    return out.setRGB(r / 255, g / 255, b / 255, SRGBColorSpace);
  } catch {
    return out;
  }
}

/** Mount the view in `host` (it fills it). Throws when WebGL is not available. */
export function createPanoImageView(
  host: HTMLElement,
  look: PanoLook,
  onStatus: (s: PanoViewStatus) => void,
): PanoImageView {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%' });
  host.appendChild(canvas);

  const geometry = new SphereGeometry(PANO_SPHERE_R, 64, 32);
  const sphere = panoSphereMaterial(backdrop());
  const scene = new Scene();
  scene.add(new Mesh(geometry, sphere.material));
  const camera = new PerspectiveCamera(look.fovDeg, 2, 0.1, PANO_SPHERE_R * 4);

  let current = look;
  let status: PanoViewStatus = 'ready';
  let url: string | null = null;
  let token = 0;
  let handle = 0;
  let disposed = false;

  const report = (s: PanoViewStatus) => {
    status = s;
    onStatus(s);
  };
  const draw = () => {
    handle = 0;
    if (disposed) return;
    const [x, y, z] = azElToDir(current.yawDeg, current.pitchDeg);
    camera.fov = current.fovDeg;
    camera.updateProjectionMatrix();
    camera.lookAt(x, y, z);
    renderer.render(scene, camera);
  };
  const invalidate = () => {
    if (!disposed && handle === 0) handle = requestAnimationFrame(draw);
  };

  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    invalidate();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  return {
    get status() {
      return status;
    },
    setImage(next, headingDeg, cov) {
      if (cov) sphere.setFrame(headingDeg, cov);
      if (next === url) {
        invalidate();
        return;
      }
      url = next;
      const mine = ++token;
      sphere.setImage(null);
      invalidate();
      if (next === null) {
        report('ready');
        return;
      }
      report('loading');
      new TextureLoader().load(
        next,
        (tex) => {
          if (disposed || mine !== token) {
            tex.dispose();
            return;
          }
          tex.colorSpace = SRGBColorSpace;
          tex.generateMipmaps = false;
          tex.minFilter = LinearFilter;
          tex.magFilter = LinearFilter;
          if (!cov) {
            const img = tex.image as { width?: number; height?: number } | undefined;
            sphere.setFrame(headingDeg, coverageFromImage(img?.width ?? 0, img?.height ?? 0));
          }
          sphere.setImage(tex);
          report('ready');
          invalidate();
        },
        undefined,
        () => {
          if (!disposed && mine === token) report('missing');
        },
      );
    },
    setLook(next) {
      current = next;
      invalidate();
    },
    dispose() {
      disposed = true;
      token++;
      if (handle) cancelAnimationFrame(handle);
      observer.disconnect();
      sphere.setImage(null);
      geometry.dispose();
      sphere.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
