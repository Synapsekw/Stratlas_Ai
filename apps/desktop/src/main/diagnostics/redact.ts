import { isLoopbackUrl } from '@aio/ai/routes';
import type { Settings, TeamSettings } from '@aio/schema';

/**
 * Redaction for everything that leaves the app in a diagnostics bundle or lands in a log file.
 *
 * Two layers:
 * - Settings go through an allow-list (`SETTINGS_RULES`): every field has an explicit rule and a
 *   field without one is dropped, so a new secret-bearing setting can never leak by default.
 * - Free text (log lines, error messages, GPU strings, the person's problem description) is
 *   scrubbed for credential shapes, `key=value` pairs with secret-like names, URL credentials,
 *   workspace IDs (partly masked) and every secret value the app has seen this session.
 */

export const REDACTED = '[redacted]';

/**
 * Names whose values are secrets wherever they appear (JSON keys, query parameters, headers):
 * anything ending in key, token, secret, password and the like (`apiKey`, `x-api-key`,
 * `refresh_token`, `clientSecret`), plus a few short forms. Over-matching only hides a value.
 */
const SECRET_SUFFIX =
  /(?:key|token|secret|password|passwd|passphrase|credentials?|authorization|cookie|signature)$/i;
const SECRET_EXACT = /^(?:pass|pwd|auth|sig|session[-_]?id)$/i;
/** Workspace IDs are partly masked, not removed. */
const WORKSPACE_NAME = /workspace[-_]?id$/i;
/** A value `maskId` already produced. */
const MASKED = /^[^*]{0,4}\*+[^*]{0,2}$/;

/** True when an object key, header or query parameter name holds a secret. */
export function isSecretName(name: string): boolean {
  const n = name.trim();
  return SECRET_SUFFIX.test(n) || SECRET_EXACT.test(n);
}

/** Values the app knows to be secrets (API keys read from the vault this session). */
const knownSecrets = new Set<string>();

/** Remember a secret value so it is replaced wherever it appears later, whatever its shape. */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 8) knownSecrets.add(value);
}

/** For tests. */
export function clearSecrets(): void {
  knownSecrets.clear();
}

/** Keep the first 4 and last 2 characters of an identifier: enough to compare, not to use. */
export function maskId(id: string): string {
  if (id.length <= 8) return '*'.repeat(id.length);
  return `${id.slice(0, 4)}${'*'.repeat(Math.min(id.length - 6, 12))}${id.slice(-2)}`;
}

/** Credential shapes of the providers and services the app talks to, and generic token forms. */
const TOKEN_PATTERNS: RegExp[] = [
  // Anthropic and OpenAI style keys (sk-ant-..., sk-proj-..., sk-...)
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  // Google API keys
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  // GitHub tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Slack tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // JSON Web Tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // PEM private keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** `Authorization: Bearer x`, `Bearer x`, `Basic x`. */
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi;

/** `name=value`, `name: value`, `"name":"value"`, `name="value"` with a secret-like name. */
const PAIR = /(["']?)([A-Za-z][\w-]{1,40})\1(\s*[:=]\s*)/g;

/** `scheme://user:password@host` */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

/** Anthropic workspace IDs: partly masked so support can still match them. */
const WORKSPACE_ID = /\bwrkspc_[A-Za-z0-9]{4,}/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Scrub one piece of free text. Safe to run more than once. */
export function redactText(text: string): string {
  let out = text;
  for (const secret of knownSecrets) {
    out = out.replace(new RegExp(escapeRe(secret), 'g'), REDACTED);
  }
  for (const re of TOKEN_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(AUTH_SCHEME, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(URL_USERINFO, (_m, scheme: string) => `${scheme}${REDACTED}@`);
  out = redactPairs(out);
  out = out.replace(WORKSPACE_ID, (id) => maskId(id));
  return out;
}

/** End of a value starting at `start`: a quoted string, or up to a separator. */
function valueEnd(text: string, start: number): { end: number; quote: string } {
  const q = text[start];
  if (q === '"' || q === "'") {
    let i = start + 1;
    while (i < text.length && text[i] !== q) i += text[i] === '\\' ? 2 : 1;
    return { end: Math.min(i + 1, text.length), quote: q };
  }
  let i = start;
  while (i < text.length && !/[\s,;&"'}\])]/.test(text[i] ?? ' ')) i++;
  return { end: i, quote: '' };
}

/**
 * Values of secret-named pairs: `name=value`, `name: value`, `"name":"value"`, `?name=value`.
 * Names are found without consuming their values, so `https://host/?token=x` is still seen.
 */
function redactPairs(text: string): string {
  let out = '';
  let from = 0;
  PAIR.lastIndex = 0;
  for (let m = PAIR.exec(text); m; m = PAIR.exec(text)) {
    const name = m[2] ?? '';
    const secret = isSecretName(name);
    if (!secret && !WORKSPACE_NAME.test(name)) continue;
    const start = m.index + m[0].length;
    if (text.startsWith(REDACTED, start) || text.startsWith(`"${REDACTED}"`, start)) continue;
    const { end, quote } = valueEnd(text, start);
    const raw = text.slice(start + quote.length, end - quote.length);
    if (raw === '' || (!secret && MASKED.test(raw))) continue;
    const shown = secret ? REDACTED : maskId(raw);
    out += `${text.slice(from, start)}${quote}${shown}${quote}`;
    from = end;
    PAIR.lastIndex = end;
  }
  return out + text.slice(from);
}

/** Home folders with the account name in them: `C:\Users\<name>`, `/Users/<name>`, `/home/<name>`. */
const USER_HOME = /\b([A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+)[^\\/\s"'<>|:*?]+/gi;
const POSIX_HOME = /(^|[\s"'=(:])(\/(?:Users|home)\/)[^/\s"'<>|:*?]+/g;

/** Replace the account name in home-folder paths with `[user]` (model cards, runtime errors). */
export function redactUserPaths(text: string): string {
  return text
    .replace(USER_HOME, (_m, head: string) => `${head}[user]`)
    .replace(POSIX_HOME, (_m, lead: string, head: string) => `${lead}${head}[user]`);
}

/**
 * Deep copy with secrets removed: values under secret-like keys become `[redacted]`, strings are
 * scrubbed with `redactText`. Cycles and very deep values are cut off.
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  }
  if (depth > 12 || seen.has(value)) return '[cut]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSecretName(k)
      ? REDACTED
      : WORKSPACE_NAME.test(k) && typeof v === 'string' && v
        ? maskId(v)
        : redactValue(v, depth + 1, seen);
  }
  return out;
}

/** How one settings field appears in a bundle. */
type Rule =
  /** As is (strings still scrubbed). */
  | 'keep'
  /** Only whether it is set. */
  | 'presence'
  /** First and last characters only. */
  | 'mask'
  /** Scheme, host and path; no credentials, query or fragment. */
  | 'url'
  /** As `url` for an address on this machine; another machine's address is hidden. */
  | 'localUrl'
  /** The last folder name of a path only (no drive, no user name). */
  | 'folder'
  | { fields: Record<string, Rule> };

/**
 * The allow-list. `satisfies Record<keyof Settings, Rule>` makes a new settings field a type error
 * here until someone decides how it appears in a diagnostics bundle.
 */
export const SETTINGS_RULES = {
  cloudAi: 'keep',
  theme: 'keep',
  sidebarCollapsed: 'keep',
  dataRoot: 'keep',
  routes: 'keep',
  localModel: {
    fields: {
      enabled: 'keep',
      baseUrl: 'localUrl',
      model: 'keep',
      kind: 'keep',
      contextTokens: 'keep',
      toolProfile: 'keep',
      capabilities: 'keep',
      timeoutMs: 'keep',
    },
  },
  direction: 'keep',
  contrast: 'keep',
  motion: 'keep',
  offlineOnly: 'keep',
  updateCheck: 'keep',
  updateUrl: 'url',
  anthropicWorkspaceId: 'mask',
  reportBranding: { fields: { companyName: 'presence', accent: 'keep', logo: 'presence' } },
  reportContents: 'keep',
  change: 'keep',
  inference: { fields: { modelsDir: 'folder', provider: 'keep', memoryCapMb: 'keep' } },
  // M9: sync preferences only. Device keys, server enrolment and invite codes live in the vault
  // and never in settings; a field added to `team` stays out of bundles until listed here.
  team: {
    fields: {
      autoSync: 'keep',
      intervalMin: 'keep',
      blobCacheGb: 'keep',
    } satisfies Record<keyof TeamSettings, Rule>,
  },
  launchScreen: 'keep',
} as const satisfies Record<keyof Settings, Rule>;

function safeUrl(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return value;
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return REDACTED;
  }
}

/** Shown instead of a local model server address on another machine. */
export const OTHER_MACHINE = 'another machine (address hidden)';

function localUrl(value: unknown): unknown {
  if (typeof value !== 'string' || value === '') return value;
  return isLoopbackUrl(value) ? safeUrl(value) : OTHER_MACHINE;
}

function lastFolder(value: unknown): unknown {
  if (typeof value !== 'string' || value.trim() === '') return value;
  const parts = value.split(/[\\/]+/).filter((p) => p !== '' && !/^[A-Za-z]:$/.test(p));
  return redactText(parts.at(-1) ?? '');
}

function applyRule(rule: Rule, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (rule === 'keep') return redactValue(value);
  if (rule === 'presence') return value === '' || value === null ? 'not set' : 'set';
  if (rule === 'mask') return typeof value === 'string' && value ? maskId(value) : value;
  if (rule === 'url') return safeUrl(value);
  if (rule === 'localUrl') return localUrl(value);
  if (rule === 'folder') return lastFolder(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return REDACTED;
  return pick(rule.fields, value as Record<string, unknown>);
}

function pick(rules: Record<string, Rule>, obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const rule = Object.prototype.hasOwnProperty.call(rules, k) ? rules[k] : undefined;
    if (rule === undefined) dropped.push(k);
    else {
      const r = applyRule(rule, v);
      if (r !== undefined) out[k] = r;
    }
  }
  // Names only, so support can see that a field exists without its value.
  if (dropped.length > 0) out._omitted = dropped.map((n) => redactText(n)).sort();
  return out;
}

/** Settings as they go into a diagnostics bundle: allow-listed fields only. */
export function redactSettings(settings: unknown): Record<string, unknown> {
  if (settings === null || typeof settings !== 'object') return {};
  return pick(SETTINGS_RULES, settings as Record<string, unknown>);
}
