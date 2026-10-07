import type { HardwareProbe } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  cameraGroups,
  cameraLabel,
  defaultProducts,
  diskShort,
  formatBytes,
  formatMinutes,
  newRunId,
  splitNotes,
  suggestedEpsg,
} from './estimate';
import { gpuLine, machineLine, processingLine } from './hardware';

const GB = 1024 ** 3;
const probe = (o: Partial<HardwareProbe> = {}): HardwareProbe => ({
  platform: 'win32',
  arch: 'x64',
  cpu: { model: 'Synthetic CPU', cores: 8 },
  memoryBytes: 32 * GB,
  freeDiskBytes: 512 * GB,
  gpus: [],
  cuda: false,
  processing: 'available',
  ...o,
});

describe('estimate words', () => {
  it('formats a time range in the unit a person reads', () => {
    expect(formatMinutes([30, 60])).toBe('About 30 to 60 min');
    expect(formatMinutes([180, 360])).toBe('About 3 to 6 h');
    expect(formatMinutes([45, 135])).toBe('About 45 min to 2.5 h');
    expect(formatMinutes([600, 1200])).toBe('About 10 to 20 h');
    expect(formatMinutes([3000, 6000])).toBe('About 2 to 4 days');
    expect(formatMinutes([0, 0])).toMatch(/nothing to process/);
    expect(formatMinutes([1, 1])).toBe('About 1 min');
    expect(formatMinutes([0.2, 0.6])).toBe('Under a minute');
  });

  it('formats bytes', () => {
    expect(formatBytes(38 * GB)).toBe('38.0 GB');
    expect(formatBytes(512 * GB)).toBe('512 GB');
    expect(formatBytes(750 * 1024 ** 2)).toBe('750 MB');
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('splits the notes into camera groups, the UTM zone and the rest', () => {
    const s = splitNotes({
      minutes: [1, 2],
      diskBytes: 1,
      memoryBytes: 1,
      notes: [
        'The photos are in UTM zone 39N (EPSG:32639).',
        'Camera group: Stratlas Synthetic SYN-20, 1600 × 1200 (58 photos).',
        'Needs 59 GB free on the data drive, has 21 GB. Free some space or choose a smaller preset.',
      ],
    });
    expect(s.zone?.epsg).toBe(32639);
    expect(s.groups).toEqual(['Stratlas Synthetic SYN-20, 1600 × 1200 (58 photos)']);
    expect(s.other).toHaveLength(1);
    expect(diskShort({ minutes: [1, 2], diskBytes: 1, memoryBytes: 1, notes: s.other })).toBe(true);
  });

  it('makes run ids from the time, unique in the project', () => {
    const now = new Date(2026, 9, 7, 9, 5);
    expect(newRunId(now, [])).toBe('20261007-0905');
    expect(newRunId(now, ['20261007-0905'])).toBe('20261007-0905-2');
    expect(newRunId(now, ['20261007-0905', '20261007-0905-2'])).toBe('20261007-0905-3');
  });

  it('starts each preset with its usual products', () => {
    expect(defaultProducts('fast')).toEqual(['ortho', 'dsm']);
    expect(defaultProducts('standard')).toContain('mesh');
  });
});

describe('hardware words', () => {
  it('says whether processing runs here and why not', () => {
    expect(processingLine(probe())).toEqual({
      ok: true,
      text: 'Photo processing: available (CPU)',
    });
    expect(processingLine(probe({ processing: 'no-pack' })).ok).toBe(false);
    expect(processingLine(probe({ processing: 'unsupported-platform' })).text).toMatch(
      /Windows x64 and on Macs with Apple silicon/,
    );
  });

  it('names the GPU and whether High uses it', () => {
    expect(gpuLine(probe(), 'high')).toBe('No supported GPU: CPU only');
    const rtx = { name: 'NVIDIA GeForce RTX 4070', vendor: 'NVIDIA', vramBytes: 12 * GB };
    expect(gpuLine(probe({ gpus: [rtx], cuda: true }), 'high')).toBe(
      'NVIDIA GeForce RTX 4070, 12.0 GB: used for High',
    );
    expect(gpuLine(probe({ gpus: [rtx] }), 'standard')).toMatch(/not used yet.*CPU only/);
    expect(machineLine(probe())).toBe(
      'Synthetic CPU, 8 cores, 32.0 GB memory, 512 GB free on the data drive',
    );
  });
});

describe('camera groups and the photos zone', () => {
  const base = { minutes: [1, 2] as [number, number], diskBytes: 0, memoryBytes: 0 };

  it('lists the estimate cameras, then groups only a note names', () => {
    const e = {
      ...base,
      cameras: [
        {
          id: 'cam1',
          make: 'Stratlas Synthetic',
          model: 'SYN-20',
          widthPx: 1600,
          heightPx: 1200,
          focalMm: 8.8,
          photos: 58,
        },
        { id: 'cam2', widthPx: 640, heightPx: 480, photos: 1 },
      ],
      notes: ['Camera group: Unknown camera (2 photos), frame size not readable.'],
    };
    expect(cameraLabel(e.cameras[1] ?? e.cameras[0])).toBe('Unknown camera, 640 × 480 (1 photo)');
    expect(cameraGroups(e)).toEqual([
      'Stratlas Synthetic SYN-20, 1600 × 1200, 8.8 mm (58 photos)',
      'Unknown camera, 640 × 480 (1 photo)',
      'Unknown camera (2 photos), frame size not readable',
    ]);
  });

  it('takes the suggested EPSG, else the zone note', () => {
    expect(suggestedEpsg({ ...base, suggestedEpsg: 32639 })).toBe(32639);
    expect(
      suggestedEpsg({ ...base, notes: ['The photos are in UTM zone 40N (EPSG:32640).'] }),
    ).toBe(32640);
    expect(suggestedEpsg(base)).toBeNull();
  });
});
