import type { DetectorModelInfo, Layer, ProjectManifest, VlmDetector } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import type { DetectItem } from '../../detections/convert';
import {
  cloudConfirm,
  reasonKey,
  resolveBackend,
  type Availability,
  type ResolvedBackend,
} from './backend';
import type { AskCheck, DetectorItem } from './checks';
import type { AskBackendPref } from './prefs';

const LAYERS = [
  { kind: 'photos', id: 'ph', items: [] },
  { kind: 'walk', id: 'w', durationS: 60 },
  { kind: 'video', id: 'v' },
] as unknown as Layer[];

const PHOTOS: DetectItem[] = [
  { kind: 'photo', layer: 'ph', photo: 'a' },
  { kind: 'photo', layer: 'ph', photo: 'b' },
];
const WALK_FRAMES: DetectItem[] = [
  { kind: 'frame', layer: 'w', t: 1 },
  { kind: 'frame', layer: 'w', t: 3 },
];
const CLIP_FRAMES: DetectItem[] = [{ kind: 'frame', layer: 'v', t: 5 }];

const CORROSION: AskCheck = { kind: 'class', classId: 'corrosion' };
const CRACK: AskCheck = { kind: 'class', classId: 'crack' };
const EVERYTHING: AskCheck = { kind: 'everything' };

const detector = (id: string, classId: string, assetTypes = ['tank']): DetectorItem => ({
  where: 'library',
  detector: { id, name: id, classId, threshold: 0.65, assetTypes } as unknown as VlmDetector,
  modelMismatch: false,
});
const model = (id: string, classes: string[]) =>
  ({ id, card: { name: id, classes, input: { width: 640, height: 640 } } }) as DetectorModelInfo;

const RUST = detector('rust-v1', 'corrosion');
const LOCAL: Availability['local'] = {
  available: true,
  models: [model('yolo', ['rust', 'bird']), model('ppe', ['person'])],
};
const OFF: Availability['local'] = { available: false, models: [], problem: 'No runtime here.' };
const CLOUD: Availability['cloud'] = { ready: true, provider: 'anthropic', model: 'claude-x' };
const CLOUD_OFF: Availability['cloud'] = { ready: false };

const ALL: Availability = { detectors: [RUST], local: LOCAL, cloud: CLOUD };
const CLOUD_ONLY: Availability = { detectors: [], local: OFF, cloud: CLOUD };
const NONE: Availability = {
  detectors: [],
  local: { available: false, models: [] },
  cloud: CLOUD_OFF,
};

const MAPS: Record<string, Record<string, string>> = {
  yolo: { rust: 'corrosion', bird: '' },
  ppe: { person: '' },
};

function resolve(o: {
  pref?: AskBackendPref;
  check?: AskCheck;
  items?: DetectItem[];
  avail?: Availability;
  localModel?: string | null;
  assetTypes?: string[];
}): ResolvedBackend {
  return resolveBackend({
    pref: o.pref ?? 'auto',
    check: o.check ?? EVERYTHING,
    items: o.items ?? PHOTOS,
    layers: LAYERS,
    avail: o.avail ?? ALL,
    localModel: o.localModel ?? null,
    classMapOf: (id) => MAPS[id] ?? {},
    ...(o.assetTypes ? { assetTypes: o.assetTypes } : {}),
  });
}

describe('resolveBackend', () => {
  it('has nothing to do without items', () => {
    expect(resolve({ items: [] })).toEqual({ kind: 'none', reason: 'nothing' });
  });

  it('prefers the detector of the checked class, then the local model, then cloud', () => {
    expect(resolve({ check: CORROSION, avail: ALL }).kind).toBe('detectors');
    expect(resolve({ check: CORROSION, avail: { ...ALL, detectors: [] } }).kind).toBe('local');
    expect(resolve({ check: CORROSION, avail: { ...ALL, detectors: [], local: OFF } }).kind).toBe(
      'cloud',
    );
  });

  it('runs the class detector at its own threshold', () => {
    expect(resolve({ check: CORROSION })).toEqual({
      kind: 'detectors',
      chosen: [{ where: 'library', detector: RUST.detector, threshold: 0.65 }],
    });
  });

  it('skips a local model that maps no class to the checked one', () => {
    expect(resolve({ check: CRACK, avail: { ...ALL, detectors: [] } })).toEqual({
      kind: 'cloud',
      provider: 'anthropic',
      model: 'claude-x',
    });
  });

  it('takes the chosen local model when installed, else the first', () => {
    const avail = { ...ALL, detectors: [] };
    expect(resolve({ avail, localModel: 'ppe' })).toMatchObject({
      kind: 'local',
      model: { id: 'ppe' },
    });
    expect(resolve({ avail, localModel: 'gone' })).toMatchObject({
      kind: 'local',
      model: { id: 'yolo' },
    });
  });

  it('never goes to the cloud under Local only', () => {
    expect(resolve({ pref: 'local', check: CORROSION, avail: CLOUD_ONLY })).toMatchObject({
      kind: 'none',
      reason: 'no-backend',
    });
    expect(resolve({ pref: 'local', avail: CLOUD_ONLY })).toEqual({
      kind: 'none',
      reason: 'no-backend',
      message: 'No runtime here.',
    });
  });

  it('goes only to the cloud under Cloud', () => {
    expect(resolve({ pref: 'cloud', check: CORROSION })).toMatchObject({ kind: 'cloud' });
    expect(resolve({ pref: 'cloud', items: CLIP_FRAMES })).toMatchObject({ kind: 'cloud' });
    expect(
      resolve({ pref: 'cloud', avail: { ...ALL, cloud: { ready: false, message: 'No key.' } } }),
    ).toEqual({ kind: 'none', reason: 'no-backend', message: 'No key.' });
    expect(
      resolve({ pref: 'cloud', check: { kind: 'detector', where: 'library', id: 'rust-v1' } }),
    ).toMatchObject({ kind: 'none', reason: 'no-backend' });
  });

  it('sends walk frames to the local model only', () => {
    expect(resolve({ items: WALK_FRAMES, avail: CLOUD_ONLY })).toMatchObject({
      kind: 'none',
      reason: 'walk-local',
    });
    expect(resolve({ items: [...PHOTOS, ...WALK_FRAMES], check: CORROSION })).toMatchObject({
      kind: 'local',
      model: { id: 'yolo' },
    });
    // walk frames never leave this computer, whatever the default
    expect(resolve({ pref: 'cloud', items: WALK_FRAMES })).toMatchObject({ kind: 'local' });
    expect(resolve({ pref: 'cloud', items: WALK_FRAMES, avail: CLOUD_ONLY })).toMatchObject({
      kind: 'none',
      reason: 'walk-local',
    });
  });

  it('runs a detector check on photos only', () => {
    const check: AskCheck = { kind: 'detector', where: 'library', id: 'rust-v1' };
    expect(resolve({ check })).toMatchObject({
      kind: 'detectors',
      chosen: [{ detector: { id: 'rust-v1' }, threshold: 0.65 }],
    });
    expect(resolve({ check, items: [...PHOTOS, ...CLIP_FRAMES] })).toEqual({
      kind: 'none',
      reason: 'detector-photos',
    });
    expect(resolve({ check: { kind: 'detector', where: 'project', id: 'rust-v1' } })).toMatchObject(
      { kind: 'none', reason: 'no-backend' },
    );
  });

  it('runs the project detectors for everything when no model or cloud can', () => {
    const avail: Availability = {
      detectors: [RUST, detector('pipe-v1', 'leak', ['pipe']), detector('dent-v1', 'dent')],
      local: OFF,
      cloud: CLOUD_OFF,
    };
    const r = resolve({ avail, assetTypes: ['Tank'] });
    expect(r.kind).toBe('detectors');
    expect(r.kind === 'detectors' && r.chosen.map((c) => c.detector.id)).toEqual([
      'rust-v1',
      'dent-v1',
    ]);
    expect(resolve({ avail, assetTypes: ['Tank'], items: CLIP_FRAMES })).toMatchObject({
      kind: 'none',
      reason: 'no-backend',
    });
  });

  it('says nothing can run with the cloud refusal as the reason', () => {
    expect(
      resolve({ avail: { ...NONE, cloud: { ready: false, message: 'Cloud AI is off.' } } }),
    ).toEqual({ kind: 'none', reason: 'no-backend', message: 'Cloud AI is off.' });
    expect(resolve({ avail: { ...NONE, local: OFF } })).toEqual({
      kind: 'none',
      reason: 'no-backend',
      message: 'No runtime here.',
    });
  });

  it('names an i18n key for each reason', () => {
    expect(reasonKey('no-backend')).toBe('askAi.reason.noBackend');
    expect(reasonKey('walk-local')).toBe('askAi.reason.walkLocal');
    expect(reasonKey('detector-photos')).toBe('askAi.reason.detectorPhotos');
    expect(reasonKey('nothing')).toBe('askAi.reason.nothing');
  });
});

describe('cloudConfirm', () => {
  const manifest = {
    layers: LAYERS,
    severityModels: [],
    classCatalogues: [
      {
        assetType: 'tank',
        classes: [
          { id: 'corrosion', label: 'Corrosion' },
          { id: 'crack', label: 'Crack' },
        ],
      },
    ],
  } as unknown as ProjectManifest;
  const many: DetectItem[] = Array.from({ length: 20 }, (_, i) => ({
    kind: 'photo',
    layer: 'ph',
    photo: `p${String(i)}`,
  }));

  it('says what is sent, where, and about what it costs, before anything is sent', () => {
    const c = cloudConfirm({
      backend: { provider: 'anthropic', model: 'claude-opus-4-1' },
      items: many,
      manifest,
      check: CORROSION,
      batchSize: 4,
    });
    expect(c).toMatchObject({
      provider: 'anthropic',
      providerLabel: 'Anthropic',
      model: 'claude-opus-4-1',
      photos: 20,
      frames: 0,
      hint: 'Corrosion',
    });
    expect(c.preview).toHaveLength(12);
    expect(c.estimate.requests).toBe(5);
    expect(c.instructions).toContain('Corrosion');
    expect(c.userText).toContain('Focus: Corrosion');
  });

  it('sends no hint for everything and counts clip frames apart', () => {
    const c = cloudConfirm({
      backend: { provider: 'openai', model: 'gpt-x' },
      items: [...PHOTOS, ...CLIP_FRAMES],
      manifest,
      check: EVERYTHING,
      batchSize: 4,
    });
    expect(c).toMatchObject({ providerLabel: 'OpenAI', photos: 2, frames: 1, hint: '' });
    expect(c.userText).not.toContain('Focus');
  });
});
