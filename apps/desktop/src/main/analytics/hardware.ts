import {
  VLM_MIN_FREE_VRAM_MB,
  VLM_MIN_VRAM_MB,
  type HardwareCheck,
  type HardwareRefusal,
} from '@aio/schema';
import { execFile } from 'node:child_process';
import { programPath, systemProgram } from '@aio/project/fs';
import { join } from 'node:path';
import { presetText } from './text';

export interface Gpu {
  name: string;
  totalMb: number;
  freeMb: number;
  index: number;
  /** `591.86`, as nvidia-smi gives it. */
  driver: string;
  /** CUDA compute capability (`8.9`); null when this nvidia-smi cannot say. */
  computeCap: number | null;
}

export interface HardwareDeps {
  platform: NodeJS.Platform;
  exec: (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;
}

/** The oldest driver (major number) and card (compute capability: RTX 20) detectors run on. */
const MIN_DRIVER = 580;
const MIN_COMPUTE = 7.5;

const QUERY = 'index,name,memory.total,memory.free,driver_version';
/** `compute_cap` is asked for too, unless this nvidia-smi is too old to know it. */
const smiArgs = (withCap: boolean) => [
  `--query-gpu=${QUERY}${withCap ? ',compute_cap' : ''}`,
  '--format=csv,noheader,nounits',
];

/**
 * Parse `nvidia-smi --query-gpu=index,name,memory.total,memory.free,driver_version[,compute_cap]
 * --format=csv,noheader,nounits`; `withCap` says whether compute_cap was asked for.
 */
export function parseNvidiaSmi(csv: string, withCap = true): Gpu[] {
  // the name may itself hold a comma: index first, the other fields last
  const after = withCap ? 4 : 3;
  const gpus: Gpu[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 2 + after) continue;
    const index = Number(cols[0]);
    const [total = '', free = '', driver = '', cap = ''] = cols.slice(-after);
    const totalMb = Number(total);
    const freeMb = Number(free);
    const name = cols.slice(1, -after).join(', ');
    if (![index, totalMb, freeMb].every((n) => Number.isInteger(n) && n >= 0)) continue;
    if (!name || !driver) continue;
    // `[N/A]` or nothing: not known
    const computeCap = withCap && cap !== '' && Number.isFinite(Number(cap)) ? Number(cap) : null;
    gpus.push({ index, name, totalMb, freeMb, driver, computeCap });
  }
  return gpus;
}

const refuse = (
  code: HardwareRefusal,
  vars: Record<string, string | number> = {},
): HardwareCheck => ({ ok: false, code, reason: presetText(`detect.preset.hw.${code}`, vars) });

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * What an nvidia-smi too old for `compute_cap` says (`Field "compute_cap" is not a valid field to
 * query.`). Only this asks again: a timeout's message names the field too, as part of the command.
 */
const FIELD_ERROR = /not a valid field/i;

/** The cards one nvidia-smi reports; null when it cannot be run or fails. */
async function queryGpus(d: HardwareDeps, file: string): Promise<Gpu[] | null> {
  try {
    const r = await d.exec(file, smiArgs(true));
    if (r.code === 0) return parseNvidiaSmi(r.stdout, true);
    if (!FIELD_ERROR.test(r.stdout)) return null;
  } catch (e) {
    if (!FIELD_ERROR.test(message(e))) return null;
  }
  // an older nvidia-smi rejects the compute_cap field: ask again without it
  try {
    const r = await d.exec(file, smiArgs(false));
    return r.code === 0 ? parseNvidiaSmi(r.stdout, false) : null;
  } catch {
    return null;
  }
}

/** The card with the most free memory; null for none. */
const mostFree = (gpus: Gpu[]): Gpu | null =>
  gpus.reduce<Gpu | null>((a, g) => (a && a.freeMb >= g.freeMb ? a : g), null);

/** A driver version that cannot be read is not held against the card. */
const oldDriver = (g: Gpu) => Number.parseInt(g.driver, 10) < MIN_DRIVER;

/**
 * Whether this computer can run the detector model now: an NVIDIA card of the RTX 20 series or
 * newer, on driver 580 or later, with enough total and free memory. Refused in that order (no
 * card, driver, card age, total, free), and the card is picked among those that pass.
 */
export async function checkHardware(d: HardwareDeps): Promise<HardwareCheck> {
  if (d.platform === 'darwin') return refuse('mac');
  // full paths only, so a nvidia-smi planted in the current folder is never run; the driver puts
  // it in System32 (newer) or Program Files (older), and only a drive-letter ProgramFiles counts
  const pf = process.env.ProgramFiles ?? '';
  const programFiles = /^[A-Za-z]:[\\/]/.test(pf) && !pf.includes('\0') ? pf : 'C:/Program Files';
  const candidates =
    d.platform === 'win32'
      ? [
          systemProgram('nvidia-smi'),
          join(programFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
        ]
      : [programPath('nvidia-smi')];
  let gpus: Gpu[] = [];
  for (const file of candidates) {
    const found = await queryGpus(d, file);
    if (found === null) continue;
    gpus = found;
    break;
  }
  const first = gpus[0];
  if (!first) return refuse('noGpu');
  const driverOk = gpus.filter((g) => !oldDriver(g));
  if (driverOk.length === 0) return refuse('oldDriver', { version: first.driver });
  const modern = driverOk.filter((g) => g.computeCap === null || g.computeCap >= MIN_COMPUTE);
  const old = mostFree(driverOk);
  if (modern.length === 0 && old) return refuse('oldGpu', { gpu: old.name });
  // among the cards big enough first, then the most free; tooSmall only when none is big enough
  const big = modern.filter((g) => g.totalMb >= VLM_MIN_VRAM_MB);
  const best = mostFree(big.length > 0 ? big : modern);
  if (!best) return refuse('noGpu');
  if (best.totalMb < VLM_MIN_VRAM_MB) {
    return refuse('tooSmall', { total: Math.floor(best.totalMb / 1024) });
  }
  if (best.freeMb < VLM_MIN_FREE_VRAM_MB) {
    return refuse('tooBusy', { free: (best.freeMb / 1024).toFixed(1) });
  }
  return {
    ok: true,
    gpu: best.name,
    gpuIndex: best.index,
    totalMb: best.totalMb,
    freeMb: best.freeMb,
  };
}

/** The index nvidia-smi gave the GPU the check picked, for CUDA_VISIBLE_DEVICES; null when not ok. */
export function pickedGpuIndex(check: HardwareCheck): number | null {
  return check.ok ? check.gpuIndex : null;
}

/**
 * Production `exec`: no shell, 5 s timeout. Rejects when the program is missing; a run that fails
 * resolves with its code and both outputs (where nvidia-smi names a field it does not know).
 */
export function execNvidiaSmi(
  file: string,
  args: string[],
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout });
        return;
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (typeof code === 'number') {
        resolve({ code, stdout: `${stdout}${stderr}` });
        return;
      }
      reject(new Error(err.message));
    });
  });
}
