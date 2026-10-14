import type { AiProvider, MapKeyProvider } from '@aio/schema';

/** The slice of `@napi-rs/keyring` Entry the vault uses (injectable for tests). */
export interface KeyEntry {
  setPassword(password: string): void;
  getPassword(): string | null;
  /** Remove the entry (`Entry.deletePassword`); a backend without it gets an empty password. */
  deletePassword?(): boolean;
}

export interface KeyVault {
  setKey(provider: AiProvider, key: string): Promise<{ ok: boolean }>;
  hasKey(provider: AiProvider): Promise<boolean>;
  /** Main process only: never send the result to the renderer or a log. */
  getKey(provider: AiProvider): Promise<string | null>;
  /** Map keys (ADR 0007, amendment of 14 Oct 2026): accounts `map:esri`, `map:mapbox`. */
  setMapKey(provider: MapKeyProvider, key: string): Promise<{ ok: boolean }>;
  hasMapKey(provider: MapKeyProvider): Promise<boolean>;
  /** Main process only: never send the result to the renderer or a log. */
  getMapKey(provider: MapKeyProvider): Promise<string | null>;
  clearMapKey(provider: MapKeyProvider): Promise<{ ok: boolean }>;
}

const mapAccount = (provider: MapKeyProvider) => `map:${provider}`;

/**
 * API keys in the OS credential vault (Windows Credential Manager, macOS Keychain, Secret
 * Service): service = brand app id, account = provider (`map:<provider>` for map keys, a set of
 * its own beside the AI providers). Errors are logged without the key.
 */
export function createKeyVault(
  service: string,
  entry: (service: string, account: string) => KeyEntry,
): KeyVault {
  function read(account: string): string | null {
    try {
      const v = entry(service, account).getPassword();
      return v === null || v === '' ? null : v;
    } catch (e) {
      console.warn(`Key vault: could not read the ${account} key (${errorName(e)}).`);
      return null;
    }
  }
  function write(account: string, key: string): { ok: boolean } {
    try {
      entry(service, account).setPassword(key.trim());
      return { ok: true };
    } catch (e) {
      console.warn(`Key vault: could not store the ${account} key (${errorName(e)}).`);
      return { ok: false };
    }
  }
  function remove(account: string): { ok: boolean } {
    const e = entry(service, account);
    try {
      e.deletePassword?.();
    } catch {
      // no entry to delete, or a backend that refuses: the empty password below decides
    }
    if (read(account) === null) return { ok: true };
    try {
      e.setPassword('');
    } catch (err) {
      console.warn(`Key vault: could not remove the ${account} key (${errorName(err)}).`);
    }
    return { ok: read(account) === null };
  }
  return {
    setKey: (provider, key) => Promise.resolve(write(provider, key)),
    hasKey: (provider) => Promise.resolve(read(provider) !== null),
    getKey: (provider) => Promise.resolve(read(provider)),
    setMapKey: (provider, key) => Promise.resolve(write(mapAccount(provider), key)),
    hasMapKey: (provider) => Promise.resolve(read(mapAccount(provider)) !== null),
    getMapKey: (provider) => Promise.resolve(read(mapAccount(provider))),
    clearMapKey: (provider) => Promise.resolve(remove(mapAccount(provider))),
  };
}

/** Error class and message only; OS vault messages never contain the secret. */
function errorName(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error';
}
