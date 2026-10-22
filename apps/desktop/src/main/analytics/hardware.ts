import { VLM_MIN_FREE_VRAM_MB, VLM_MIN_VRAM_MB, type HardwareCheck } from '@aio/schema';
import { en } from '@aio/ui/i18n/en';
import { execFile } from 'node:child_process';
import { programPath, systemProgram } from '@aio/project/fs';
import { join } from 'node:path';

export interface Gpu {
  name: string;
  totalMb: number;
  freeMb: number;
  index: number;
}

export interface HardwareDeps {
  platform: NodeJS.Platform;
  exec: (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;
}

const SMI_ARGS = [
  '--query-gpu=index,name,memory.total,memory.free',
  '--format=csv,noheader,nounits',
];

/** Parse `nvidia-smi --query-gpu=index,name,memory.total,memory.free --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(csv: string): Gpu[] {
  const gpus: Gpu[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 4) continue;
    // the name may itself hold a comma: index first, memory last
    const index = Number(cols[0]);
    const totalMb = Number(cols[cols.length - 2]);
    const freeMb = Number(cols[cols.length - 1]);
    const name = cols.slice(1, -2).join(', ');
    if (![index, totalMb, freeMb].every((n) => Number.isInteger(n) && n >= 0) || !name) continue;
    gpus.push({ index, name, totalMb, freeMb });
  }
  return gpus;
}

type HwKey = 'noGpu' | 'tooSmall' | 'tooBusy' | 'mac';

/** The `detect.preset.hw.*` text from the catalogue, with `{name}` placeholders filled. */
function t(key: HwKey, vars: Record<string, string | number> = {}): string {
  return en[`detect.preset.hw.${key}`].replace(/\{(\w+)\}/g, (whole, n: string) =>
    n in vars ? String(vars[n]) : whole,
  );
}

const noGpu = (): HardwareCheck => ({ ok: false, reason: t('noGpu') });

/** Whether this computer can run the detector model now: an NVIDIA card with enough total and free memory. */
export async function checkHardware(d: HardwareDeps): Promise<HardwareCheck> {
  if (d.platform === 'darwin') return { ok: false, reason: t('mac') };
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
    try {
      const r = await d.exec(file, SMI_ARGS);
      if (r.code !== 0) continue;
      gpus = parseNvidiaSmi(r.stdout);
      break;
    } catch {
      // not on PATH here; try the next place
    }
  }
  // among the cards big enough first, then the most free; tooSmall only when none is big enough
  const big = gpus.filter((g) => g.totalMb >= VLM_MIN_VRAM_MB);
  const best = (big.length > 0 ? big : gpus).reduce<Gpu | null>(
    (a, g) => (a && a.freeMb >= g.freeMb ? a : g),
    null,
  );
  if (!best) return noGpu();
  if (best.totalMb < VLM_MIN_VRAM_MB) {
    return {
      ok: false,
      reason: t('tooSmall', { total: Math.floor(best.totalMb / 1024) }),
    };
  }
  if (best.freeMb < VLM_MIN_FREE_VRAM_MB) {
    return {
      ok: false,
      reason: t('tooBusy', { free: (best.freeMb / 1024).toFixed(1) }),
    };
  }
  const result: HardwareCheck = {
    ok: true,
    gpu: best.name,
    gpuIndex: best.index,
    totalMb: best.totalMb,
    freeMb: best.freeMb,
  };
  return result;
}

/** The index nvidia-smi gave the GPU the check picked, for CUDA_VISIBLE_DEVICES; null when not ok. */
export function pickedGpuIndex(check: HardwareCheck): number | null {
  return check.ok ? check.gpuIndex : null;
}

/** Production `exec`: no shell, 5 s timeout. Rejects when the program is missing. */
export function execNvidiaSmi(
  file: string,
  args: string[],
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (!err) {
        resolve({ code: 0, stdout });
        return;
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (typeof code === 'number') {
        resolve({ code, stdout });
        return;
      }
      reject(new Error(err.message));
    });
  });
}
