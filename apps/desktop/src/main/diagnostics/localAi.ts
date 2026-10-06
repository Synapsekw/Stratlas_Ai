/**
 * `local-ai.json` of the diagnostics bundle (M8): the local detection runtime (onnxruntime-node,
 * C6), the installed detector model cards (`aio.detector/1`) and the person's local agent server
 * (C7). Built from what the app already knows: it never starts the inference process and never
 * calls the model server.
 *
 * Settings reach this section only through the allow-list (`redactSettings`), so a local model
 * server on another machine shows as "another machine", never by its address. Model cards keep
 * their id (the models folder name), never a path; author and description stay out (a person's
 * name, free text). No keys, prompts or model answers are known here to begin with.
 */
import { isOfflineAgent, type ModelRoute } from '@aio/ai/routes';
import type { DetectorModelInfo } from '@aio/schema';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { LocalServerSeen } from '../localModels';
import { redactSettings, redactText, redactUserPaths } from './redact';

/** What the inference host knows without asking (`InferenceHost.known`). */
export interface RuntimeKnown {
  running: boolean;
  probe: {
    available: boolean;
    provider?: string;
    version?: string;
    backends?: string[];
    problem?: string;
  } | null;
}

export interface LocalAiSources {
  /** The app settings as stored (they go through the allow-list here). */
  settings: unknown;
  /** The inference host's knowledge, or null when no host was made in this run. */
  runtime: RuntimeKnown | null;
  /** The onnxruntime-node package version the app ships, when it could be read. */
  packageVersion: string | null;
  /** The installed detector models (reads the model folders only). */
  models: () => Promise<DetectorModelInfo[]>;
  /** The last local model server discovery reached in this run. */
  server: LocalServerSeen | null;
}

/** Classes listed per model card; the rest are counted. */
const MAX_CLASSES = 100;

const PROVIDER_NAMES: Record<string, string> = {
  dml: 'DirectML (graphics card)',
  coreml: 'CoreML',
  cpu: 'CPU',
};

const scrub = (s: string) => redactUserPaths(redactText(s));

/** The version in a package's package.json, resolved from this module (null when absent). */
export function packageVersionOf(name: string, from: string = import.meta.url): string | null {
  try {
    const path = createRequire(from).resolve(`${name}/package.json`);
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** The runtime part: the package shipped, and what the last probe of this run said. */
export function runtimeSummary(
  runtime: RuntimeKnown | null,
  packageVersion: string | null,
  setting: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    package: 'onnxruntime-node',
    packageVersion: packageVersion ?? 'not found',
    providerSetting: typeof setting?.provider === 'string' ? setting.provider : 'auto',
    ...(typeof setting?.memoryCapMb === 'number' ? { memoryCapMb: setting.memoryCapMb } : {}),
  };
  const probe = runtime?.probe ?? null;
  if (!probe) {
    out.state = runtime?.running ? 'started, not probed yet' : 'not started';
    return out;
  }
  out.state = runtime?.running ? 'running' : 'stopped (last probe of this run below)';
  out.available = probe.available;
  if (probe.version) out.version = probe.version;
  if (probe.provider) {
    out.provider = probe.provider;
    out.providerName = PROVIDER_NAMES[probe.provider] ?? probe.provider;
  }
  if (probe.backends) out.backends = probe.backends;
  if (probe.problem) out.problem = scrub(probe.problem);
  return out;
}

/** One model card as it goes into the bundle. */
export function modelCardSummary(m: DetectorModelInfo): Record<string, unknown> {
  const c = m.card;
  return {
    id: m.id,
    where: m.where === 'pack' ? 'pipeline pack' : 'imported',
    name: scrub(c.name),
    version: scrub(c.version),
    layout: c.layout,
    input: `${String(c.input.width)}x${String(c.input.height)}`,
    classes: c.classes.slice(0, MAX_CLASSES),
    ...(c.classes.length > MAX_CLASSES ? { classCount: c.classes.length } : {}),
    licence: c.licence,
    source: scrub(c.source),
    sha256: c.sha256,
    sizeBytes: m.sizeBytes,
  };
}

const isRoute = (r: unknown): r is ModelRoute =>
  typeof r === 'object' && r !== null && 'task' in r && 'provider' in r;

/** The local agent part: server kind and version, where it is (this machine or not), the switch. */
export function localAgentSummary(
  safe: Record<string, unknown>,
  server: LocalServerSeen | null,
): Record<string, unknown> {
  const lm = (safe.localModel ?? {}) as Record<string, unknown>;
  const routes = Array.isArray(safe.routes) ? safe.routes.filter(isRoute) : [];
  const enabled = lm.enabled === true;
  const kind = typeof lm.kind === 'string' ? lm.kind : server?.kind;
  return {
    enabled,
    kind: kind ?? 'not found yet',
    serverVersion: server
      ? (server.version ?? 'not reported by this kind of server')
      : 'not probed in this run',
    ...(server ? { serverOnThisMachine: server.loopback, probedAt: server.at } : {}),
    ...(lm.baseUrl !== undefined ? { address: lm.baseUrl } : {}),
    ...(typeof lm.model === 'string' ? { model: lm.model } : {}),
    ...(lm.capabilities !== undefined ? { capabilities: lm.capabilities } : {}),
    offlineAgent: enabled && routes.length > 0 && isOfflineAgent(routes),
  };
}

/** The whole `local-ai.json`; a part that fails says why and the others still save. */
export async function localAiSection(src: LocalAiSources): Promise<Record<string, unknown>> {
  const safe = redactSettings(src.settings);
  const inference = (safe.inference ?? undefined) as Record<string, unknown> | undefined;
  let models: unknown;
  try {
    models = (await src.models()).map(modelCardSummary);
  } catch (e) {
    models = { error: scrub(e instanceof Error ? e.message : String(e)) };
  }
  return {
    onnxRuntime: runtimeSummary(src.runtime, src.packageVersion, inference),
    detectorModels: models,
    ...(inference?.modelsDir !== undefined ? { modelsFolder: inference.modelsDir } : {}),
    localAgent: localAgentSummary(safe, src.server),
  };
}
