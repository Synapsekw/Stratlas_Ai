import type { HardwareProbe } from '@aio/schema';
import { formatBytes } from './estimate';

/** The first version of the processing tools that turns photos into maps (pack 0.8.0, ODM). */
const TOOLS_VERSION = '0.8.0';

/**
 * Whether this computer can create maps from photos. When it cannot: a title and one sentence in
 * plain words, and `fix` names what puts it right (`tools`: install or update the processing
 * tools; `engine`: install ODM in Settings; null: nothing on this computer does).
 */
export interface ProcessingVerdict {
  ok: boolean;
  title: string;
  text: string;
  fix: 'tools' | 'engine' | null;
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
    case 'no-engine':
      return {
        ok: false,
        title: 'Install the processing engine first',
        text: 'Creating maps from photos uses ODM, the processing engine. Install it once in Settings, Processing tools (a 234 MB download).',
        fix: 'engine',
      };
    case 'unsupported-platform':
      return {
        ok: false,
        title: 'This computer cannot create maps from photos',
        text: 'Creating maps from photos runs on Windows x64. This computer can open the results.',
        fix: null,
      };
  }
}

/** What does the work, as quiet detail: the NVIDIA card when ODM can use it, else the processor. */
export function gpuLine(p: HardwareProbe): string {
  const nvidia = p.gpus.find((g) => g.vendor === 'NVIDIA' || /nvidia/i.test(g.name));
  if (p.cuda && nvidia)
    return p.engine?.gpu === 'off'
      ? `${nvidia.name}: switched off in Settings; processing uses the CPU`
      : `${nvidia.name}: used for processing`;
  return 'No NVIDIA graphics card found; processing uses the CPU';
}

/** "Synthetic 8-core CPU, 8 cores, 32 GB memory, 512 GB free". */
export function machineLine(p: HardwareProbe): string {
  const cores = `${String(p.cpu.cores)} ${p.cpu.cores === 1 ? 'core' : 'cores'}`;
  return `${p.cpu.model || 'CPU'}, ${cores}, ${formatBytes(p.memoryBytes)} memory, ${formatBytes(p.freeDiskBytes)} free on the data drive`;
}
