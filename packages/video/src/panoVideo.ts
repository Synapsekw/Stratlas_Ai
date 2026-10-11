import { azElToDir, type PanoLook } from '@aio/engine';
import {
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  SphereGeometry,
  VideoTexture,
  WebGLRenderer,
  type BufferGeometry,
} from 'three';

/*
 * A look-around view of an equirectangular video: the video is the texture of a sphere seen from
 * its centre. Directions follow the panorama viewer (`panoMath.ts`): the picture centre is local
 * north (-Z), east (+X) is to its right, yaw turns clockwise, pitch is up from the horizon. The
 * view draws only when something changed (a new video frame, the look, the size).
 */

/** The sphere the video is drawn on, seen from inside, the picture centre along -Z. */
export function panoSphereGeometry(): BufferGeometry {
  const g = new SphereGeometry(10, 64, 32);
  // mirror so the faces look inward and the picture is not reversed, then turn its centre north
  g.scale(-1, 1, 1);
  g.rotateY(-Math.PI / 2);
  return g;
}

/** The point (unit direction) the camera looks at for a look state. */
export function lookTarget(look: PanoLook): [number, number, number] {
  return azElToDir(look.yawDeg, look.pitchDeg);
}

export interface PanoVideoView {
  readonly canvas: HTMLCanvasElement;
  setLook(look: PanoLook): void;
  /** Draw on the next animation frame (after a seek, a new frame, a resize). */
  invalidate(): void;
  dispose(): void;
}

/**
 * Mount the view in `host` (it fills it) and draw `video` on the sphere. Throws when WebGL is not
 * available; the caller shows that as an error instead of the view.
 */
export function createPanoVideoView(
  host: HTMLElement,
  video: HTMLVideoElement,
  look: PanoLook,
): PanoVideoView {
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%' });
  host.appendChild(canvas);

  const texture = new VideoTexture(video);
  texture.colorSpace = SRGBColorSpace;
  const geometry = panoSphereGeometry();
  const material = new MeshBasicMaterial({ map: texture, toneMapped: false });
  const scene = new Scene();
  scene.add(new Mesh(geometry, material));
  const camera = new PerspectiveCamera(look.fovDeg, 2, 0.1, 100);

  let current = look;
  let handle = 0;
  let disposed = false;

  const draw = () => {
    handle = 0;
    if (disposed) return;
    const [x, y, z] = lookTarget(current);
    camera.fov = current.fovDeg;
    camera.updateProjectionMatrix();
    camera.lookAt(x, y, z);
    renderer.render(scene, camera);
    // while it plays, every screen frame may bring a new picture
    if (!video.paused && !video.ended) invalidate();
  };
  function invalidate() {
    if (!disposed && handle === 0) handle = requestAnimationFrame(draw);
  }

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

  // a frame that arrives while the video is paused (first frame, a seek) is a new picture too
  const frame = () => {
    texture.needsUpdate = true;
    invalidate();
  };
  const events = ['loadeddata', 'seeked', 'timeupdate'] as const;
  for (const e of events) video.addEventListener(e, frame);
  video.addEventListener('play', invalidate);

  return {
    canvas,
    setLook(next) {
      current = next;
      invalidate();
    },
    invalidate,
    dispose() {
      disposed = true;
      if (handle) cancelAnimationFrame(handle);
      observer.disconnect();
      for (const e of events) video.removeEventListener(e, frame);
      video.removeEventListener('play', invalidate);
      texture.dispose();
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
