import type { HardwareProbe, PhotoEstimate } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  cameraGroups,
  cameraLabel,
  defaultProducts,
  diskNeed,
  diskShort,
  fasterPreset,
  formatBytes,
  formatMinutes,
  gpsNote,
  isLongRun,
  longRunHint,
  memoryNote,
  newRunId,
  photoSummary,
  presetLabel,
  PRESETS,
  SIMPLE_DEFAULTS,
  splitNotes,
  suggestedEpsg,
  summaryLine,
  zoneQuestion,
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
  it('says whether maps can be made here, and what fixes it when they cannot', () => {
    expect(processingLine(probe())).toMatchObject({ ok: true, fix: null });
    // missing or old processing tools: one fix, the same for both
    const none = processingLine(probe({ processing: 'no-pack' }));
    expect(none).toMatchObject({
      ok: false,
      fix: 'tools',
      title: 'The processing tools are not installed',
    });
    expect(none.text).toMatch(/needs the processing tools, version 0\.4\.0 or later/);
    const old = processingLine(probe({ processing: 'pack-too-old' }));
    expect(old).toMatchObject({
      ok: false,
      fix: 'tools',
      title: 'The processing tools need an update',
    });
    expect(old.text).toMatch(/too old to create maps from photos\. Update them to version 0\.4\.0/);
    // nothing on this computer fixes the platform
    const platform = processingLine(probe({ processing: 'unsupported-platform' }));
    expect(platform).toMatchObject({ ok: false, fix: null });
    expect(platform.text).toMatch(/Windows x64 and on Macs with Apple silicon/);
    // the words a person reads say "processing tools", never "pipeline pack"
    for (const p of ['no-pack', 'pack-too-old', 'unsupported-platform'] as const) {
      const v = processingLine(probe({ processing: p }));
      expect(`${v.title} ${v.text}`).not.toMatch(/pipeline|pack\b/i);
    }
  });

  it('names the graphics card only when it is used; its absence is not a fault', () => {
    const quiet = 'Runs on the processor. Graphics card acceleration is not available yet.';
    expect(gpuLine(probe(), 'high')).toBe(quiet);
    const rtx = { name: 'NVIDIA GeForce RTX 4070', vendor: 'NVIDIA', vramBytes: 12 * GB };
    expect(gpuLine(probe({ gpus: [rtx], cuda: true }), 'high')).toBe(
      'NVIDIA GeForce RTX 4070, 12.0 GB: used for High',
    );
    expect(gpuLine(probe({ gpus: [rtx], cuda: true }), 'standard')).toBe(
      'NVIDIA GeForce RTX 4070, 12.0 GB: used for High only',
    );
    // a card without the accelerator reads the same as no card: nothing to install
    expect(gpuLine(probe({ gpus: [rtx] }), 'standard')).toBe(quiet);
    expect(gpuLine(probe({ gpus: [rtx] }), 'standard')).not.toMatch(/not installed|CPU only/);
    expect(machineLine(probe())).toBe(
      'Synthetic CPU, 8 cores, 32.0 GB memory, 512 GB free on the data drive',
    );
  });
});

describe('create maps from photos: the simple start', () => {
  const est = (o: Partial<PhotoEstimate> = {}): PhotoEstimate => ({
    minutes: [180, 360],
    diskBytes: 38 * GB,
    memoryBytes: 8 * GB,
    ...o,
  });
  const camera = (photos: number, id = 'cam1') => ({
    id,
    make: 'Stratlas Synthetic',
    model: 'SYN-20',
    widthPx: 1600,
    heightPx: 1200,
    photos,
  });

  it('starts on Standard with the maps, the point cloud and the 3D model', () => {
    expect(SIMPLE_DEFAULTS).toEqual({
      preset: 'standard',
      gnss: 'auto',
      groundControlFirst: false,
    });
    expect(presetLabel(SIMPLE_DEFAULTS.preset)).toBe('Standard');
    expect(defaultProducts(SIMPLE_DEFAULTS.preset)).toEqual([
      'ortho',
      'dsm',
      'dtm',
      'cloud',
      'mesh',
    ]);
    expect(PRESETS.map((p) => p.label)).toEqual(['Quick', 'Standard', 'High']);
  });

  it('sums the photos up in one line', () => {
    const one = photoSummary(est({ cameras: [camera(248)] }));
    expect(one).toEqual({ photos: 248, cameras: 1, noGps: 0, about: false });
    expect(summaryLine(one)).toBe('248 photos, 1 camera, GPS on all');
    // a photos layer knows its count exactly
    expect(summaryLine(photoSummary(est({ cameras: [camera(12)] }), 12))).toBe(
      '12 photos, 1 camera, GPS on all',
    );
    // large folders are counted from a sample
    const many = photoSummary(est({ cameras: [camera(1200), camera(48, 'cam2')] }));
    expect(summaryLine(many)).toBe('About 1,248 photos, 2 cameras, GPS on all');
    // a camera only a note names counts too
    const noted = photoSummary(
      est({
        cameras: [camera(58)],
        notes: ['Camera group: Unknown camera (2 photos), frame size not readable.'],
      }),
    );
    expect(summaryLine(noted)).toBe('60 photos, 2 cameras, GPS on all');
    expect(summaryLine({ photos: 1, cameras: 1, noGps: 0, about: false })).toBe(
      '1 photo, 1 camera, GPS on all',
    );
  });

  it('says how many photos have no GPS, and what that means', () => {
    const some = photoSummary(
      est({
        cameras: [camera(58)],
        notes: ['3 photos have no GPS position; they are placed by matching only.'],
      }),
    );
    expect(summaryLine(some)).toBe('58 photos, 1 camera, 3 without GPS');
    expect(gpsNote(some)).toBe(
      '3 photos have no GPS position. They are placed by matching the other photos.',
    );
    const one = photoSummary(
      est({
        cameras: [camera(58)],
        notes: ['1 photo has no GPS position; they are placed by matching only.'],
      }),
    );
    expect(gpsNote(one)).toBe(
      '1 photo has no GPS position. It is placed by matching the other photos.',
    );
    const none = photoSummary(
      est({
        cameras: [camera(58)],
        notes: ['58 photos have no GPS position; they are placed by matching only.'],
      }),
    );
    expect(summaryLine(none)).toBe('58 photos, 1 camera, no GPS');
    expect(gpsNote(none)).toMatch(/until you add ground control points/);
    expect(gpsNote(photoSummary(est({ cameras: [camera(58)] })))).toBeNull();
  });

  it('asks about the coordinate system only when the photos are in another UTM zone', () => {
    expect(zoneQuestion(32639, 32639)).toBeNull();
    expect(zoneQuestion(32639, null)).toBeNull();
    expect(zoneQuestion(null, 32639)).toBeNull();
    expect(zoneQuestion(32639, 32640)).toEqual({
      project: { epsg: 32639, name: 'UTM zone 39N' },
      photos: { epsg: 32640, name: 'UTM zone 40N' },
    });
    expect(zoneQuestion(32639, 32755)?.photos.name).toBe('UTM zone 55S');
    // a national or local grid says nothing about the photos' UTM zone: no question
    expect(zoneQuestion(27700, 32630)).toBeNull();
    expect(zoneQuestion(2039, 32636)).toBeNull();
  });

  it('reads the disk shortfall and the memory note out of the estimate', () => {
    const short = est({
      notes: [
        'Needs 59 GB free on the data drive, has 21 GB. Free some space or choose a smaller preset.',
        'Standard on 16.0 GB: images at half size and dense matching in clusters of about 40 photos, so it stays within memory.',
        'Times are a range: scene content and a warm laptop can make a run slower.',
      ],
    });
    expect(diskNeed(short)).toEqual({ needs: '59 GB', has: '21 GB' });
    expect(memoryNote(short)).toMatch(/^Standard on 16\.0 GB/);
    expect(diskNeed(est())).toBeNull();
    expect(memoryNote(est())).toBeNull();
  });

  it('gives one hint about time, and only for a very long run', () => {
    // Standard on an ordinary flight: no hint at all
    expect(isLongRun(est())).toBe(false);
    expect(longRunHint('standard', est(), null)).toBeNull();
    // High on the processor: the long time, and the quicker quality with its own estimate
    const high = est({ minutes: [1200, 2340] });
    const standard = est({ minutes: [300, 600] });
    expect(isLongRun(high)).toBe(true);
    expect(longRunHint('high', high, { preset: 'standard', estimate: standard })).toEqual({
      text: 'High takes about 20 to 39 h on this computer. Standard: about 5 to 10 h.',
      switchTo: 'standard',
    });
    // before the quicker estimate is in: the time alone, nothing to switch to yet
    expect(longRunHint('high', high, null)).toEqual({
      text: 'High takes about 20 to 39 h on this computer.',
      switchTo: null,
    });
    expect(fasterPreset('high')).toBe('standard');
    expect(fasterPreset('standard')).toBe('fast');
    expect(fasterPreset('fast')).toBeNull();
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
    expect(cameraLabel({ id: 'cam2', widthPx: 640, heightPx: 480, photos: 1 })).toBe(
      'Unknown camera, 640 × 480 (1 photo)',
    );
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
