// @vitest-environment jsdom
import type { Identity, IpcChannel } from '@aio/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bridge } from './bridge';

// The annotation runtime is heavy to import again for every fresh module state.
vi.mock('@aio/annotate', () => ({ setAnnotationAuthor: () => undefined }));

const base: Identity = {
  schema: 'aio.identity/1',
  actor: `a_${'a'.repeat(26)}`,
  name: 'rana',
  initials: 'RA',
  createdAt: '2026-10-07T10:00:00.000Z',
  migratedFrom: 'os-account',
};

/** A fake main: identity:set takes `migrateFrom` the way identity.ts does. */
function fakeMain(opts: { failGet?: boolean } = {}) {
  let identity = { ...base };
  const calls: { channel: IpcChannel; req: unknown }[] = [];
  const bridge: Bridge = {
    call: ((channel: IpcChannel, req: Record<string, unknown>) => {
      calls.push({ channel, req });
      if (channel === 'app:getInfo') {
        return Promise.resolve({
          ok: true,
          value: { name: 'Quadrion AI', version: '0.9.0', platform: 'win32', user: 'rana' },
        });
      }
      if (channel === 'identity:set') {
        if (typeof req.migrateFrom === 'string') {
          identity = { ...identity, name: req.migrateFrom, migratedFrom: 'author-setting' };
        }
        if (typeof req.initials === 'string') identity = { ...identity, initials: req.initials };
        return Promise.resolve({ ok: true, value: { ok: true, identity } });
      }
      if (channel === 'identity:get') {
        return Promise.resolve(
          opts.failGet
            ? { ok: true, value: { ok: false, error: 'not yet', code: 'not-implemented' } }
            : { ok: true, value: { ok: true, identity, device: null, unsigned: false } },
        );
      }
      return Promise.resolve({ ok: false, error: 'unexpected' });
    }) as Bridge['call'],
  };
  return { bridge, calls };
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('author identity', () => {
  it('moves the old "Your name on issues" to main once and uses the identity', async () => {
    localStorage.setItem('stratlas.author', 'Rana Example');
    const author = await import('./author');
    const main = fakeMain();
    await author.initAuthor(main.bridge);
    expect(author.authorName()).toBe('Rana Example');
    expect(main.calls.filter((c) => c.channel === 'identity:set')).toEqual([
      { channel: 'identity:set', req: { migrateFrom: 'Rana Example' } },
    ]);
    // kept for older builds on this computer, but never sent again
    expect(localStorage.getItem('stratlas.author')).toBe('Rana Example');
    vi.resetModules();
    const again = await import('./author');
    const second = fakeMain();
    await again.initAuthor(second.bridge);
    expect(second.calls.some((c) => c.channel === 'identity:set')).toBe(false);
  });

  it('falls back to the old name or the OS account when main has no identity', async () => {
    const author = await import('./author');
    await author.initAuthor(fakeMain({ failGet: true }).bridge);
    expect(author.authorName()).toBe('rana');
    expect(author.useIdentity).toBeTypeOf('function');
  });

  it('saves new initials through main', async () => {
    const author = await import('./author');
    await author.initAuthor(fakeMain().bridge);
    expect(await author.saveIdentity({ initials: 'DR' })).toBeNull();
    expect(author.authorInitials()).toBe('DR');
  });
});
