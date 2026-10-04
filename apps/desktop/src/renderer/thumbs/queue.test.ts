import { describe, expect, it } from 'vitest';
import { createThumbQueue, type ThumbRequest } from './queue';

interface Pending {
  url: string;
  resolve: (b: ArrayBuffer) => void;
  reject: (e: Error) => void;
}

function setup(concurrency = 1) {
  const started: Pending[] = [];
  const stored: string[] = [];
  const q = createThumbQueue({
    make: (url) =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        started.push({ url, resolve, reject });
      }),
    store: (req) => {
      stored.push(req.path);
      return Promise.resolve();
    },
    toUrl: (b) => `blob:${String(b.byteLength)}`,
    concurrency,
  });
  return { q, started, stored };
}

const req = (n: number): ThumbRequest => ({
  projectId: 'p',
  path: `photos/p${String(n)}.jpg`,
  source: `aio://project/p/photos/p${String(n)}.jpg`,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('thumbnail queue', () => {
  it('runs at most `concurrency` jobs and the newest request first', async () => {
    const { q, started } = setup(1);
    q.request(req(1), () => undefined);
    q.request(req(2), () => undefined);
    q.request(req(3), () => undefined);
    expect(started.map((s) => s.url)).toEqual([req(1).source]);
    started[0]?.resolve(new ArrayBuffer(4));
    await flush();
    expect(started.map((s) => s.url)).toEqual([req(1).source, req(3).source]);
  });

  it('makes each thumbnail once, stores it and answers later requests at once', async () => {
    const { q, started, stored } = setup(2);
    const got: (string | null)[] = [];
    q.request(req(1), (u) => got.push(u));
    q.request(req(1), (u) => got.push(u));
    expect(started).toHaveLength(1);
    started[0]?.resolve(new ArrayBuffer(7));
    await flush();
    expect(got).toEqual(['blob:7', 'blob:7']);
    expect(stored).toEqual(['photos/p1.jpg']);
    expect(q.made(req(1))).toBe('blob:7');
    q.request(req(1), (u) => got.push(u));
    expect(got).toHaveLength(3);
    expect(started).toHaveLength(1);
  });

  it('drops a request nobody waits for before it starts', async () => {
    const { q, started } = setup(1);
    q.request(req(1), () => undefined);
    const cancel = q.request(req(2), () => undefined);
    cancel();
    expect(q.pending()).toBe(1);
    started[0]?.resolve(new ArrayBuffer(1));
    await flush();
    expect(started).toHaveLength(1);
    expect(q.pending()).toBe(0);
  });

  it('answers null when a thumbnail cannot be made, and does not retry', async () => {
    const { q, started } = setup(1);
    const got: (string | null)[] = [];
    q.request(req(1), (u) => got.push(u));
    started[0]?.reject(new Error('decode'));
    await flush();
    expect(got).toEqual([null]);
    q.request(req(1), (u) => got.push(u));
    expect(got).toEqual([null, null]);
    expect(started).toHaveLength(1);
  });
});
