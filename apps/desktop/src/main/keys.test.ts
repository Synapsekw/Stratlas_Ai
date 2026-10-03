import { describe, expect, it, vi } from 'vitest';
import { createKeyVault, type KeyEntry } from './keys';

/** In-memory stand-in for the OS credential vault. */
function memoryBackend() {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const entry = (service: string, account: string): KeyEntry => {
    const k = `${service}/${account}`;
    calls.push(k);
    return {
      setPassword: (p) => {
        store.set(k, p);
      },
      getPassword: () => store.get(k) ?? null,
    };
  };
  return { store, calls, entry };
}

describe('key vault', () => {
  it('stores a key under service = app id and account = provider', async () => {
    const b = memoryBackend();
    const vault = createKeyVault('ai.example.app', b.entry);
    expect(await vault.setKey('anthropic', '  sk-ant-123456  ')).toEqual({ ok: true });
    expect(b.store.get('ai.example.app/anthropic')).toBe('sk-ant-123456');
    expect(await vault.hasKey('anthropic')).toBe(true);
    expect(await vault.hasKey('openai')).toBe(false);
    expect(await vault.getKey('anthropic')).toBe('sk-ant-123456');
  });

  it('reports failure without leaking the key when the OS vault refuses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const vault = createKeyVault('svc', () => ({
      setPassword: () => {
        throw new Error('vault locked');
      },
      getPassword: () => {
        throw new Error('vault locked');
      },
    }));
    expect(await vault.setKey('openai', 'sk-secret-999')).toEqual({ ok: false });
    expect(await vault.hasKey('openai')).toBe(false);
    expect(await vault.getKey('openai')).toBeNull();
    const logged = warn.mock.calls.flat().map(String).join(' ');
    expect(logged).not.toContain('sk-secret-999');
    warn.mockRestore();
  });
});
