/**
 * The app's own environment variables are `QUADRION_*`. Until the rename on 7 Oct 2026 they were
 * `STRATLAS_*`; the old names keep working, so shells, scripts and CI set up before the rename
 * need no change. The new name always wins when both are set.
 *
 * No Node import: the renderer bundles `@aio/brand` too, so callers pass their `process.env`.
 */
export const ENV_PREFIX = 'QUADRION_';
export const LEGACY_ENV_PREFIX = 'STRATLAS_';

type Env = Record<string, string | undefined>;

/** `QUADRION_<name>`, else the legacy `STRATLAS_<name>`. `name` has no prefix (`'DATA'`). */
export function envVar(env: Env, name: string): string | undefined {
  return env[ENV_PREFIX + name] ?? env[LEGACY_ENV_PREFIX + name];
}

/**
 * Copy every `STRATLAS_<name>` onto `QUADRION_<name>` where that is unset, in place, so code that
 * reads only the new names sees the old ones too. Returns the names it copied (without prefix).
 */
export function aliasLegacyEnv(env: Env): string[] {
  const copied: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    const name = key.slice(LEGACY_ENV_PREFIX.length);
    if (env[ENV_PREFIX + name] !== undefined) continue;
    env[ENV_PREFIX + name] = value;
    copied.push(name);
  }
  return copied;
}
