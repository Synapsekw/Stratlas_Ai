import { registerRendererTool, ToolError, type ToolRunResult } from '@aio/ai';
import {
  assemble,
  type AssembleInput,
  type AssembleResult,
  type UserOverrides,
} from '@aio/modelling';
import { Assembly, type AssemblyKind, type PartStatus, type ProcModel } from '@aio/schema';

/**
 * Executors of the engineering model's correction tools (specs in `@aio/ai` `modelling-tools.ts`):
 * every correction is a person value for the deterministic assembler (`UserOverrides`: user >
 * measured > AI > default), and the model is assembled again on top of the current one, so ids
 * stay, accepted components are kept (and flagged when their values would change) and only the
 * affected components are regenerated. Never a direct geometry edit. No AI call is made here.
 */

/** Inputs as `@aio/ai` `modellingToolInputs` checks them before an executor runs. */
interface EngineerToolInputs {
  list_components: { kind?: AssemblyKind; status?: PartStatus };
  edit_component: {
    component: string;
    set?: Record<string, number | string | boolean>;
    status?: PartStatus;
  };
  set_count: { role: string; count: number };
  set_levels: { role: string; levels: number[] };
  add_component: {
    kind: AssemblyKind;
    role: string;
    name?: string;
    params: Record<string, unknown>;
  };
  remove_component: { component: string; confirm?: boolean };
}

/** The engineering model on screen and the person's corrections it was assembled with. */
export interface EngineerModelSession {
  current(): { model: ProcModel; user: UserOverrides } | null;
  /** Assemble again with `user` on top of the current model; the result becomes current. */
  rebuild(user: UserOverrides): Promise<AssembleResult | { error: string }>;
  /** Set the review status of components (accepted ones survive every later rebuild). */
  setStatus(ids: string[], status: PartStatus): Promise<ProcModel | { error: string }>;
}

let active: EngineerModelSession | null = null;

/**
 * The engineering model the agent's corrections act on: set by whatever shows one (the run store,
 * Task 35) and cleared (null) when it closes.
 */
export function setEngineerSession(session: EngineerModelSession | null): void {
  active = session;
}

export function activeEngineerSession(): EngineerModelSession | null {
  return active;
}

export const emptyOverrides = (): UserOverrides => ({
  params: {},
  counts: {},
  levels: {},
  removed: [],
  added: [],
});

/**
 * A session kept in memory: assembled once from `input`, then corrected through the tools. The
 * engineering run store (Task 35) offers the same interface over its run files.
 */
export function memoryEngineerSession(input: AssembleInput): EngineerModelSession {
  let state = { model: assemble(input).model, user: input.user };
  return {
    current: () => state,
    rebuild: (user) => {
      const r = assemble({ ...input, user, previous: state.model });
      state = { model: r.model, user };
      return Promise.resolve(r);
    },
    setStatus: (ids, status) => {
      const set = new Set(ids);
      const model: ProcModel = {
        ...state.model,
        assemblies: state.model.assemblies.map((a) => (set.has(a.id) ? { ...a, status } : a)),
      };
      state = { ...state, model };
      return Promise.resolve(model);
    },
  };
}

/** The role of an id (`flue-2` to `flue`, `light-l1-3` to `light-l1`). */
export function roleOfId(id: string): string {
  return id.replace(/-\d+$/, '');
}

/** The components `ref` names: the one with that id, else every one of that role. */
function pick(model: ProcModel, ref: string): Assembly[] {
  const one = model.assemblies.find((a) => a.id === ref);
  if (one) return [one];
  return model.assemblies.filter((a) => roleOfId(a.id) === ref);
}

function zodMessage(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 4)
    .map((i) => `${i.path.map(String).join('.')}: ${i.message}`)
    .join('; ');
}

function describe(a: Assembly): Record<string, unknown> {
  return {
    id: a.id,
    role: roleOfId(a.id),
    kind: a.kind,
    name: a.name,
    status: a.status,
    params: a.params,
    basis: Object.fromEntries(Object.entries(a.quality).map(([k, q]) => [k, q.basis])),
  };
}

const result = (r: unknown, summary: string): ToolRunResult => ({ result: r, summary });

function summaryOf(r: AssembleResult): Record<string, unknown> {
  return {
    changed: r.changed,
    flagged: r.flagged,
    ...(r.unresolved.length ? { unresolved: r.unresolved.slice(0, 10) } : {}),
    next: 'A person reviews the changed components in the Model builder.',
  };
}

export function registerEngineerTools(session: () => EngineerModelSession | null): void {
  const open = () => {
    const s = session();
    const cur = s?.current();
    if (!s || !cur) throw new ToolError('No engineering model is open in the Model builder.');
    return { s, ...cur };
  };
  const rebuilt = async (
    s: EngineerModelSession,
    user: UserOverrides,
    what: string,
  ): Promise<ToolRunResult> => {
    const r = await s.rebuild(user);
    if ('error' in r) throw new ToolError(r.error);
    const n = r.changed.length;
    return result(summaryOf(r), `${what}: ${String(n)} component${n === 1 ? '' : 's'} changed`);
  };

  registerRendererTool('list_components', (raw) => {
    const input = raw as EngineerToolInputs['list_components'];
    const { model } = open();
    const list = model.assemblies.filter(
      (a) => (!input.kind || a.kind === input.kind) && (!input.status || a.status === input.status),
    );
    return Promise.resolve(
      result(
        { model: model.id, family: model.family, components: list.map(describe) },
        `${String(list.length)} component${list.length === 1 ? '' : 's'}`,
      ),
    );
  });

  registerRendererTool('edit_component', async (raw) => {
    const input = raw as EngineerToolInputs['edit_component'];
    const { s, model, user } = open();
    const targets = pick(model, input.component);
    if (!targets.length) throw new ToolError(`The model has no component "${input.component}".`);
    let out: ToolRunResult | null = null;
    if (input.set) {
      // each value must fit the component's own bounds: checked on a copy before it is kept
      for (const a of targets) {
        const params: Record<string, unknown> = { ...a.params, ...input.set };
        const parsed = Assembly.safeParse({ ...a, params });
        if (!parsed.success) {
          throw new ToolError(`${a.id} cannot take those values: ${zodMessage(parsed.error)}`);
        }
      }
      // by id for one component, by role for all of them (the assembler reads both)
      const key = input.component;
      const next: UserOverrides = {
        ...user,
        params: { ...user.params, [key]: { ...user.params[key], ...input.set } },
      };
      out = await rebuilt(s, next, `Set ${Object.keys(input.set).join(', ')} on ${key}`);
    }
    if (input.status) {
      const now = s.current()?.model ?? model;
      const ids = pick(now, input.component).map((a) => a.id);
      const r = await s.setStatus(ids, input.status);
      if ('error' in r) throw new ToolError(r.error);
      out ??= result(
        { components: ids, status: input.status },
        `${input.status === 'accepted' ? 'Accepted' : input.status === 'rejected' ? 'Rejected' : 'Reopened'} ${ids.join(', ')}`,
      );
    }
    if (!out) throw new ToolError('Give a status or parameters to set.');
    return out;
  });

  registerRendererTool('set_count', async (raw) => {
    const input = raw as EngineerToolInputs['set_count'];
    const { s, user } = open();
    return rebuilt(
      s,
      { ...user, counts: { ...user.counts, [input.role]: input.count } },
      `${String(input.count)} ${input.role}`,
    );
  });

  registerRendererTool('set_levels', async (raw) => {
    const input = raw as EngineerToolInputs['set_levels'];
    const { s, user } = open();
    const levels = [...input.levels].sort((a, b) => a - b);
    return rebuilt(
      s,
      { ...user, levels: { ...user.levels, [input.role]: levels } },
      `Levels of ${input.role}`,
    );
  });

  registerRendererTool('add_component', async (raw, ctx) => {
    const input = raw as EngineerToolInputs['add_component'];
    const { s, model, user } = open();
    const taken = new Set([...model.assemblies.map((a) => a.id), ...user.added.map((a) => a.id)]);
    let n = 1;
    while (taken.has(`${input.role}-${String(n)}`)) n += 1;
    const candidate = {
      id: `${input.role}-${String(n)}`,
      kind: input.kind,
      name: input.name ?? `${input.role} ${String(n)}`,
      description: "Added by the agent at the person's request.",
      category: 'Added',
      status: 'draft',
      origin: { by: 'agent', runId: `agent-${ctx.now().toISOString()}` },
      quality: {},
      sources: [],
      params: input.params,
    };
    const parsed = Assembly.safeParse(candidate);
    if (!parsed.success) {
      throw new ToolError(`A ${input.kind} cannot take those values: ${zodMessage(parsed.error)}`);
    }
    return rebuilt(s, { ...user, added: [...user.added, parsed.data] }, `Added ${candidate.id}`);
  });

  registerRendererTool('remove_component', async (raw) => {
    const input = raw as EngineerToolInputs['remove_component'];
    const { s, model, user } = open();
    const targets = pick(model, input.component);
    if (!targets.length) throw new ToolError(`The model has no component "${input.component}".`);
    const accepted = targets.filter((a) => a.status === 'accepted').map((a) => a.id);
    if (accepted.length && input.confirm !== true) {
      throw new ToolError(
        `${accepted.join(', ')} ${accepted.length === 1 ? 'was' : 'were'} accepted by a person. Ask them, then remove with confirm: true.`,
      );
    }
    const next: UserOverrides = {
      ...user,
      removed: [...new Set([...user.removed, input.component])],
      added: user.added.filter((a) => a.id !== input.component),
    };
    // a confirmed removal of accepted components: they go back to draft first, so the
    // assembler does not keep them as accepted work
    if (accepted.length) {
      const r = await s.setStatus(accepted, 'draft');
      if ('error' in r) throw new ToolError(r.error);
    }
    return rebuilt(s, next, `Removed ${input.component}`);
  });
}
