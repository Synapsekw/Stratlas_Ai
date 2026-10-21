import { describe, it, expect } from 'vitest';
import { createWebsiteClient } from './websiteClient';
const origin = 'https://testproject.supabase.co';
const token = {
  access_token: 'access.token',
  refresh_token: 'rotated',
  user: { email: 'member@example.com' },
};
function fixture() {
  let saved: string | null = 'old';
  let online = true;
  let fail = false;
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const client = createWebsiteClient({
    allowed: () => online,
    vault: {
      read: () => saved,
      write: (v) => {
        if (fail && v) throw new Error('vault');
        saved = v;
      },
    },
    fetch: (url, init) => {
      requests.push({ url, init });
      return Promise.resolve(
        Response.json(
          url.includes('action=config')
            ? { enabled: true, url: origin, publishableKey: 'public-key' }
            : url.includes('/auth/')
              ? token
              : { email: 'member@example.com', member: { status: 'active' }, requiresMfa: false },
        ),
      );
    },
  });
  return {
    client,
    requests,
    saved: () => saved,
    offline: () => {
      online = false;
    },
    fail: () => {
      fail = true;
    },
  };
}
describe('website client boundaries', () => {
  it('makes no config or auth requests offline', async () => {
    const f = fixture();
    f.offline();
    await expect(
      f.client.signIn('a@example.com', 'password', new AbortController().signal),
    ).rejects.toThrow();
    expect(f.requests).toHaveLength(0);
  });
  it('persists rotation before exposing authenticated state', async () => {
    const f = fixture();
    expect(await f.client.restore(new AbortController().signal)).toBe('member@example.com');
    expect(f.saved()).toBe('rotated');
    expect(f.requests.map((x) => x.url)).toContain(
      origin + '/auth/v1/token?grant_type=refresh_token',
    );
  });
  it('clears unusable credentials if rotated token cannot be saved', async () => {
    const f = fixture();
    f.fail();
    await expect(f.client.restore(new AbortController().signal)).rejects.toThrow();
    expect(f.saved()).toBeNull();
  });
  it('rejects configuration pointing away from Supabase', async () => {
    const client = createWebsiteClient({
      allowed: () => true,
      vault: { read: () => null, write: () => undefined },
      fetch: () =>
        Promise.resolve(
          Response.json({ enabled: true, url: 'https://evil.example', publishableKey: 'x' }),
        ),
    });
    await expect(
      client.signIn('a@example.com', 'p', new AbortController().signal),
    ).rejects.toThrow();
  });
});

describe('website auth and artifact trust', () => {
  it('never saves tokens from a delayed response after cancellation', async () => {
    let resolve: (response: Response) => void = () => undefined;
    let saved: string | null = null;
    let authRequested: () => void = () => undefined;
    const started = new Promise<void>((r) => {
      authRequested = r;
    });
    const client = createWebsiteClient({
      allowed: () => true,
      vault: {
        read: () => saved,
        write: (v) => {
          saved = v;
        },
      },
      fetch: (url) => {
        if (url.includes('action=config'))
          return Promise.resolve(
            Response.json({ enabled: true, url: origin, publishableKey: 'public' }),
          );
        authRequested();
        return new Promise((r) => {
          resolve = r;
        });
      },
    });
    const controller = new AbortController();
    const signing = client.signIn('member@example.com', 'secret', controller.signal);
    await started;
    controller.abort();
    client.signOut();
    resolve(Response.json(token));
    await expect(signing).rejects.toThrow();
    expect(saved).toBeNull();
  });
  it('matches signed grants exactly and never sends account auth to storage', async () => {
    const artifact = {
      releaseId: '00000000-0000-4000-8000-000000000001',
      artifactId: '00000000-0000-4000-8000-000000000002',
      version: '0.25.0',
      platform: 'win-x64' as const,
      filename: 'Setup.exe',
      bytes: 3,
      sha256: 'a'.repeat(64),
      notes: '',
    };
    const requests: { url: string; headers: Headers }[] = [];
    let bad = false;
    const client = createWebsiteClient({
      allowed: () => true,
      vault: { read: () => null, write: () => undefined },
      fetch: (url, init) => {
        requests.push({ url, headers: new Headers(init?.headers) });
        if (url.includes('action=config'))
          return Promise.resolve(
            Response.json({ enabled: true, url: origin, publishableKey: 'public' }),
          );
        if (url.includes('/auth/')) return Promise.resolve(Response.json(token));
        if (url.includes('action=download'))
          return Promise.resolve(
            Response.json({
              url:
                origin +
                '/storage/v1/object/sign/quadrion-software/releases/Setup.exe?token=temporary',
              filename: artifact.filename,
              bytes: 3,
              sha256: bad ? 'b'.repeat(64) : artifact.sha256,
              expiresIn: 300,
            }),
          );
        if (url.includes('/storage/')) return Promise.resolve(new Response('abc'));
        return Promise.resolve(
          Response.json({
            email: 'member@example.com',
            member: { status: 'active' },
            requiresMfa: false,
          }),
        );
      },
    });
    const signal = new AbortController().signal;
    await client.signIn('member@example.com', 'secret', signal);
    const signed = await client.grant(artifact, signal);
    await client.binary(signed, { signal, headers: { Range: 'bytes=1-' } });
    const binary = requests.at(-1);
    expect(binary?.headers.has('Authorization')).toBe(false);
    expect(binary?.headers.get('Range')).toBe('bytes=1-');
    const grant = requests.find((r) => r.url.includes('action=download'));
    expect(grant?.headers.get('Origin')).toBe('https://quadrion.ai');
    expect(grant?.headers.get('Authorization')).toBe('Bearer access.token');
    bad = true;
    await expect(client.grant(artifact, signal)).rejects.toThrow(/match/);
  });
});
