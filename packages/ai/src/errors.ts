/**
 * Provider errors for people and for the log. The provider's own error text is the most useful
 * thing to show ("model: claude-x not found", "this key is not scoped to a workspace"), so it is
 * kept, after removing anything that looks like a key and cutting it to a short length. Main
 * process only.
 */
import { APICallError, RetryError } from 'ai';

export interface ErrorContext {
  /** Provider display name, e.g. "Anthropic". */
  label: string;
  /** Model id of the request, for "model not found". */
  model?: string;
  /** Values that must never appear in a message or log line (the API key). */
  secrets?: readonly (string | null | undefined)[];
}

export interface DescribedError {
  /** For the person: names the provider and quotes its error. */
  message: string;
  /** For the log: error class, HTTP status, provider error type and the same sanitised text. */
  log: string;
  status?: number;
}

const MAX_DETAIL = 400;

/** Patterns of API keys and bearer tokens of the providers we talk to. */
const KEY_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{6,}/g,
  /\bAIza[0-9A-Za-z_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /("?(?:x-api-key|x-goog-api-key|api[_-]?key|authorization)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
];

/**
 * Remove keys (the known secret and anything shaped like one), dashes the UI does not use, extra
 * whitespace, and cut to a readable length.
 */
export function sanitize(text: string, secrets: ErrorContext['secrets'] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('[key]');
  }
  for (const re of KEY_PATTERNS) {
    out = out.replace(re, (match, prefix: unknown) =>
      typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[key]` : '[key]',
    );
  }
  out = out.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  return out.length > MAX_DETAIL ? `${out.slice(0, MAX_DETAIL - 3).trimEnd()}...` : out;
}

function unwrap(e: unknown): unknown {
  return RetryError.isInstance(e) ? e.lastError : e;
}

interface ProviderBody {
  message?: string;
  type?: string;
}

/** `{ error: { message, type | status | code } }` is the error shape of all three providers. */
function bodyError(value: unknown): ProviderBody | null {
  if (typeof value !== 'object' || value === null) return null;
  const err = (value as { error?: unknown }).error;
  if (typeof err === 'string') return { message: err };
  if (typeof err !== 'object' || err === null) return null;
  const { message, type, status, code } = err as Record<string, unknown>;
  const kind = [type, status, code].find((v) => typeof v === 'string');
  return {
    ...(typeof message === 'string' ? { message } : {}),
    ...(typeof kind === 'string' ? { type: kind } : {}),
  };
}

function parseBody(body: string | undefined): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** The provider's error text and type from an API call error. */
function providerError(e: APICallError): { message: string; type?: string } {
  const fromData = bodyError(e.data);
  const fromBody = fromData?.message ? fromData : bodyError(parseBody(e.responseBody));
  const message = fromBody?.message ?? fromData?.message ?? e.message;
  const type = fromBody?.type ?? fromData?.type;
  return { message, ...(type ? { type } : {}) };
}

/** Cannot reach the provider at all (DNS, refused, reset, timed out). */
export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code =
    (e as { code?: unknown; cause?: { code?: unknown } }).code ??
    (e as { cause?: { code?: unknown } }).cause?.code;
  if (
    typeof code === 'string' &&
    /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR)/.test(code)
  )
    return true;
  return e instanceof TypeError && /fetch failed|network/i.test(e.message);
}

const SETTINGS = 'Settings, AI providers';

/** End a sentence with one full stop. */
const stop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** Hints for errors a person can fix in Settings. */
function hint(status: number, detail: string): string {
  if (/workspace/i.test(detail)) {
    return `Enter the workspace ID under Anthropic in ${SETTINGS}, or use an API key that belongs to a workspace.`;
  }
  if (status === 401 || status === 403) return `Check the key in ${SETTINGS}.`;
  if (status === 404) return `Choose another model in ${SETTINGS}.`;
  if (status === 429 || status === 529) return 'Wait a moment and try again.';
  if (status >= 500) return 'Try again in a moment.';
  if (/model/i.test(detail)) return `Check the model in ${SETTINGS}.`;
  return `If it keeps happening, start a new conversation or choose another model in ${SETTINGS}.`;
}

/** A provider or agent failure as a message for the panel and a line for the log. */
export function describeError(err: unknown, ctx: ErrorContext): DescribedError {
  const e = unwrap(err);
  const { label } = ctx;
  if (APICallError.isInstance(e)) {
    const status = e.statusCode;
    const { message, type } = providerError(e);
    const detail = sanitize(message, ctx.secrets);
    const where = ctx.model ? ` ${ctx.model}` : '';
    const log = `APICallError ${status ?? 'no status'}${type ? ` ${type}` : ''} (${label}${where}): ${detail}`;
    if (status === undefined) {
      return {
        message: `Cannot reach ${label}: ${stop(detail)} Check the internet connection, or keep working offline.`,
        log,
      };
    }
    let body: string;
    if (status === 404 || type === 'not_found_error') {
      const lead = `${label}: model not found${ctx.model ? `: ${ctx.model}` : ''}`;
      // "model: claude-x" only repeats the id; other texts (a wrong address) are worth showing.
      const repeats = !detail || (ctx.model !== undefined && detail.includes(ctx.model));
      body = repeats ? stop(lead) : `${stop(lead)} ${stop(detail)}`;
    } else {
      let lead: string;
      if (status === 401 || status === 403) lead = `${label} did not accept the API key`;
      else if (status === 429 || status === 529) lead = `${label} is busy or rate limited`;
      else if (status >= 500) lead = `${label} had a server error`;
      else lead = label;
      body = detail ? `${lead}: ${stop(detail)}` : stop(lead);
    }
    return { message: `${body} (HTTP ${status}) ${hint(status, detail)}`, log, status };
  }
  if (isNetworkError(e)) {
    return {
      message: `Cannot reach ${label}. Check the internet connection, or keep working offline.`,
      log: `network error (${label}): ${e instanceof Error ? sanitize(e.message, ctx.secrets) : ''}`,
    };
  }
  const name = e instanceof Error ? e.name : typeof e;
  const detail = e instanceof Error ? sanitize(e.message, ctx.secrets) : '';
  return {
    message: `Something went wrong in the agent${detail ? `: ${stop(detail)}` : '.'} Try again.`,
    log: `${name} (${label}): ${detail}`,
  };
}
