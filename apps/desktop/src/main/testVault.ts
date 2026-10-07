/**
 * TEST-ONLY key vault for automated runs (M9 integration, finding 5).
 *
 * End-to-end tests start many app instances, each with a throwaway userData folder. With the OS
 * vault they would leave a device key per run in Windows Credential Manager or the macOS Keychain
 * (`<appId>.isolated[.profile.<name>]`, account `device-signing`). When the test runner sets
 * `STRATLAS_TEST_VAULT=1` together with an isolated profile (`STRATLAS_USER_DATA`), keys are kept
 * in `<userData>/TEST-ONLY-vault.json` instead: deleted with the test's folder, never read in a
 * person's normal run, and never touching another vault entry.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { KeyEntry } from './keys';

export const TEST_VAULT_FILE = 'TEST-ONLY-vault.json';

/** True only for automated runs on an isolated profile. */
export function useTestVault(env: Record<string, string | undefined>): boolean {
  return env.STRATLAS_TEST_VAULT === '1' && Boolean(env.STRATLAS_USER_DATA);
}

/** A `KeyEntry` factory over one JSON file (service and account as the key). */
export function createTestVault(userData: string): (service: string, account: string) => KeyEntry {
  const file = join(userData, TEST_VAULT_FILE);
  const load = (): Record<string, string> => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const values = (parsed as { values?: unknown }).values;
      return values && typeof values === 'object' ? (values as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const save = (values: Record<string, string>) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ note: 'TEST-ONLY keys of an automated run. Never a real vault.', values }, null, 2)}\n`,
    );
    renameSync(tmp, file);
  };
  return (service, account) => {
    const key = `${service}/${account}`;
    return {
      getPassword: () => load()[key] ?? null,
      setPassword: (value: string) => {
        save({ ...load(), [key]: value });
      },
    };
  };
}
