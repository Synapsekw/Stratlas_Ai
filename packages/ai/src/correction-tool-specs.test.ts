import { describe, expect, it } from 'vitest';
import { approvalFor, getToolSpec, riskOf } from './tools';

describe('model correction proposal tools', () => {
  it('offers a bounded request reader and a proposal writer, never an approval tool', () => {
    expect(getToolSpec('list_model_corrections')).toBeDefined();
    expect(riskOf('list_model_corrections')).toBe('read');
    expect(getToolSpec('propose_model_correction')).toBeDefined();
    expect(approvalFor('propose_model_correction')).toBe(true);
    expect(getToolSpec('accept_model_correction')).toBeUndefined();
  });
  it('refuses an empty proposal or an attempt to replace the model frame', () => {
    const schema = getToolSpec('propose_model_correction')?.input;
    expect(schema).toBeDefined();
    expect(
      schema?.safeParse({ requestId: 'fix-1', proposal: { explanation: 'Change', patch: [] } })
        .success,
    ).toBe(false);
    expect(schema?.safeParse({ requestId: 'fix-1', georef: {}, proposal: {} }).success).toBe(false);
  });
  it('describes the model-wide target', () => {
    const propose = getToolSpec('propose_model_correction')?.meta.description ?? '';
    expect(propose).toContain('whole model');
    expect(propose).toContain('20');
    expect(getToolSpec('list_model_corrections')?.meta.description).toContain('model-wide');
  });
});
