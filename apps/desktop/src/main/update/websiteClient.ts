import { WebsiteUpdateCheck, type WebsiteArtifact } from '@aio/schema';
import { z } from 'zod';
export const WEBSITE_ORIGIN = 'https://quadrion.ai';
const Config = z.object({
  enabled: z.literal(true),
  url: z.string().regex(/^https:\/\/[a-z0-9]+\.supabase\.co$/),
  publishableKey: z.string().min(1).max(16000),
});
const Session = z.object({
  access_token: z.string().min(1).max(16000),
  refresh_token: z.string().min(1).max(16000),
});
const Member = z.object({
  email: z.email(),
  member: z.object({ status: z.literal('active') }),
  requiresMfa: z.literal(false),
});
const Grant = z
  .object({
    url: z.url().max(16000),
    filename: z.string(),
    bytes: z.number().int().positive(),
    sha256: z.string(),
    expiresIn: z.number().int().positive().max(300),
  })
  .strict();
export interface WebsiteClientDeps {
  allowed: () => boolean;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  vault: { read: () => string | null; write: (value: string | null) => void };
  secret?: (value: string) => void;
}
export function createWebsiteClient(d: WebsiteClientDeps) {
  let config: z.infer<typeof Config> | null = null;
  let access: string | null = null;
  function guard(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!d.allowed()) throw new Error('Website updates are paused.');
  }
  async function json(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
    guard(signal);
    const response = await d.fetch(url, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      redirect: 'error',
      credentials: 'omit',
    });
    guard(signal);
    if (!response.ok) throw new Error('The website request failed. Sign in or try again later.');
    const text = await response.text();
    guard(signal);
    if (text.length > 1_000_000) throw new Error('The website response is too large.');
    return JSON.parse(text) as unknown;
  }
  async function configuration(signal: AbortSignal) {
    config ??= Config.parse(await json(WEBSITE_ORIGIN + '/api/portal?action=config', {}, signal));
    return config;
  }
  async function member(signal: AbortSignal) {
    const result = Member.parse(
      await json(
        WEBSITE_ORIGIN + '/api/portal?action=me',
        { headers: { Authorization: 'Bearer ' + (access ?? ''), Origin: WEBSITE_ORIGIN } },
        signal,
      ),
    );
    return result.email;
  }
  async function authenticate(body: Record<string, string>, kind: string, signal: AbortSignal) {
    const cfg = await configuration(signal);
    const tokens = Session.parse(
      await json(
        cfg.url + '/auth/v1/token?grant_type=' + kind,
        {
          method: 'POST',
          headers: { apikey: cfg.publishableKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        signal,
      ),
    );
    guard(signal);
    d.secret?.(tokens.access_token);
    d.secret?.(tokens.refresh_token);
    try {
      d.vault.write(tokens.refresh_token);
    } catch {
      access = null;
      try {
        d.vault.write(null);
      } catch {
        /* Failed credential writes are never treated as a session. */
      }
      throw new Error('The website credential could not be saved in the OS vault. Sign in again.');
    }
    access = tokens.access_token;
    try {
      return await member(signal);
    } catch (e) {
      access = null;
      throw e;
    }
  }
  async function restore(signal: AbortSignal) {
    guard(signal);
    const refresh = d.vault.read();
    if (!refresh) return null;
    return authenticate({ refresh_token: refresh }, 'refresh_token', signal);
  }
  async function authorized(url: string, init: RequestInit, signal: AbortSignal) {
    guard(signal);
    if (!access) {
      if (!(await restore(signal))) throw new Error('Sign in to your website account.');
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', 'Bearer ' + (access ?? ''));
    headers.set('Origin', WEBSITE_ORIGIN);
    return json(
      url,
      {
        ...init,
        headers,
      },
      signal,
    );
  }
  return {
    restore,
    signIn: (email: string, password: string, signal: AbortSignal) => {
      d.secret?.(password);
      return authenticate({ email, password }, 'password', signal);
    },
    signOut() {
      access = null;
      d.vault.write(null);
    },
    forgetAccess() {
      access = null;
    },
    async check(appVersion: string, signal: AbortSignal, pipelineVersion?: string) {
      // A target app must carry independently verified kit metadata, even when versions match.
      const endpoint =
        WEBSITE_ORIGIN +
        '/api/portal?action=updates&platform=win-x64&appVersion=' +
        encodeURIComponent(appVersion);
      let result = WebsiteUpdateCheck.parse(
        await authorized(
          endpoint +
            (pipelineVersion ? '&pipelineVersion=' + encodeURIComponent(pipelineVersion) : ''),
          {},
          signal,
        ),
      );
      if (result.app && !result.pipeline)
        result = WebsiteUpdateCheck.parse(await authorized(endpoint, {}, signal));
      return result;
    },
    async grant(artifact: WebsiteArtifact, signal: AbortSignal) {
      const cfg = await configuration(signal);
      const grant = Grant.parse(
        await authorized(
          WEBSITE_ORIGIN + '/api/portal?action=download',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ artifactId: artifact.artifactId }),
          },
          signal,
        ),
      );
      const url = new URL(grant.url);
      if (
        url.origin !== cfg.url ||
        !url.pathname.startsWith('/storage/v1/object/sign/quadrion-software/') ||
        url.username ||
        url.password ||
        url.hash ||
        grant.filename !== artifact.filename ||
        grant.bytes !== artifact.bytes ||
        grant.sha256 !== artifact.sha256
      )
        throw new Error('The download grant does not match the published artifact.');
      d.secret?.(grant.url);
      return grant.url;
    },
    async binary(url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) {
      const signal = init?.signal ?? new AbortController().signal;
      guard(signal);
      const response = await d.fetch(url, {
        ...init,
        signal,
        redirect: 'error',
        credentials: 'omit',
      });
      guard(signal);
      return response;
    },
  };
}
export type WebsiteClient = ReturnType<typeof createWebsiteClient>;
