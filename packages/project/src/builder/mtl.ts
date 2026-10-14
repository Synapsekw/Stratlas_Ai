/**
 * Texture statements of a Wavefront material file (`map_Kd`, `map_Bump`, `bump`, `disp`, ...):
 * options first, then the file name, which may hold spaces (Pix4D writes
 * `map_Kd <project name>_texture.jpg`).
 */

/** Options and how many values each takes; `-o`, `-s` and `-t` take one to three numbers. */
const OPTION_ARGS: Readonly<Record<string, number>> = {
  '-blendu': 1,
  '-blendv': 1,
  '-bm': 1,
  '-boost': 1,
  '-cc': 1,
  '-clamp': 1,
  '-imfchan': 1,
  '-mm': 2,
  '-o': 3,
  '-s': 3,
  '-t': 3,
  '-texres': 1,
  '-type': 1,
};
const VECTOR_OPTIONS = new Set(['-o', '-s', '-t']);
const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** The file a texture statement names (what follows `map_Kd`), or null when there is none. */
export function mtlMapFile(args: string): string | null {
  let rest = args.trim();
  for (;;) {
    const opt = /^(-[a-z]+)(\s+|$)/i.exec(rest);
    const name = opt?.[1]?.toLowerCase() ?? '';
    const n = OPTION_ARGS[name];
    if (!opt || n === undefined) break;
    rest = rest.slice(opt[0].length);
    for (let i = 0; i < n; i++) {
      const v = /^(\S+)(\s+|$)/.exec(rest);
      if (!v) break;
      // a vector option may give fewer than three numbers: the file name follows
      if (VECTOR_OPTIONS.has(name) && i > 0 && !NUMBER.test(v[1] ?? '')) break;
      rest = rest.slice(v[0].length);
    }
  }
  const file = rest
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/\\/g, '/');
  return file || null;
}

/** The diffuse textures (`map_Kd`) a material file names, in order, each once. */
export function mtlDiffuseMaps(mtl: string): string[] {
  const out: string[] = [];
  for (const m of mtl.matchAll(/^\s*map_Kd\s+(.+?)\s*$/gm)) {
    const f = mtlMapFile(m[1] ?? '');
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}
