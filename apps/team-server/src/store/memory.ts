import type { Heads, Op, Receipt, TeamProject } from '@aio/schema';
import type { EnrolledDevice, Invite, Store } from './store';

const clone = <T>(v: T): T => structuredClone(v);

/** The in-memory store: tests, the e2e in-process server and a quick local trial. */
export function createMemoryStore(): Store {
  const meta = new Map<string, string>();
  const projects = new Map<string, TeamProject>();
  /** Per project: ops in arrival order, and by id. */
  const ops = new Map<string, { list: Op[]; byId: Set<string> }>();
  const receipts: Receipt[] = [];
  const invites = new Map<string, Invite>();
  const devices = new Map<string, EnrolledDevice>();

  const opsOf = (team: string) => {
    let m = ops.get(team);
    if (!m) {
      m = { list: [], byId: new Set() };
      ops.set(team, m);
    }
    return m;
  };

  return {
    kind: 'memory',
    init: () => Promise.resolve(),
    close: () => Promise.resolve(),

    meta: (key) => Promise.resolve(meta.get(key) ?? null),
    setMeta(key, value) {
      meta.set(key, value);
      return Promise.resolve();
    },

    projects: () => Promise.resolve([...projects.values()].map(clone)),
    project: (id) => Promise.resolve(clone(projects.get(id) ?? null)),
    createProject(p) {
      if (!projects.has(p.teamProjectId)) projects.set(p.teamProjectId, clone(p));
      return Promise.resolve();
    },

    heads(id) {
      const out: Heads = {};
      for (const op of opsOf(id).list) {
        const h = out[op.chain];
        if (!h || op.seq > h.seq) out[op.chain] = { seq: op.seq, id: op.id };
      }
      return Promise.resolve(out);
    },
    hasOps(id, wanted) {
      const all = opsOf(id).byId;
      return Promise.resolve(new Set(wanted.filter((w) => all.has(w))));
    },
    appendOps(id, incoming) {
      const all = opsOf(id);
      const stored: string[] = [];
      const duplicates: string[] = [];
      for (const op of incoming) {
        if (all.byId.has(op.id)) duplicates.push(op.id);
        else {
          all.byId.add(op.id);
          all.list.push(clone(op));
          stored.push(op.id);
        }
      }
      return Promise.resolve({ stored, duplicates });
    },
    opsSince(id, since, limit) {
      const after = opsOf(id).list.filter((op) => op.seq > (since[op.chain] ?? 0));
      return Promise.resolve({ ops: after.slice(0, limit).map(clone), more: after.length > limit });
    },
    async *allOps(id) {
      for (const op of [...opsOf(id).list]) yield await Promise.resolve(clone(op));
    },

    appendReceipts(r) {
      receipts.push(...r.map(clone));
      return Promise.resolve();
    },
    lastReceipt: () => Promise.resolve(clone(receipts[receipts.length - 1] ?? null)),
    receipts: (afterSeq, limit) =>
      Promise.resolve(
        receipts
          .filter((r) => r.seq > afterSeq)
          .slice(0, limit)
          .map(clone),
      ),

    addInvite(invite) {
      invites.set(invite.codeHash, clone(invite));
      return Promise.resolve();
    },
    takeInvite(codeHash, now, device) {
      const inv = invites.get(codeHash);
      if (inv?.usedAt !== null || inv.expiresAt <= now) return Promise.resolve(null);
      inv.usedAt = now;
      inv.usedBy = device;
      return Promise.resolve(clone(inv));
    },
    invites: () => Promise.resolve([...invites.values()].map(clone)),

    putDevice(d) {
      devices.set(d.device, clone(d));
      return Promise.resolve();
    },
    device: (id) => Promise.resolve(clone(devices.get(id) ?? null)),
    devices: () => Promise.resolve([...devices.values()].map(clone)),
    revokeDevice(id, at, reason) {
      const d = devices.get(id);
      if (!d) return Promise.resolve(false);
      if (d.revokedAt === null) {
        d.revokedAt = at;
        d.revokeReason = reason;
      }
      return Promise.resolve(true);
    },
  };
}
