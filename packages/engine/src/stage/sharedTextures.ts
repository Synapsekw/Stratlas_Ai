import type { Material, Object3D, Texture, WebGLRenderer } from 'three';

/** Uniforms three fills with a texture it keeps once for every renderer (module level). */
const MODULE_UNIFORMS = ['dfgLUT'] as const;

/** Every such texture seen so far: they live as long as three's module, so keeping them costs nothing. */
const seen = new Set<Texture>();

type Uniforms = Partial<Record<string, { value?: unknown }>>;

const isTexture = (v: unknown): v is Texture =>
  typeof v === 'object' && v !== null && (v as { isTexture?: unknown }).isTexture === true;

/**
 * Textures three shares between every WebGLRenderer at module level that this renderer drew the
 * scene with: the DFG LUT of physically based materials (three r186 `getDFGLUT`), found through
 * the uniforms the renderer gave the scene's materials (and those found before, by any renderer).
 *
 * Each renderer that uploads such a texture adds a `dispose` listener to it, and
 * `WebGLRenderer.dispose()` leaves that listener in place: the module-level texture then keeps
 * every renderer that ever drew alive, with its programs, its canvas and its WebGL context (one
 * per project opened, T8 soak). Disposing the texture after the renderer runs those listeners,
 * which take themselves off; a renderer still in use (the second view while comparing dates)
 * uploads the texture again on its next frame.
 */
export function moduleTextures(renderer: WebGLRenderer, scene: Object3D): Texture[] {
  const props = (renderer as Partial<WebGLRenderer>).properties;
  if (!props) return [...seen];
  scene.traverse((o) => {
    const m = (o as { material?: Material | Material[] }).material;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      if (!props.has(mat)) continue;
      const uniforms = (props.get(mat) as { uniforms?: Uniforms } | undefined)?.uniforms;
      for (const name of MODULE_UNIFORMS) {
        const v = uniforms?.[name]?.value;
        if (isTexture(v)) seen.add(v);
      }
    }
  });
  // also those seen with other renderers: this one may have drawn with them before its scene changed
  return [...seen];
}
