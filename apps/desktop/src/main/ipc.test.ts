import { describe, expect, it, vi } from 'vitest';
import { validated } from './ipc';

describe('validated IPC handlers', () => {
  it('rejects an invalid request before the handler runs', async () => {
    const handler = vi.fn(() => ({ ok: true as const, entry: undefined as never }));
    const wrapped = validated('library:add', handler);
    await expect(wrapped({ path: 'x', extra: true })).rejects.toThrow(
      'Invalid request on library:add',
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes a valid request and validates the response', async () => {
    const wrapped = validated('app:getInfo', () => ({
      name: 'Stratlas',
      version: '0.1.0',
      platform: 'win32',
    }));
    await expect(wrapped({})).resolves.toEqual({
      name: 'Stratlas',
      version: '0.1.0',
      platform: 'win32',
    });
  });

  it('refuses a handler response that breaks the contract', async () => {
    const wrapped = validated('ai:hasKey', () => ({ present: 'yes' }) as never);
    await expect(wrapped({ provider: 'anthropic' })).rejects.toThrow();
  });
});
