import { join } from 'node:path';

/** `--src` and `--out` with defaults under STRATLAS_DATA (or E:\Stratlas Data). */
export function parseArgs(project) {
  const root = process.env.STRATLAS_DATA ?? 'E:\\Stratlas Data';
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    src: get('src') ?? join(root, 'sources', project),
    out: get('out') ?? join(root, 'projects', project),
  };
}
