import type { RfAntennaSettings, RfOrigin } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { lteSettings } from '../__fixtures__/rfData';
import { groupTag, originTag, unitTag } from './stepTag';

const by = (o: RfOrigin['by'], confidence?: RfOrigin['confidence']): RfOrigin =>
  confidence ? { by: o, confidence } : { by: o };

/** One unit whose equipment and first carrier were set by the given origins. */
const set = (equipment?: RfOrigin, carrier?: RfOrigin): RfAntennaSettings => {
  const s = lteSettings('ant-a1');
  return {
    ...s,
    ...(equipment ? { origins: { equipment } } : {}),
    carriers: s.carriers.map((c) => (carrier ? { ...c, origin: carrier } : c)),
  };
};

describe('step tags', () => {
  it('reads an origin, a missing one meaning the person set it', () => {
    expect(originTag(undefined)).toBe('edited');
    expect(originTag(by('user'))).toBe('edited');
    expect(originTag(by('ai'))).toBe('ai');
    expect(originTag(by('ai', 'high'))).toBe('ai');
    expect(originTag(by('ai', 'low'))).toBe('ai-low');
    expect(originTag(by('rules'))).toBe('rules');
    // ruling R24: low confidence is amber whoever set it
    expect(originTag(by('rules', 'low'))).toBe('ai-low');
    expect(originTag(by('rules', 'medium'))).toBe('rules');
    expect(originTag(by('export'))).toBe('from-export');
  });

  it('a unit with no equipment or no carrier needs setup', () => {
    expect(unitTag(null)).toBe('needs-setup');
    expect(unitTag(undefined)).toBe('needs-setup');
    const noEq = lteSettings('ant-a1');
    delete noEq.equipment;
    expect(unitTag(noEq)).toBe('needs-setup');
    expect(unitTag(lteSettings('ant-a1', { carriers: [] }))).toBe('needs-setup');
  });

  it('a unit takes the weaker of its equipment and carrier origins', () => {
    expect(unitTag(set())).toBe('edited');
    expect(unitTag(set(by('ai'), by('ai')))).toBe('ai');
    expect(unitTag(set(by('ai'), by('ai', 'low')))).toBe('ai-low');
    expect(unitTag(set(by('rules'), by('ai')))).toBe('rules');
    expect(unitTag(set(by('rules', 'low'), by('rules', 'low')))).toBe('ai-low');
    expect(unitTag(set(by('export'), undefined))).toBe('from-export');
    expect(unitTag(set(by('ai'), by('export')))).toBe('ai');
  });

  it('a group takes the weakest unit: needs setup > ai-low > rules > ai > from export > edited', () => {
    const ai = set(by('ai'), by('ai'));
    const low = set(by('ai', 'low'), by('ai'));
    const rules = set(by('rules'), by('rules'));
    const exp = set(by('export'), by('export'));
    const user = set();
    expect(groupTag([ai, low, rules])).toBe('ai-low');
    expect(groupTag([ai, rules, exp])).toBe('rules');
    expect(groupTag([ai, exp, user])).toBe('ai');
    expect(groupTag([exp, user])).toBe('from-export');
    expect(groupTag([user, user])).toBe('edited');
    expect(groupTag([ai, null])).toBe('needs-setup');
    expect(groupTag([])).toBe('needs-setup');
  });
});
