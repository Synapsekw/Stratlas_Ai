import { open, readFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';

/**
 * The pictures the models of one pick use. An OBJ names its material file (`mtllib`), and the
 * material file its texture pictures (`map_Kd` and the other `map_` lines, `bump`, `disp`,
 * `decal`). Picked together with the model, such a PNG is part of the model and must not be filed
 * as a drawing: nothing removes a drawing again.
 */
export interface ModelTextures {
  /** Whether `file` is a texture of a model in the pick. */
  has(file: string): boolean;
  /** The model or material file that names it. */
  modelOf(file: string): string | undefined;
}

/** One name for a file however its path is spelled (Windows and macOS ignore case). */
const key = (file: string) => resolve(file).toLowerCase();

const TEXTURE_LINE = /^\s*(?:map_\w+|bump|disp|decal|refl)\s+(.+?)\s*$/gim;

/** The texture files a material file names, as written (the last word of each texture line). */
export function mtlTextures(mtl: string): string[] {
  const out: string[] = [];
  for (const m of mtl.matchAll(TEXTURE_LINE)) {
    // options come first (`-bm 0.5`, `-s 1 1 1`); the file is the last word
    const file = (m[1] ?? '').split(/\s+/).pop();
    if (file) out.push(file);
  }
  return out;
}

/** The start of a file as text: `mtllib` stands at the top of an OBJ, before its vertices. */
async function head(file: string, bytes: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const b = new Uint8Array(bytes);
    const r = await fh.read(b, 0, bytes, 0);
    return new TextDecoder().decode(b.subarray(0, r.bytesRead));
  } finally {
    await fh.close();
  }
}

/**
 * The textures of the OBJ models and the material files among `paths`. Files that cannot be read
 * name nothing; the import itself reports them.
 */
export async function modelTextures(paths: readonly string[]): Promise<ModelTextures> {
  const owner = new Map<string, string>();
  /** Material files to read, each with the file that led to it. */
  const mtls = new Map<string, { file: string; from: string }>();
  for (const p of paths) {
    const ext = extname(p).toLowerCase();
    if (ext === '.mtl') mtls.set(key(p), { file: p, from: basename(p) });
    if (ext !== '.obj') continue;
    try {
      const text = await head(p, 64 * 1024);
      for (const m of text.matchAll(/^mtllib\s+(.+?)\s*$/gm)) {
        const file = resolve(dirname(p), m[1] ?? '');
        mtls.set(key(file), { file, from: basename(p) });
      }
    } catch {
      // unreadable: the model import says so
    }
  }
  for (const { file, from } of mtls.values()) {
    try {
      const text = await readFile(file, 'utf8');
      for (const t of mtlTextures(text)) owner.set(key(resolve(dirname(file), t)), from);
    } catch {
      // a material file that is not there names nothing
    }
  }
  return {
    has: (file) => owner.has(key(file)),
    modelOf: (file) => owner.get(key(file)),
  };
}
