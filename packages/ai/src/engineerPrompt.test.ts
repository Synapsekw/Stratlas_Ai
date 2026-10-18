import { EngineerProposal, ProposalComponent } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { engineerSystem } from './engineerPrompt';

const proposal = EngineerProposal.shape;
const component = ProposalComponent.shape;
const conflict = proposal.identity.shape.conflicts.element.shape;
const strings = (n: number) => Array.from({ length: n }, () => 'x');
const text = (n: number) => 'x'.repeat(n);

describe('engineering prompt validation contract', () => {
  // Read the bounds actually communicated to the model and exercise the production validator
  // at and beyond them. A missing instruction or a bound that disagrees with validation fails.
  it.each([
    {
      field: 'family reasons count',
      pattern: /family\.reasons: (\d+) items/,
      schema: proposal.family.shape.reasons,
      make: strings,
    },
    {
      field: 'family reason length',
      pattern: /family\.reasons: \d+ items, (\d+) characters each/,
      schema: proposal.family.shape.reasons.element,
      make: text,
    },
    {
      field: 'identity conflicts count',
      pattern: /identity\.conflicts: (\d+) items/,
      schema: proposal.identity.shape.conflicts,
      make: (n: number) => Array.from({ length: n }, () => ({ imageIds: [], reason: '' })),
    },
    {
      field: 'conflict reason length',
      pattern: /conflict reason: (\d+) characters/,
      schema: conflict.reason,
      make: text,
    },
    {
      field: 'conflict image count',
      pattern: /conflict imageIds: (\d+) items/,
      schema: conflict.imageIds,
      make: strings,
    },
    {
      field: 'component count',
      pattern: /components: (\d+) entries/,
      schema: proposal.components,
      make: (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          role: `part-${i}`,
          kind: 'antenna',
          count: 1,
          units: 'm',
          params: {},
          imageIds: [],
          observed: true,
        })),
    },
    {
      field: 'copies per component',
      pattern: /count: integer 0 to (\d+)/,
      schema: component.count,
      make: (n: number) => n,
    },
    {
      field: 'description length',
      pattern: /description: (\d+) characters/,
      schema: component.description,
      make: text,
    },
    {
      field: 'parameters per component',
      pattern: /params: (\d+) unique/,
      schema: component.params,
      make: (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, true])),
    },
    {
      field: 'parameter string length',
      pattern: /string values: (\d+) characters/,
      schema: component.params,
      make: (n: number) => ({ type: text(n) }),
    },
    {
      field: 'level count',
      pattern: /levels: (\d+) numbers/,
      schema: component.levels,
      make: (n: number) => Array.from({ length: n }, () => 1),
    },
    {
      field: 'component image count',
      pattern: /component imageIds: (\d+) items/,
      schema: component.imageIds,
      make: strings,
    },
    {
      field: 'image ID length',
      pattern: /all image IDs: (\d+) characters/,
      schema: component.imageIds.element,
      make: text,
    },
    {
      field: 'unresolved count',
      pattern: /unresolved: (\d+) items/,
      schema: proposal.unresolved,
      make: strings,
    },
    {
      field: 'unresolved length',
      pattern: /unresolved: \d+ items, (\d+) characters each/,
      schema: proposal.unresolved.element,
      make: text,
    },
    {
      field: 'notes length',
      pattern: /notes: (\d+) characters/,
      schema: proposal.notes,
      make: text,
    },
  ])('communicates the enforced $field bound', ({ pattern, schema, make }) => {
    const match = engineerSystem().match(pattern);
    expect(match, 'The generated prompt must communicate this bound').not.toBeNull();
    const limit = Number(match?.[1]);
    expect(schema.safeParse(make(limit)).success).toBe(true);
    expect(schema.safeParse(make(limit + 1)).success).toBe(false);
  });

  it('communicates role/name syntax and level bounds that match validation', () => {
    const prompt = engineerSystem();
    const role = /role pattern: `([^`]+)`/.exec(prompt);
    const name = /parameter name pattern: `([^`]+)`/.exec(prompt);
    expect(role).not.toBeNull();
    expect(name).not.toBeNull();
    for (const value of ['a', 'a-1', 'a'.repeat(40), 'a'.repeat(41), 'A', '1a', 'a_b', '']) {
      expect(new RegExp(role?.[1] ?? '(?!)').test(value)).toBe(
        component.role.safeParse(value).success,
      );
    }
    for (const value of [
      'a',
      'observationId',
      'A0',
      'a'.repeat(40),
      'a'.repeat(41),
      'a-b',
      '1a',
      '',
    ]) {
      expect(new RegExp(name?.[1] ?? '(?!)').test(value)).toBe(
        component.params.safeParse({ [value]: true }).success,
      );
    }
    const levels = /levels: \d+ numbers in \[([\d.]+), ([\d.]+)\]/.exec(prompt);
    expect(levels).not.toBeNull();
    const min = Number(levels?.[1]),
      max = Number(levels?.[2]);
    expect(component.levels.safeParse([min, max]).success).toBe(true);
    expect(component.levels.safeParse([min - 0.01]).success).toBe(false);
    expect(component.levels.safeParse([max + 0.01]).success).toBe(false);
  });

  it('keeps measured-object annotations selective without excluding a full device review or inferred details', () => {
    const prompt = engineerSystem();
    expect(prompt).toContain(
      'Measured objects are already retained even when omitted from components.',
    );
    expect(prompt).toContain(
      'only when useful visual classification or a fit caveat adds information',
    );
    expect(prompt).toContain('Omit unchanged measured geometry and repetitive boilerplate');
    expect(prompt).toContain('Review as many distinct devices as need useful annotations');
    expect(prompt).toContain('Continue to propose useful unresolved construction details');
    expect(prompt).toContain('params is an array of {name, value} pairs');
    const devices = Array.from({ length: 30 }, (_, i) => ({
      role: `device-${i}`,
      kind: 'antenna',
      count: 1,
      units: 'm',
      params: { observationId: `obs-device-${i}`, kind: i < 12 ? 'panel' : 'rru' },
      levels: [],
      imageIds: ['img-side'],
      observed: true,
      description: 'Rear cover partly occluded.',
    }));
    expect(
      EngineerProposal.safeParse({
        family: { value: 'telecom-monopole', reasons: [] },
        identity: { sameAsset: true, conflicts: [] },
        components: [
          ...devices,
          {
            role: 'mount-detail',
            kind: 'antennaMount',
            count: 1,
            units: 'm',
            params: { type: 'standoff' },
            levels: [],
            imageIds: [],
            observed: false,
            description: 'Inferred support detail; confirm on site.',
          },
        ],
        unresolved: [],
        notes: '',
      }).success,
    ).toBe(true);
  });

  it('restricts unknown-box classification to original-photo evidence without changing measured geometry', () => {
    const prompt = engineerSystem();
    expect(prompt).toContain('equipment-box');
    expect(prompt).toContain('original-photo imageIds');
    expect(prompt).toContain('observed true');
    expect(prompt).toContain('Generated views cannot establish this classification');
  });
});
