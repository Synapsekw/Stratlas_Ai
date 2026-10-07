import type { HardwareProbe, PhotoPreset } from '@aio/schema';
import { formatBytes } from './estimate';

/** Whether processing can start here, and why not in words. */
export function processingLine(p: HardwareProbe): { ok: boolean; text: string } {
  switch (p.processing) {
    case 'available':
      return { ok: true, text: `Photo processing: available (${p.cuda ? 'GPU' : 'CPU'})` };
    case 'no-pack':
      return {
        ok: false,
        text: 'Photo processing needs the pipeline pack 0.4.0 or later. Install it in Settings, Pipelines.',
      };
    case 'pack-too-old':
      return {
        ok: false,
        text: 'The installed pipeline pack is too old for photo processing. Install pack 0.4.0 or later.',
      };
    case 'unsupported-platform':
      return {
        ok: false,
        text: 'Photo processing runs on Windows x64 and on Macs with Apple silicon. This computer can open the results.',
      };
  }
}

/**
 * The GPU line of the wizard: "NVIDIA GeForce RTX 4070: used for High", or why the CPU does the
 * work. The CUDA build is an optional download (decision 5), so a GPU alone is not enough.
 */
export function gpuLine(p: HardwareProbe, preset: PhotoPreset): string {
  const nvidia = p.gpus.find((g) => g.vendor === 'NVIDIA' || /nvidia/i.test(g.name));
  const vram = (g: { vramBytes?: number | undefined }) =>
    g.vramBytes ? `, ${formatBytes(g.vramBytes)}` : '';
  if (p.cuda && nvidia)
    return `${nvidia.name}${vram(nvidia)}: ${preset === 'high' ? 'used for High' : 'used for High only'}`;
  if (nvidia)
    return `${nvidia.name}${vram(nvidia)}: not used yet (the GPU accelerator is not installed). CPU only.`;
  return 'No supported GPU: CPU only';
}

/** "Synthetic 8-core CPU, 8 cores, 32 GB memory, 512 GB free". */
export function machineLine(p: HardwareProbe): string {
  const cores = `${String(p.cpu.cores)} ${p.cpu.cores === 1 ? 'core' : 'cores'}`;
  return `${p.cpu.model || 'CPU'}, ${cores}, ${formatBytes(p.memoryBytes)} memory, ${formatBytes(p.freeDiskBytes)} free on the data drive`;
}
