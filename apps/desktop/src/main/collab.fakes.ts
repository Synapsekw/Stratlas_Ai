/**
 * TEST-ONLY fakes of the collab seams (M9 integration): a journal that appends unsigned ops with
 * made-up devices, members folded from `member.*` ops without checking keys, and an identity read
 * from `identity.json`. The app wires T1's journal and T2's identity and members
 * (`identityPorts.ts`); only `collab.test.ts` imports this file.
 */
import { base32, createClock, readSegment, sealOp, sha256Hex } from '@aio/journal';
import { sortOps, type CollabOp } from '@aio/collab';
import {
  IDENTITY_FILE,
  Identity,
  JOURNAL_OPS_DIR,
  MemberAddPayload,
  MemberRemovePayload,
  MemberRolePayload,
  segmentFileName,
} from '@aio/schema';
import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import type { CollabIdentity, CollabJournal, CollabMembers, MemberLite } from './collab';
import { readJson } from './fsutil';

const LETTERS = /[^\p{L}]/gu;

/** Initials from a name: first letters of the first and last words, up to 3 (any script). */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(LETTERS, ''))
    .filter(Boolean);
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words.at(-1)?.charAt(0) ?? '') : '';
  const out = `${first}${last}`.toLocaleUpperCase();
  return out || 'ME';
}

/**
 * T2 stub: `identity.json` in userData when T2 (or a test) wrote one, else a stable local actor
 * named after the OS account, so one person alone can comment before identities exist.
 */
export function createFakeIdentity(opts: {
  userData: string;
  osName?: () => string;
}): CollabIdentity {
  return {
    async me() {
      const raw = await readJson(join(opts.userData, IDENTITY_FILE)).catch(() => undefined);
      const parsed = Identity.safeParse(raw);
      if (parsed.success) {
        const { actor, name, initials } = parsed.data;
        return { actor, name, initials };
      }
      let name = 'You';
      try {
        name = (opts.osName ?? (() => userInfo().username))().trim() || 'You';
      } catch {
        // no OS account name: keep "You"
      }
      const actor = `a_${base32(Buffer.from(sha256Hex(`aio.interim-actor\n${opts.userData}`), 'hex')).slice(0, 26)}`;
      return { actor, name: name.slice(0, 80), initials: initialsOf(name).slice(0, 3) };
    },
  };
}

/** T2 stub: members folded from `member.add`, `member.role` and `member.remove` ops. */
export function createFakeMembers(): CollabMembers {
  return {
    list(_root, ops) {
      const members = new Map<string, MemberLite>();
      for (const op of sortOps(ops)) {
        if (op.kind === 'member.add') {
          const p = MemberAddPayload.safeParse(op.payload);
          if (p.success)
            members.set(p.data.actor, {
              actor: p.data.actor,
              name: p.data.name,
              initials: p.data.initials,
              role: p.data.role,
            });
        } else if (op.kind === 'member.role') {
          const p = MemberRolePayload.safeParse(op.payload);
          const m = p.success ? members.get(p.data.actor) : undefined;
          if (m && p.success) m.role = p.data.role;
        } else if (op.kind === 'member.remove') {
          const p = MemberRemovePayload.safeParse(op.payload);
          if (p.success) members.delete(p.data.actor);
        }
      }
      return Promise.resolve([...members.values()]);
    },
  };
}

interface RawLine {
  file: string;
  raw: Record<string, unknown>;
}

function asOp(raw: Record<string, unknown>): CollabOp | null {
  const t = raw.target as Record<string, unknown> | undefined;
  if (
    typeof raw.id !== 'string' ||
    typeof raw.act !== 'string' ||
    typeof raw.hlc !== 'string' ||
    typeof raw.kind !== 'string' ||
    !t ||
    typeof t.rec !== 'string' ||
    typeof t.id !== 'string'
  )
    return null;
  return {
    id: raw.id,
    act: raw.act,
    hlc: raw.hlc,
    kind: raw.kind,
    target: { rec: t.rec, id: t.id, ...(typeof t.in === 'string' ? { in: t.in } : {}) },
    ...('payload' in raw ? { payload: raw.payload } : {}),
  };
}

/**
 * T1 stand-in: appends unsigned `aio.op/1` lines (hash-chained, with clock and deps) to
 * `journal/ops/<device>.<replica>/000001.jsonl`. Device and replica are derived (no key exists
 * before T2), so Verify will call these ops unsigned from an unknown device: interim builds only.
 */
export function createFakeJournal(opts: { userData: string }): CollabJournal {
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(root: string, run: () => Promise<T>): Promise<T> => {
    const next = (queues.get(root) ?? Promise.resolve()).then(run, run);
    queues.set(
      root,
      next.catch(() => undefined),
    );
    return next;
  };

  async function lines(root: string): Promise<RawLine[]> {
    const dir = join(root, JOURNAL_OPS_DIR);
    const chains = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: RawLine[] = [];
    for (const c of chains
      .filter((d) => d.isDirectory())
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const files = (await readdir(join(dir, c.name)).catch(() => []))
        .filter((f) => f.endsWith('.jsonl'))
        .sort();
      for (const f of files) {
        const file = join(dir, c.name, f);
        const text = await readFile(file, 'utf8').catch(() => '');
        for (const l of readSegment(text)) if (l.ok) out.push({ file, raw: l.raw });
      }
    }
    return out;
  }

  const ids = (actor: string, root: string) => {
    const dev = `d_${base32(Buffer.from(sha256Hex(`aio.interim-device\n${actor}\n${opts.userData}`), 'hex'))}`;
    const replica = `r_${base32(Buffer.from(sha256Hex(`${opts.userData}\n${root}`), 'hex')).slice(0, 16)}`;
    return { dev, chain: `${dev}.${replica}` };
  };

  return {
    async read(root) {
      return (await lines(root)).map((l) => asOp(l.raw)).filter((o): o is CollabOp => o !== null);
    },
    append(root, me, draft) {
      return serial(root, async () => {
        const { dev, chain } = ids(me.actor, root);
        const all = await lines(root);
        const heads = new Map<string, { seq: number; id: string }>();
        let latest = '';
        for (const { raw } of all) {
          if (typeof raw.chain !== 'string' || typeof raw.seq !== 'number') continue;
          const h = heads.get(raw.chain);
          if (!h || h.seq < raw.seq) heads.set(raw.chain, { seq: raw.seq, id: String(raw.id) });
          if (typeof raw.hlc === 'string' && raw.hlc > latest) latest = raw.hlc;
        }
        const clock = createClock(dev);
        let hlc: string;
        try {
          hlc = latest ? clock.receive(latest) : clock.tick();
        } catch {
          hlc = clock.tick();
        }
        const head = heads.get(chain);
        const deps = Object.fromEntries(
          [...heads].filter(([c]) => c !== chain).map(([c, h]) => [c, h.id]),
        );
        const op = sealOp(
          {
            v: 1,
            chain,
            dev,
            act: me.actor,
            seq: (head?.seq ?? 0) + 1,
            hlc,
            prev: head?.id ?? null,
            ...(Object.keys(deps).length ? { deps } : {}),
            kind: draft.kind,
            target: draft.target,
            ...(draft.label ? { label: draft.label.slice(0, 200) } : {}),
            ...(draft.via ? { via: draft.via } : {}),
          },
          draft.payload,
        );
        const dir = join(root, JOURNAL_OPS_DIR, chain);
        await mkdir(dir, { recursive: true });
        const segments = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
        const file = join(dir, segments.at(-1) ?? segmentFileName(1));
        const fh = await open(file, 'a');
        try {
          await fh.write(`${JSON.stringify(op)}\n`);
          await fh.sync();
        } finally {
          await fh.close();
        }
        return { id: op.id, hlc: op.hlc };
      });
    },
    redactPayloads(root, opIds) {
      return serial(root, async () => {
        const wanted = new Set(opIds);
        const files = new Set(
          (await lines(root)).filter((l) => wanted.has(String(l.raw.id))).map((l) => l.file),
        );
        let count = 0;
        for (const file of files) {
          const text = await readFile(file, 'utf8');
          const out = text
            .split('\n')
            .map((line) => {
              if (!line.trim()) return line;
              try {
                const raw = JSON.parse(line) as Record<string, unknown>;
                if (!wanted.has(String(raw.id)) || !('payload' in raw)) return line;
                delete raw.payload;
                count++;
                return JSON.stringify(raw);
              } catch {
                return line;
              }
            })
            .join('\n');
          await writeTextAtomic(file, out);
        }
        return count;
      });
    },
  };
}

async function writeTextAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.write(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}
