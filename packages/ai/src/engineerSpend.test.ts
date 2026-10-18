import { describe, expect, it } from 'vitest';
import { runLimits, TOKENS_PER_PASS } from './engineerSpend';

describe('engineering tool and repair allowance', () => {
  it('covers three bounded steps plus one repair per pass without removing the token ceiling', () => {
    expect(runLimits('detailed', true).calls).toBe(3 * 2 * 3);
    expect(runLimits('detailed').tokens).toBe(3 * TOKENS_PER_PASS);
    expect(runLimits('fast', true).calls).toBe(2 * 3);
    expect(runLimits('detailed').calls).toBe(3 * 2);
  });
});
