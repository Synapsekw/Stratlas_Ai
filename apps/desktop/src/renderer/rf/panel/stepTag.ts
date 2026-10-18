/**
 * The state tag of a step 2 row (a sector, or the units in no sector): who set its equipment and
 * carriers. A group takes the weakest tag of its units, a unit the weakest of its equipment and
 * carrier origins, in the order `needs-setup` > `ai-low` > `rules` > `ai` > `from-export` >
 * `edited`. A missing origin means the person set it (`edited`); a unit with no settings, no
 * equipment or no carrier needs setup.
 */
import { originOf, type RfAntennaSettings, type RfOrigin } from '@aio/schema';

export type StepTag = 'needs-setup' | 'ai-low' | 'rules' | 'ai' | 'from-export' | 'edited';

/** Weakest first. */
export const STEP_TAGS: readonly StepTag[] = [
  'needs-setup',
  'ai-low',
  'rules',
  'ai',
  'from-export',
  'edited',
];

const weaker = (a: StepTag, b: StepTag): StepTag =>
  STEP_TAGS.indexOf(a) <= STEP_TAGS.indexOf(b) ? a : b;

export function originTag(o: RfOrigin | undefined): StepTag {
  switch (originOf(o)) {
    case 'ai':
      return o?.confidence === 'low' ? 'ai-low' : 'ai';
    case 'rules':
      return 'rules';
    case 'export':
      return 'from-export';
    case 'user':
      return 'edited';
  }
}

export function unitTag(s: RfAntennaSettings | null | undefined): StepTag {
  if (!s?.equipment || s.carriers.length === 0) return 'needs-setup';
  return s.carriers.reduce<StepTag>(
    (tag, c) => weaker(tag, originTag(c.origin)),
    originTag(s.origins?.equipment),
  );
}

/** The tag of a group of units; an empty group needs setup. */
export function groupTag(settings: readonly (RfAntennaSettings | null | undefined)[]): StepTag {
  if (settings.length === 0) return 'needs-setup';
  return settings.map(unitTag).reduce(weaker);
}
