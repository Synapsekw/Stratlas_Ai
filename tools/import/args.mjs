import { join } from 'node:path';
import { envVar } from '../../packages/brand/src/env.ts';

/**
 * `--src` and `--out` with defaults under QUADRION_DATA (or E:\Stratlas Data), and the optional
 * `--originals` folder of original recordings (video proxies are made from them).
 */
export function parseArgs(project) {
  const root = envVar(process.env, 'DATA') ?? 'E:\\Stratlas Data';
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    src: get('src') ?? join(root, 'sources', project),
    out: get('out') ?? join(root, 'projects', project),
    originals: get('originals'),
  };
}
