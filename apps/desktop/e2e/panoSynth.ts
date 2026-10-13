/**
 * A synthetic drone card for the drone panorama specs: the pipeline Python renders it with
 * `python/tests/pano_synth.py` (three spheres in both capture patterns and four mapping photos,
 * DJI-like EXIF and XMP), so no imagery is in the repo.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');

/** Whether `python` has the pano.stitch pipeline (a pack older than 0.7.0 has none). */
export function hasPanoStitch(python: string): boolean {
  try {
    const r = spawnSync(python, ['-c', 'import aio_pipelines.pano.pipeline'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

export interface SynthCard {
  folder: string;
  spheres: number[];
  strays: number;
}

export function makeSynthCard(
  python: string,
  outDir: string,
  at: { lat: number; lon: number },
): SynthCard {
  const r = spawnSync(
    python,
    [
      join(REPO, 'python', 'tests', 'pano_synth.py'),
      outDir,
      '--lat',
      String(at.lat),
      '--lon',
      String(at.lon),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 300_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    },
  );
  if (r.status !== 0) throw new Error(`the synthetic card failed: ${r.stderr || String(r.error)}`);
  const line = r.stdout.trim().split(/\r?\n/).pop() ?? '';
  return JSON.parse(line) as SynthCard;
}
