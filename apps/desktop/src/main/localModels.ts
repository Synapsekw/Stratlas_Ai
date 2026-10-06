/**
 * The person's own local model server (M8 stream C7, AI-9; decision 1: nothing bundled): discovery
 * (`ai:localModels`) and the capability probe (`ai:localProbe`). Both run only on the person's
 * click in Settings. A server on this machine is always allowed; an address on another machine
 * sends data off this one, so it is refused unless cloud AI is allowed (the existing rule for a
 * non-loopback "local" model). The optional server key comes from the OS vault and is never
 * logged or returned.
 */
import { DEFAULT_LOCAL_MODEL, isLoopbackUrl } from '@aio/ai/routes';
import { discoverLocalModels, localProvider, probeLocalModel } from '@aio/ai/main';
import type { LocalModelSettings } from '@aio/schema';
import type { Handle } from './notYet';

/** Wait for the first answer when Settings has no time set (a model may need to load). */
const PROBE_TIMEOUT_MS = 120_000;

export interface LocalModelsIpcDeps {
  handle: Handle;
  /** The local model entry of Settings (its address is the default). */
  localModel?: () => LocalModelSettings | undefined;
  /** Cloud AI is allowed now: only then may a server on another machine be reached. */
  cloudAllowed?: () => boolean;
  /** The optional server key (vault account `local`), or null. Never logged. */
  getKey?: () => Promise<string | null>;
  /** Replaces the network for tests. */
  fetch?: typeof globalThis.fetch;
  /** Told the server kind and version each time discovery reaches a server (diagnostics). */
  remember?: (server: LocalServerSeen) => void;
}

/** The last server discovery reached in this run: its kind and version, never its address. */
export interface LocalServerSeen {
  kind: 'ollama' | 'openai-compatible';
  /** Ollama reports its version; OpenAI-compatible servers do not. */
  version?: string;
  /** The server was on this machine. */
  loopback: boolean;
  at: string;
}

function remoteRefused(url: string): string {
  let where = url;
  try {
    where = new URL(url).origin;
  } catch {
    // keep the address as typed
  }
  return `${where} is on another machine, so data would leave this one. Turn on cloud AI in Settings, Privacy, to use it.`;
}

export function registerLocalModelsIpc(deps: LocalModelsIpcDeps): void {
  const { handle } = deps;
  const fetch = deps.fetch ?? globalThis.fetch;

  /** The address to use, or the refusal for one on another machine. */
  function address(baseUrl: string | undefined): { url: string } | { error: string } {
    const url = baseUrl ?? deps.localModel?.()?.baseUrl ?? DEFAULT_LOCAL_MODEL.baseUrl;
    if (!isLoopbackUrl(url) && !(deps.cloudAllowed?.() ?? false)) {
      return { error: remoteRefused(url) };
    }
    return { url };
  }

  const key = async () => (await deps.getKey?.()) ?? null;

  /** Discovery, telling `remember` which kind of server answered (no address, no models). */
  async function discover(url: string, k: string | null) {
    const r = await discoverLocalModels({ baseUrl: url, key: k, fetch });
    if (r.ok)
      deps.remember?.({
        kind: r.server.kind,
        ...(r.server.version ? { version: r.server.version } : {}),
        loopback: isLoopbackUrl(url),
        at: new Date().toISOString(),
      });
    return r;
  }

  handle('ai:localModels', async ({ baseUrl }) => {
    const a = address(baseUrl);
    if ('error' in a) return { ok: false, error: a.error };
    return discover(a.url, await key());
  });

  handle('ai:localProbe', async ({ model, baseUrl }) => {
    const a = address(baseUrl);
    if ('error' in a) return { ok: false, error: a.error };
    const k = await key();
    // What the server claims (vision, context) decides whether the image request is worth it.
    const listed = await discover(a.url, k);
    const info = listed.ok ? listed.models.find((m) => m.id === model) : undefined;
    const r = await probeLocalModel({
      model: localProvider({ baseUrl: a.url }, { fetch }).languageModel(model, k),
      claimsVision: info?.vision,
      timeoutMs: deps.localModel?.()?.timeoutMs ?? PROBE_TIMEOUT_MS,
    });
    if (!r.ok) return r;
    return info?.contextTokens ? { ...r, contextTokens: info.contextTokens } : r;
  });
}
