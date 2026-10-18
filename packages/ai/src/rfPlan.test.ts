import { ipc } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import {
  estimateRfPlan,
  parseRfPlan,
  RF_PLAN_PROMPT_VERSION,
  rfPlanInstructions,
  rfPlanUserText,
  type AiPickRaw,
  type RfPlanCatalogueInput,
  type RfPlanUnitInput,
} from './rfPlan';

const units: RfPlanUnitInput[] = [
  { unitId: 'u1', widthM: 0.5, heightM: 0.9, depthM: 0.2, downtiltDeg: 4, heightAboveGroundM: 30 },
  { unitId: 'u2', widthM: 0.3, heightM: 1.4, userModel: 'panel 65 deg', userFrequencies: '1800' },
];
const catalogue: RfPlanCatalogueInput[] = [
  { id: 'generic-aau-64t64r-n78', kind: 'aau', vendor: 'Generic', model: 'AAU', bands: ['n78'] },
  { id: 'generic-panel-65-17', kind: 'antenna', vendor: 'Generic', model: 'Panel', bands: ['B3'] },
  { id: 'generic-rru-4t4r-4x40w', kind: 'radio', vendor: 'Generic', model: 'RRU', bands: ['B3'] },
];

const pick = (over: Record<string, unknown> = {}) => ({
  unitId: 'u1',
  entryId: 'generic-aau-64t64r-n78',
  band: 'n78',
  tech: 'nr',
  bandwidthMhz: 100,
  reason: 'deep and wide',
  confidence: 'high',
  ...over,
});

describe('rfPlanInstructions', () => {
  it('has a version', () => {
    expect(RF_PLAN_PROMPT_VERSION).toBe('rf-plan-v1');
  });

  it('instructions forbid geometry and name LTE and NR only', () => {
    const s = rfPlanInstructions();
    expect(s).toMatch(/LTE and NR only/);
    expect(s).toMatch(/Do not report azimuth, tilt or height/);
    expect(s).toMatch(/JSON only/);
  });
});

describe('rfPlanUserText', () => {
  it('lists every unit and catalogue entry with what is known', () => {
    const s = rfPlanUserText(units, catalogue);
    for (const u of units) expect(s).toContain(u.unitId);
    for (const c of catalogue) expect(s).toContain(c.id);
    expect(s).toContain('panel 65 deg');
    expect(s).toContain('1800');
  });

  it('the prompt never contains the project name', () => {
    expect(rfPlanUserText(units, catalogue)).not.toMatch(/E2E tiny project/);
    expect(rfPlanInstructions()).not.toMatch(/E2E tiny project/);
  });
});

describe('parseRfPlan', () => {
  it('parseRfPlan drops geometry keys and unknown units with warnings', () => {
    const r = parseRfPlan(
      JSON.stringify({
        picks: [
          {
            unitId: 'u1',
            entryId: 'x',
            band: 'n78',
            tech: 'nr',
            bandwidthMhz: 100,
            azimuthDeg: 10,
            reason: 'r',
            confidence: 'high',
          },
          {
            unitId: 'zz',
            entryId: 'x',
            band: 'B3',
            tech: 'lte',
            bandwidthMhz: 20,
            reason: 'r',
            confidence: 'low',
          },
        ],
      }),
      ['u1'],
    );
    expect(r.picks).toHaveLength(1);
    expect(r.picks[0]).not.toHaveProperty('azimuthDeg');
    expect(r.warnings.join(' ')).toMatch(/azimuth/);
    expect(r.warnings.join(' ')).toMatch(/zz/);
  });

  it('keeps a radio id, drops unknown keys and fits the IPC pick shape exactly', () => {
    const r = parseRfPlan(
      JSON.stringify({
        picks: [
          pick({
            unitId: 'u2',
            entryId: 'generic-panel-65-17',
            radioId: 'generic-rru-4t4r-4x40w',
            band: 'B3',
            tech: 'lte',
            bandwidthMhz: 20,
            confidence: 'medium',
            downtiltDeg: 3,
            heightM: 30,
            note: 'extra',
          }),
        ],
      }),
      ['u2'],
    );
    const expected: AiPickRaw = {
      unitId: 'u2',
      entryId: 'generic-panel-65-17',
      radioId: 'generic-rru-4t4r-4x40w',
      band: 'B3',
      tech: 'lte',
      bandwidthMhz: 20,
      reason: 'deep and wide',
      confidence: 'medium',
    };
    expect(r.picks).toEqual([expected]);
    expect(r.warnings.join(' ')).toMatch(/downtilt/);
    expect(r.warnings.join(' ')).toMatch(/height/);
    const reply = ipc['ai:rfPlan'].response.parse({
      ok: true,
      provider: 'local',
      model: 'm',
      promptVersion: RF_PLAN_PROMPT_VERSION,
      picks: r.picks,
      inputTokens: 1,
      outputTokens: 1,
      warnings: r.warnings,
    });
    expect(reply.ok && reply.picks).toEqual([expected]);
  });

  it('the IPC pick schema is strict: a geometry key is refused', () => {
    const bad = ipc['ai:rfPlan'].response.safeParse({
      ok: true,
      provider: 'local',
      model: 'm',
      promptVersion: RF_PLAN_PROMPT_VERSION,
      picks: [{ ...pick(), azimuthDeg: 10 }],
      inputTokens: 1,
      outputTokens: 1,
      warnings: [],
    });
    expect(bad.success).toBe(false);
  });

  it('drops picks with a bad tech, band, bandwidth or confidence, and repeats', () => {
    const r = parseRfPlan(
      JSON.stringify({
        picks: [
          pick({ tech: 'gsm' }),
          pick({ unitId: 'u2', bandwidthMhz: -5 }),
          pick({ unitId: 'u3', confidence: 'certain' }),
          pick({ unitId: 'u4', band: '' }),
          pick({ unitId: 'u5', entryId: 42 }),
          pick({ unitId: 'u6' }),
          pick({ unitId: 'u6', band: 'n41' }),
        ],
      }),
      ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'],
    );
    expect(r.picks.map((p) => p.unitId)).toEqual(['u6']);
    expect(r.picks[0]?.band).toBe('n78');
    for (const id of ['u1', 'u2', 'u3', 'u4', 'u5'])
      expect(r.warnings.some((w) => w.includes(id))).toBe(true);
  });

  it('cuts a long reason to 200 characters and warns about units with no pick', () => {
    const r = parseRfPlan(
      '```json\n' + JSON.stringify({ picks: [pick({ reason: 'x'.repeat(500) })] }) + '\n```',
      ['u1', 'u2'],
    );
    expect(r.picks[0]?.reason).toHaveLength(200);
    expect(r.warnings.some((w) => w.includes('u2'))).toBe(true);
  });

  it('a reply that is not a list of picks gives no pick and one warning', () => {
    const r = parseRfPlan('I cannot help with that.', ['u1']);
    expect(r.picks).toEqual([]);
    expect(r.warnings).toHaveLength(1);
  });

  it('caps the warnings and shortens long echoed unit ids', () => {
    const many = Array.from({ length: 40 }, (_, i) => pick({ unitId: `bad-${String(i)}` }));
    many.push(pick({ unitId: 'y'.repeat(300) }));
    const r = parseRfPlan(JSON.stringify({ picks: many }), ['u1']);
    expect(r.warnings.length).toBeLessThanOrEqual(20);
    expect(r.warnings.at(-1)).toMatch(/more warnings/);
    expect(r.warnings.every((w) => w.length < 300)).toBe(true);
  });
});

describe('estimateRfPlan', () => {
  it('grows with units and images', () => {
    const a = estimateRfPlan(1, 0).inputTokens;
    const b = estimateRfPlan(10, 0).inputTokens;
    const c = estimateRfPlan(10, 4).inputTokens;
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });
});
