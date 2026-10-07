import type { Heads, Member, Op, Receipt, TeamProject } from '@aio/schema';
import type { Store } from './store';

/** The in-memory store: tests, the e2e in-process server and a quick local trial. */
export function createMemoryStore(): Store {
  const projects = new Map<string, TeamProject>();
  const members = new Map<string, Member[]>();
  const ops = new Map<string, Map<string, Op>>();
  const receipts: Receipt[] = [];

  const opsOf = (team: string): Map<string, Op> => {
    let m = ops.get(team);
    if (!m) {
      m = new Map();
      ops.set(team, m);
    }
    return m;
  };

  return {
    projects: () => Promise.resolve([...projects.values()]),
    project: (id) => Promise.resolve(projects.get(id) ?? null),
    createProject(p) {
      if (!projects.has(p.teamProjectId)) projects.set(p.teamProjectId, p);
      return Promise.resolve();
    },
    members: (id) => Promise.resolve(members.get(id) ?? []),
    heads(id) {
      const out: Heads = {};
      for (const op of opsOf(id).values()) {
        const h = out[op.chain];
        if (!h || op.seq > h.seq) out[op.chain] = { seq: op.seq, id: op.id };
      }
      return Promise.resolve(out);
    },
    appendOps(id, incoming) {
      const all = opsOf(id);
      const stored: string[] = [];
      const duplicates: string[] = [];
      for (const op of incoming) {
        if (all.has(op.id)) duplicates.push(op.id);
        else {
          all.set(op.id, op);
          stored.push(op.id);
        }
      }
      return Promise.resolve({ stored, duplicates });
    },
    opsSince(id, since, limit) {
      const after = [...opsOf(id).values()]
        .filter((op) => op.seq > (since[op.chain]?.seq ?? 0))
        .sort((a, b) => (a.chain === b.chain ? a.seq - b.seq : a.chain < b.chain ? -1 : 1));
      return Promise.resolve({ ops: after.slice(0, limit), more: after.length > limit });
    },
    appendReceipts(r) {
      receipts.push(...r);
      return Promise.resolve();
    },
    lastReceipt: () => Promise.resolve(receipts[receipts.length - 1] ?? null),
  };
}
