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
      deletePassword: () => store.delete(k),
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

describe('map keys', () => {
  it('keeps map keys in their own accounts, apart from the AI providers', async () => {
    const b = memoryBackend();
    const vault = createKeyVault('ai.example.app', b.entry);
    expect(await vault.setMapKey('mapbox', '  pk.abc-123456  ')).toEqual({ ok: true });
    expect(b.store.get('ai.example.app/map:mapbox')).toBe('pk.abc-123456');
    expect(await vault.hasMapKey('mapbox')).toBe(true);
    expect(await vault.hasMapKey('esri')).toBe(false);
    expect(await vault.getMapKey('mapbox')).toBe('pk.abc-123456');
    // an AI provider of the same name would never see it
    expect([...b.store.keys()]).toEqual(['ai.example.app/map:mapbox']);
  });

  it('removes a map key, also from a vault that cannot delete', async () => {
    const b = memoryBackend();
    const vault = createKeyVault('svc', b.entry);
    await vault.setMapKey('esri', 'AAPTkey-0123456789');
    expect(await vault.clearMapKey('esri')).toEqual({ ok: true });
    expect(await vault.hasMapKey('esri')).toBe(false);

    const store = new Map<string, string>();
    const noDelete = createKeyVault('svc', (s, a) => ({
      setPassword: (p) => {
        store.set(`${s}/${a}`, p);
      },
      getPassword: () => store.get(`${s}/${a}`) ?? null,
    }));
    await noDelete.setMapKey('esri', 'AAPTkey-0123456789');
    expect(await noDelete.clearMapKey('esri')).toEqual({ ok: true });
    expect(await noDelete.getMapKey('esri')).toBeNull();
  });

  it('a vault that refuses to delete reports it without the key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const vault = createKeyVault('svc', () => ({
      setPassword: () => {
        throw new Error('vault locked');
      },
      getPassword: () => 'pk.still-here-123',
      deletePassword: () => {
        throw new Error('vault locked');
      },
    }));
    expect(await vault.clearMapKey('mapbox')).toEqual({ ok: false });
    expect(warn.mock.calls.flat().join(' ')).not.toContain('pk.still-here');
    warn.mockRestore();
  });
});
