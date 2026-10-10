import type { HardwareProbe, PhotoPreset } from '@aio/schema';
import { formatBytes } from './estimate';

/** The first version of the processing tools that turns photos into maps (pack 0.4.0, M10). */
const TOOLS_VERSION = '0.4.0';

/**
 * Whether this computer can create maps from photos. When it cannot: a title and one sentence in
 * plain words, and `fix` names what puts it right (`tools`: install or update the processing
 * tools; null: nothing on this computer does).
 */
export interface ProcessingVerdict {
  ok: boolean;
  title: string;
  text: string;
  fix: 'tools' | null;
}

export function processingLine(p: HardwareProbe): ProcessingVerdict {
  switch (p.processing) {
    case 'available':
      return {
        ok: true,
        title: 'Ready',
        text: 'This computer can create maps from photos.',
        fix: null,
      };
    case 'no-pack':
      return {
        ok: false,
        title: 'The processing tools are not installed',
        text: `Creating maps from photos needs the processing tools, version ${TOOLS_VERSION} or later. They are not on this computer yet.`,
        fix: 'tools',
      };
    case 'pack-too-old':
      return {
        ok: false,
        title: 'The processing tools need an update',
        text: `The processing tools on this computer are too old to create maps from photos. Update them to version ${TOOLS_VERSION} or later.`,
        fix: 'tools',
      };
    case 'unsupported-platform':
      return {
        ok: false,
        title: 'This computer cannot create maps from photos',
        text: 'Creating maps from photos runs on Windows x64 and on Macs with Apple silicon. This computer can open the results.',
        fix: null,
      };
  }
}

/**
 * What does the work, as quiet detail: "NVIDIA GeForce RTX 4070: used for High" when the pack's
 * CUDA build is present, else the processor. Graphics card acceleration does not exist yet
 * (ADR 0008 decision 5), so its absence is information, never something the person missed.
 */
export function gpuLine(p: HardwareProbe, preset: PhotoPreset): string {
  const nvidia = p.gpus.find((g) => g.vendor === 'NVIDIA' || /nvidia/i.test(g.name));
  const vram = (g: { vramBytes?: number | undefined }) =>
    g.vramBytes ? `, ${formatBytes(g.vramBytes)}` : '';
  if (p.cuda && nvidia)
    return `${nvidia.name}${vram(nvidia)}: ${preset === 'high' ? 'used for High' : 'used for High only'}`;
  return 'Runs on the processor. Graphics card acceleration is not available yet.';
}

/** "Synthetic 8-core CPU, 8 cores, 32 GB memory, 512 GB free". */
export function machineLine(p: HardwareProbe): string {
  const cores = `${String(p.cpu.cores)} ${p.cpu.cores === 1 ? 'core' : 'cores'}`;
  return `${p.cpu.model || 'CPU'}, ${cores}, ${formatBytes(p.memoryBytes)} memory, ${formatBytes(p.freeDiskBytes)} free on the data drive`;
}
