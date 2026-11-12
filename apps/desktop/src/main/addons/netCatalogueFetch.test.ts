import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { readCatalogue } from './catalogue';
import { fakeAddonArchive, fakeCatalogue, fakeCatalogueEntry } from './addon.fakes';
import { netCatalogueFetch, type ClientRequestLike, type IncomingLike } from './netCatalogueFetch';

/** A fake `net.request`: answers each address from `hops` (a redirect) or `bodies` (a 200). */
function fakeNet(hops: Record<string, string>, bodies: Record<string, string>) {
  const asked: string[] = [];
  const made: { url: string; redirect: string }[] = [];
  let aborted = 0;
  const request = (o: { url: string; redirect: 'manual' }): ClientRequestLike => {
    made.push(o);
    const ev = new EventEmitter();
    let at = o.url;
    const answer = () => {
      asked.push(at);
      const to = hops[at];
      if (to !== undefined) {
        ev.emit('redirect', 302, 'GET', to);
        return;
      }
      const body = bodies[at];
      const res = new EventEmitter() as EventEmitter & IncomingLike;
      res.statusCode = body === undefined ? 404 : 200;
      res.headers = { 'content-type': 'application/json' };
      ev.emit('response', res);
      if (body !== undefined) res.emit('data', Buffer.from(body));
      res.emit('end');
    };
    const req = {
      on: (e: string, cb: (...a: never[]) => void) => {
        ev.on(e, cb as (...a: unknown[]) => void);
        return req;
      },
      followRedirect: () => {
        at = new URL(hops[at] ?? '', at).toString();
        queueMicrotask(answer);
      },
      abort: () => {
        aborted++;
      },
      end: () => {
        queueMicrotask(answer);
      },
    } as unknown as ClientRequestLike;
    return req;
  };
  return { request, asked, made, aborted: () => aborted };
}

const base = 'https://addons.example.test/v1/';
const catalogue = (): Promise<string> => {
  const a = fakeAddonArchive({ id: 'road-defects', kind: 'detector' });
  return Promise.resolve(JSON.stringify(fakeCatalogue([fakeCatalogueEntry(a)])));
};

describe('netCatalogueFetch', () => {
  it('asks net.request not to follow redirects, and reads a catalogue that answers directly', async () => {
    const net = fakeNet({}, { [`${base}catalogue.json`]: await catalogue() });
    const r = await readCatalogue({ base, fetch: netCatalogueFetch(net.request) });
    expect(r).toMatchObject({ ok: true });
    expect(net.made).toEqual([{ url: `${base}catalogue.json`, redirect: 'manual' }]);
  });

  it('follows a redirect to another https address, checked first', async () => {
    const net = fakeNet(
      { [`${base}catalogue.json`]: 'https://cdn.example.test/addons/catalogue.json' },
      { 'https://cdn.example.test/addons/catalogue.json': await catalogue() },
    );
    expect(await readCatalogue({ base, fetch: netCatalogueFetch(net.request) })).toMatchObject({
      ok: true,
    });
    expect(net.asked).toEqual([
      `${base}catalogue.json`,
      'https://cdn.example.test/addons/catalogue.json',
    ]);
  });

  it('aborts a redirect down to plain http before it is followed', async () => {
    const net = fakeNet(
      { [`${base}catalogue.json`]: 'http://127.0.0.1:9/catalogue.json' },
      { 'http://127.0.0.1:9/catalogue.json': await catalogue() },
    );
    const r = await readCatalogue({ base, fetch: netCatalogueFetch(net.request) });
    expect(r).toMatchObject({ ok: false, error: /does not read add-ons from/ });
    expect(net.asked).toEqual([`${base}catalogue.json`]);
    expect(net.aborted()).toBe(1);
  });

  it('aborts a plain-http hop that sends the request on elsewhere', async () => {
    const local = 'http://127.0.0.1:9/addons/';
    const net = fakeNet(
      {
        [`${local}catalogue.json`]: 'http://localhost:9/hop',
        'http://localhost:9/hop': 'http://evil.example.test/catalogue.json',
      },
      { 'http://evil.example.test/catalogue.json': await catalogue() },
    );
    const r = await readCatalogue({ base: local, fetch: netCatalogueFetch(net.request) });
    expect(r).toMatchObject({ ok: false, error: /evil\.example\.test, which the app does not/ });
    expect(net.asked).not.toContain('http://evil.example.test/catalogue.json');
  });

  it('gives up after five redirects', async () => {
    const hops: Record<string, string> = {};
    for (let i = 0; i < 10; i++)
      hops[i === 0 ? `${base}catalogue.json` : `https://h${String(i)}.example.test/`] =
        `https://h${String(i + 1)}.example.test/`;
    const net = fakeNet(hops, {});
    expect(await readCatalogue({ base, fetch: netCatalogueFetch(net.request) })).toMatchObject({
      ok: false,
      error: /too many times/,
    });
    expect(net.asked).toHaveLength(6);
  });
});
