/**
 * A synthetic camera walk for the walk processing spec: the pipeline Python renders it with
 * `python/tests/walk_synth.py` (two lens streams of a textured scene, a walking path with a swinging
 * stick, and an X4-like trailer with motion data), so no footage is in the repo. The render is
 * cached under `python/.pytest_cache`, so only the first run pays for it.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');

/** Whether `python` imports the pipelines with `walk.process` (a pack older than it has none). */
export function hasWalkProcess(python: string): boolean {
  try {
    const r = spawnSync(python, ['-c', 'import aio_pipelines.walk.pipeline'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

export interface SynthWalkOptions {
  seconds?: number;
  fps?: number;
  lensPx?: number;
  standingS?: number;
}

const SNIPPET = `
import sys
from pathlib import Path
repo, out = Path(sys.argv[1]), Path(sys.argv[2])
sys.path[:0] = [str(repo / "python" / "tests"), str(repo / "python" / "src")]
from walk_synth import make_synth_walk
w = make_synth_walk(out, seconds=float(sys.argv[3]), fps=int(sys.argv[4]),
                    lens_px=int(sys.argv[5]), standing_s=float(sys.argv[6]))
print(w.path)
`;

/**
 * Render (or take from the cache) the synthetic walk into `outDir` and return the path of its
 * `.insv` (named as a camera names its files, `VID_..._00_001.insv`).
 */
export function makeSynthWalk(python: string, outDir: string, o: SynthWalkOptions = {}): string {
  const args = [
    '-c',
    SNIPPET,
    REPO,
    outDir,
    String(o.seconds ?? 12),
    String(o.fps ?? 15),
    String(o.lensPx ?? 320),
    String(o.standingS ?? 2),
  ];
  const r = spawnSync(python, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 600_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (r.status !== 0) throw new Error(`the synthetic walk failed: ${r.stderr || String(r.error)}`);
  const path = r.stdout.trim().split(/\r?\n/).pop();
  if (!path) throw new Error('the synthetic walk printed no path');
  return path;
}
