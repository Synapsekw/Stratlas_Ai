import type { AiProvider } from '@aio/schema';

/** The slice of `@napi-rs/keyring` Entry the vault uses (injectable for tests). */
export interface KeyEntry {
  setPassword(password: string): void;
  getPassword(): string | null;
}

export interface KeyVault {
  setKey(provider: AiProvider, key: string): Promise<{ ok: boolean }>;
  hasKey(provider: AiProvider): Promise<boolean>;
  /** Main process only: never send the result to the renderer or a log. */
  getKey(provider: AiProvider): Promise<string | null>;
}

/**
 * API keys in the OS credential vault (Windows Credential Manager, macOS Keychain, Secret
 * Service): service = brand app id, account = provider. Errors are logged without the key.
 */
export function createKeyVault(
  service: string,
  entry: (service: string, account: string) => KeyEntry,
): KeyVault {
  function read(provider: AiProvider): string | null {
    try {
      const v = entry(service, provider).getPassword();
      return v === null || v === '' ? null : v;
    } catch (e) {
      console.warn(`Key vault: could not read the ${provider} key (${errorName(e)}).`);
      return null;
    }
  }
  return {
    setKey(provider, key) {
      try {
        entry(service, provider).setPassword(key.trim());
        return Promise.resolve({ ok: true });
      } catch (e) {
        console.warn(`Key vault: could not store the ${provider} key (${errorName(e)}).`);
        return Promise.resolve({ ok: false });
      }
    },
    hasKey: (provider) => Promise.resolve(read(provider) !== null),
    getKey: (provider) => Promise.resolve(read(provider)),
  };
}

/** Error class and message only; OS vault messages never contain the secret. */
function errorName(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error';
}
