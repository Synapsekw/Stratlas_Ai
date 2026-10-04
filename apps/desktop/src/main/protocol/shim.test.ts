// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacyShim, SHIM_SOURCE, type ShimReply, type ShimSaveMessage } from './shim';

interface Claude {
  use(name: string): Promise<unknown>;
}
interface Downloads {
  save(req: { filename: string; data: unknown; mimeType?: string }): Promise<void>;
}
interface Snap {
  docs: { id: string; exists: boolean; data(): unknown }[];
  size: number;
  empty: boolean;
}
interface DocRef {
  set(data: unknown): Promise<void>;
  update(patch: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  get(): Promise<{ id: string; exists: boolean; data(): unknown }>;
}
interface Collection {
  doc(id: string): DocRef;
  get(): Promise<Snap>;
  onSnapshot(next: (s: Snap) => void, error?: (e: unknown) => void): () => void;
}
interface Db {
  collection(name: string): Collection;
}

type ShimWindow = Window & {
  claude?: Claude;
  KIT?: { target?: string; job?: unknown };
  VS_CONFIG?: { target?: string; maxNative?: number };
  TANK_OFFLINE?: boolean;
};
const w = window as ShimWindow;

/** Run the shim from its serialized source, exactly as the protocol injects it. */
function install(projectId = 'masafi') {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the injected form is a string.
  const run = new Function(`(${SHIM_SOURCE})(${JSON.stringify({ projectId })})`) as () => void;
  run();
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  localStorage.clear();
  for (const k of ['claude', 'KIT', 'VS_CONFIG', 'TANK_OFFLINE'] as const) {
    Reflect.deleteProperty(w, k);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('serialization', () => {
  it('is the source of legacyShim and needs nothing from its module', () => {
    expect(SHIM_SOURCE).toBe(legacyShim.toString());
    expect(() => {
      install();
    }).not.toThrow();
    expect(typeof w.claude?.use).toBe('function');
  });
});

describe('offline flags', () => {
  it('forces KIT.target to offline when the viewer sets window.KIT', () => {
    install();
    w.KIT = { target: 'artifact', job: { title: 'x' } };
    expect(w.KIT.target).toBe('offline');
    expect(w.KIT.job).toEqual({ title: 'x' });
  });

  it('forces VS_CONFIG.target to offline and keeps the other options', () => {
    install();
    w.VS_CONFIG = { maxNative: 5, target: 'artifact' };
    expect(w.VS_CONFIG).toEqual({ maxNative: 5, target: 'offline' });
  });

  it('sets TANK_OFFLINE', () => {
    install();
    expect(w.TANK_OFFLINE).toBe(true);
  });
});

describe("claude.use('downloads')", () => {
  /** Answer every save posted to the parent with `reply`, recording the messages. */
  function parentAnswers(reply: ShimReply) {
    const seen: ShimSaveMessage[] = [];
    vi.spyOn(window, 'postMessage').mockImplementation(((
      msg: ShimSaveMessage,
      _origin: string,
      transfer?: Transferable[],
    ) => {
      seen.push(msg);
      const port = transfer?.[0] as MessagePort | undefined;
      port?.postMessage(reply);
    }) as typeof window.postMessage);
    return seen;
  }

  async function downloads(): Promise<Downloads> {
    install();
    const claude = w.claude;
    if (!claude) throw new Error('no shim');
    return (await claude.use('downloads')) as Downloads;
  }

  it('posts text to the parent and resolves when the parent saved it', async () => {
    const seen = parentAnswers({ ok: true });
    const dl = await downloads();
    await dl.save({ filename: 'register.csv', data: 'a,b\n1,2' });
    expect(seen).toEqual([
      { source: 'stratlas-legacy', type: 'save', filename: 'register.csv', data: 'a,b\n1,2' },
    ]);
  });

  it('sends a Blob as bytes', async () => {
    const seen = parentAnswers({ ok: true });
    const dl = await downloads();
    await dl.save({ filename: 'm.bin', data: new Blob([new Uint8Array([1, 2, 3])]) });
    const sent = seen[0]?.data;
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(Array.from(sent as Uint8Array)).toEqual([1, 2, 3]);
  });

  it('sends ArrayBuffer and typed arrays as bytes', async () => {
    const seen = parentAnswers({ ok: true });
    const dl = await downloads();
    await dl.save({ filename: 'a.bin', data: new Uint8Array([4, 5]).buffer });
    await dl.save({ filename: 'b.bin', data: new Uint16Array([0x0201]) });
    expect(Array.from(seen[0]?.data as Uint8Array)).toEqual([4, 5]);
    expect(Array.from(seen[1]?.data as Uint8Array)).toEqual([1, 2]);
  });

  it("rejects with code 'declined' when the person cancels the dialog", async () => {
    parentAnswers({ ok: false, code: 'declined' });
    const dl = await downloads();
    await expect(dl.save({ filename: 'x.csv', data: 'x' })).rejects.toMatchObject({
      code: 'declined',
    });
  });

  it('rejects with the error message when saving fails', async () => {
    parentAnswers({ ok: false, error: 'Disk full' });
    const dl = await downloads();
    await expect(dl.save({ filename: 'x.csv', data: 'x' })).rejects.toThrow('Disk full');
  });
});

describe("claude.use('db')", () => {
  async function db(projectId = 'masafi'): Promise<Db> {
    install(projectId);
    const claude = w.claude;
    if (!claude) throw new Error('no shim');
    return (await claude.use('db')) as Db;
  }

  it('stores documents and reads them back', async () => {
    const d = await db();
    await d
      .collection('edits')
      .doc('P01|e1')
      .set({ pile: 'P01', ring: [1, 2, 3, 4] });
    const got = await d.collection('edits').doc('P01|e1').get();
    expect(got.exists).toBe(true);
    expect(got.data()).toEqual({ pile: 'P01', ring: [1, 2, 3, 4] });
    expect((await d.collection('edits').doc('nope').get()).exists).toBe(false);
  });

  it('delivers an initial snapshot and one after every change', async () => {
    const d = await db();
    const sizes: number[][] = [];
    const unsub = d.collection('edits').onSnapshot((s) => {
      sizes.push(s.docs.map((x) => (x.data() as { v: number }).v));
    });
    await tick();
    await d.collection('edits').doc('a').set({ v: 1 });
    await tick();
    await d.collection('edits').doc('b').set({ v: 2 });
    await tick();
    await d.collection('edits').doc('a').delete();
    await tick();
    unsub();
    await d.collection('edits').doc('c').set({ v: 3 });
    await tick();
    expect(sizes).toEqual([[], [1], [1, 2], [2]]);
  });

  it('merges fields on update', async () => {
    const d = await db();
    await d.collection('edits').doc('a').set({ v: 1, w: 1 });
    await d.collection('edits').doc('a').update({ w: 2 });
    expect((await d.collection('edits').doc('a').get()).data()).toEqual({ v: 1, w: 2 });
  });

  it('persists per project in localStorage', async () => {
    const a = await db('masafi');
    await a.collection('edits').doc('x').set({ v: 1 });
    const again = await db('masafi');
    expect((await again.collection('edits').get()).size).toBe(1);
    const other = await db('damac');
    expect((await other.collection('edits').get()).empty).toBe(true);
  });

  it('hands out copies, so callers cannot change stored data by mutation', async () => {
    const d = await db();
    const data = { v: 1 };
    await d.collection('edits').doc('x').set(data);
    data.v = 9;
    const got = (await d.collection('edits').doc('x').get()).data() as { v: number };
    got.v = 7;
    expect((await d.collection('edits').doc('x').get()).data()).toEqual({ v: 1 });
  });

  it("rejects values that cannot be stored with code 'invalid_argument'", async () => {
    const d = await db();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(d.collection('edits').doc('x').set(cyclic)).rejects.toMatchObject({
      code: 'invalid_argument',
    });
  });
});

describe('claude.use for other capabilities', () => {
  it('resolves null so viewers fall back to their own code', async () => {
    install();
    expect(await w.claude?.use('storage')).toBeNull();
  });
});
