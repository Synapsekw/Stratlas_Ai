import { describe, expect, it } from 'vitest';
import { CORRECTION_PROMPT_LEAD, correctionPrompt } from './correctionPrompt';

describe('correctionPrompt', () => {
  const text = correctionPrompt('{}');
  it('starts with the lead and ends with the submitted data', () => {
    expect(text.startsWith(CORRECTION_PROMPT_LEAD)).toBe(true);
    expect(text.endsWith('Submitted review data:\n{}')).toBe(true);
  });
  it('states the model-wide rules', () => {
    expect(text).toContain('at most 20 operations');
    expect(text).toContain('model units');
    expect(text).toContain('propose_model_correction');
  });
});
