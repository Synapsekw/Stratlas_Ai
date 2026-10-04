import type { BufferAttribute, BufferGeometry, Object3D, Texture } from 'three';

/** What the perf HUD shows; also returned by `EngineStage.perfStats()` for tests. */
export interface PerfStats {
  /** Average over the window. */
  fps: number;
  /** Frame time percentiles over the window (requestAnimationFrame to rAF), ms. */
  p50: number;
  p95: number;
  /** Frames in the window. */
  frames: number;
  /** Points drawn in the last frame (every render call, EDL included). */
  points: number;
  /** Draw calls in the last frame. */
  calls: number;
  triangles: number;
  /** Estimated GPU memory for geometry, textures and render targets, bytes. */
  gpuBytes: number;
  /** CPU time of the last render call, ms. */
  cpuMs: number;
}

interface Drawable extends Object3D {
  geometry?: BufferGeometry;
  material?: unknown;
}

function textureBytes(t: Texture): number {
  const img = t.image as { width?: number; height?: number } | undefined;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  // RGBA8 with a full mip chain (an upper bound for textures without mips)
  return Math.round((w * h * 4 * 4) / 3);
}

function isTexture(v: unknown): v is Texture {
  return typeof v === 'object' && v !== null && (v as { isTexture?: boolean }).isTexture === true;
}

/**
 * Rough GPU memory of everything under `roots`: each geometry buffer and texture counted once.
 * Objects may list offscreen scenes they render (the point-cloud EDL pass) in
 * `userData.offscreen`; those are counted too.
 */
export function estimateGpuBytes(roots: readonly Object3D[]): number {
  const buffers = new Set<ArrayBufferLike | BufferAttribute>();
  const textures = new Set<Texture>();
  let bytes = 0;
  const addArray = (a: {
    array: ArrayLike<number> & { byteLength?: number; buffer?: ArrayBufferLike };
  }) => {
    const arr = a.array;
    const key = arr.buffer ?? (a as BufferAttribute);
    if (buffers.has(key)) return;
    buffers.add(key);
    bytes += arr.byteLength ?? 0;
  };
  const visit = (o: Object3D) => {
    const d = o as Drawable;
    const g = d.geometry;
    if (g?.isBufferGeometry) {
      for (const a of Object.values(g.attributes)) addArray(a);
      if (g.index) addArray(g.index);
    }
    const mats = Array.isArray(d.material) ? (d.material as unknown[]) : [d.material];
    for (const m of mats) {
      if (!m || typeof m !== 'object') continue;
      for (const v of Object.values(m as Record<string, unknown>)) {
        if (isTexture(v) && !textures.has(v)) {
          textures.add(v);
          bytes += textureBytes(v);
        }
      }
      const uniforms = (m as { uniforms?: Record<string, { value?: unknown }> }).uniforms;
      for (const u of Object.values(uniforms ?? {})) {
        if (isTexture(u.value) && !textures.has(u.value)) {
          textures.add(u.value);
          bytes += textureBytes(u.value);
        }
      }
    }
    const off = o.userData.offscreen as Object3D[] | undefined;
    if (Array.isArray(off)) for (const s of off) s.traverse(visit);
  };
  for (const r of roots) r.traverse(visit);
  return bytes;
}

const millions = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} k` : `${n}`;

/** The HUD text: one fact per line, monospace. */
export function formatPerf(s: PerfStats): string {
  return [
    `${s.fps.toFixed(0).padStart(3)} fps   cpu ${s.cpuMs.toFixed(1)} ms`,
    `frame p50 ${s.p50.toFixed(1)} ms   p95 ${s.p95.toFixed(1)} ms`,
    `points ${millions(s.points)}   draws ${s.calls}`,
    `tris ${millions(s.triangles)}   GPU ~${(s.gpuBytes / 2 ** 30).toFixed(2)} GB`,
    'Ctrl+Shift+F to close',
  ].join('\n');
}
