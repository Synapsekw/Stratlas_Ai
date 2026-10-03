import { describe, expect, it } from 'vitest';
import { defaultRoutes, PROVIDERS, routeFor } from './index';

describe('model routing', () => {
  it('covers every task by default', () => {
    for (const t of ['chat', 'vision', 'report', 'extract', 'build'] as const) {
      expect(routeFor(defaultRoutes(), t).task).toBe(t);
    }
  });

  it('only uses known providers', () => {
    for (const r of defaultRoutes()) expect(PROVIDERS).toContain(r.provider);
  });

  it('explains a missing route', () => {
    expect(() => routeFor([], 'chat')).toThrow('Choose one in Settings');
  });
});
