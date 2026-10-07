/**
 * Executors of the review workflow tools (M9 stream T3): `list_my_work`, `show_thread`,
 * `add_comment`, `request_approval`. Everything goes through main (`collab:*`), which checks roles;
 * none of these can reach the approve channel (decision 6).
 */
import type { AioBridge, CollabState, CommentView, Member } from '@aio/schema';
import { collabToolInputs, type CollabToolName } from './collab-tool-specs';
import {
  findIssue,
  project,
  registerRendererTool,
  ToolError,
  type RendererToolContext,
  type ToolRunResult,
} from './tool-kit';

interface Person {
  actor: string;
  name: string;
  initials: string;
}

function bridge(): AioBridge {
  const aio = (globalThis as { aio?: AioBridge }).aio;
  if (!aio) throw new ToolError('Review work is kept by the desktop app only.');
  return aio;
}

async function read(projectId: string): Promise<CollabState> {
  const r = await bridge().invoke('collab:read', { projectId });
  if (!r.ok) throw new ToolError(r.error);
  return r.state;
}

async function people(projectId: string): Promise<{ members: Person[]; me: Person | null }> {
  const aio = bridge();
  const [m, i] = await Promise.all([
    aio.invoke('members:list', { projectId }).catch(() => null),
    aio.invoke('identity:get', {}).catch(() => null),
  ]);
  const members: Person[] = m?.ok
    ? m.members.map((x: Member) => ({ actor: x.actor, name: x.name, initials: x.initials }))
    : [];
  const me = i?.ok
    ? { actor: i.identity.actor, name: i.identity.name, initials: i.identity.initials }
    : null;
  return { members, me };
}

/** A member by full name, first name or initials (case does not matter). */
export function findPerson(list: readonly Person[], ref: string): Person {
  const q = ref.trim().replace(/^@/, '').toLocaleLowerCase();
  const hits = list.filter(
    (p) =>
      p.name.toLocaleLowerCase() === q ||
      p.initials.toLocaleLowerCase() === q ||
      p.name.toLocaleLowerCase().split(/\s+/)[0] === q,
  );
  if (hits.length === 1 && hits[0]) return hits[0];
  if (hits.length > 1)
    throw new ToolError(
      `"${ref}" names more than one member: ${hits.map((h) => h.name).join(', ')}.`,
    );
  throw new ToolError(
    list.length
      ? `No member "${ref}". Members: ${list.map((p) => `${p.name} (${p.initials})`).join(', ')}.`
      : 'This project has no members yet: it is not shared.',
  );
}

const codeOf = (ctx: RendererToolContext, id: string) =>
  ctx.workspace.getState().issues.find((i) => i.id === id)?.code ?? id;

function define<N extends CollabToolName>(
  name: N,
  run: (
    input: ReturnType<(typeof collabToolInputs)[N]['parse']>,
    ctx: RendererToolContext,
  ) => Promise<ToolRunResult>,
): void {
  registerRendererTool(name, (input, ctx) =>
    run(
      collabToolInputs[name].parse(input) as ReturnType<(typeof collabToolInputs)[N]['parse']>,
      ctx,
    ),
  );
}

define('list_my_work', async (input, ctx) => {
  const p = project(ctx);
  const [state, who] = await Promise.all([read(p.id), people(p.id)]);
  const person = input.person ? findPerson(who.members, input.person) : who.me;
  if (!person) throw new ToolError('Set your name in Settings first, or name a person.');
  const name = (a: string) => who.members.find((m) => m.actor === a)?.name ?? a;
  const label = (t: { kind: string; id: string }) =>
    t.kind === 'issue' ? codeOf(ctx, t.id) : `${t.kind} ${t.id}`;
  const issues = ctx.workspace.getState().issues;
  const assigned = state.assignments
    .filter((a) => a.assignee === person.actor)
    .map((a) => ({ item: label(a.target), due: a.due ?? null, by: name(a.by) }));
  const mentions = state.comments
    .filter((c: CommentView) => c.mentions.includes(person.actor) && !c.deleted && !c.redacted)
    .map((c) => ({ item: label(c.target), by: name(c.author), text: c.text }));
  const approvedBy = new Set(
    state.approvals
      .filter((a) => a.by === person.actor && a.decision === 'approve' && a.current && !a.withdrawn)
      .map((a) => `${a.target.kind}:${a.target.id}`),
  );
  const awaiting = state.policy
    ? state.assignments
        .filter((a) => a.assignee === person.actor)
        .filter(
          (a) =>
            !approvedBy.has(`${a.target.kind}:${a.target.id}`) &&
            (a.target.kind !== 'issue' ||
              issues.find((i) => i.id === a.target.id)?.status === 'reviewed'),
        )
        .map((a) => ({ item: label(a.target) }))
    : [];
  const pick = input.list;
  return {
    result: {
      person: person.name,
      ...(pick === 'all' || pick === 'assigned' ? { assigned } : {}),
      ...(pick === 'all' || pick === 'mentions' ? { mentions } : {}),
      ...(pick === 'all' || pick === 'awaiting' ? { awaiting } : {}),
      note: 'Only a person can approve, in the app. You can ask with request_approval.',
    },
    summary: `${String(assigned.length)} assigned to ${person.name}`,
  };
});

define('show_thread', async (input, ctx) => {
  const p = project(ctx);
  const issue = findIssue(ctx, input.issue);
  const ws = ctx.workspace.getState();
  const before = ws.selection;
  const [state, who] = await Promise.all([read(p.id), people(p.id)]);
  const name = (a: string) => who.members.find((m) => m.actor === a)?.name ?? a;
  const thread = state.comments.filter(
    (c) => c.target.kind === 'issue' && c.target.id === issue.id,
  );
  ws.select({ kind: 'issue', id: issue.id });
  const view = [...thread].reverse().find((c) => c.view)?.view;
  if (view) {
    const [px, py, pz] = view.camera.position;
    const [tx, ty, tz] = view.camera.target;
    const dir: [number, number, number] = [px - tx, py - ty, pz - tz];
    ws.flyTo({
      kind: 'point',
      p: view.camera.target,
      dir,
      distance: Math.max(Math.hypot(...dir), 0.5),
    });
  }
  return {
    result: {
      issue: issue.code,
      comments: thread.map((c) => ({
        by: name(c.author),
        text: c.deleted ? '(deleted)' : c.redacted ? '(removed by an owner)' : c.text,
        visibility: c.visibility,
      })),
      approvals: state.approvals
        .filter((a) => a.target.kind === 'issue' && a.target.id === issue.id && !a.withdrawn)
        .map((a) => ({ by: name(a.by), decision: a.decision, current: a.current })),
    },
    summary: `${issue.code}: ${String(thread.length)} comment${thread.length === 1 ? '' : 's'}`,
    undo: () => {
      ctx.workspace.getState().select(before);
    },
  };
});

define('add_comment', async (input, ctx) => {
  const p = project(ctx);
  const issue = findIssue(ctx, input.issue);
  const r = await bridge().invoke('collab:comment', {
    projectId: p.id,
    target: { kind: 'issue', id: issue.id },
    text: input.text,
    visibility: input.visibility,
  });
  if (!r.ok) throw new ToolError(r.error);
  return { result: { ok: true, issue: issue.code }, summary: `Comment on ${issue.code}` };
});

define('request_approval', async (input, ctx) => {
  const p = project(ctx);
  const issue = findIssue(ctx, input.issue);
  const who = await people(p.id);
  const person = findPerson(who.members, input.person);
  const aio = bridge();
  const target = { kind: 'issue' as const, id: issue.id };
  const a = await aio.invoke('collab:assign', {
    projectId: p.id,
    target,
    assignee: person.actor,
    ...(input.due ? { due: input.due } : {}),
  });
  if (!a.ok) throw new ToolError(a.error);
  const first = person.name.split(/\s+/)[0] ?? person.name;
  const c = await aio.invoke('collab:comment', {
    projectId: p.id,
    target,
    text: `@${first} please review and approve ${issue.code}.${input.note ? ` ${input.note}` : ''}`,
    mentions: [person.actor],
  });
  if (!c.ok) throw new ToolError(c.error);
  return {
    result: {
      ok: true,
      issue: issue.code,
      assignedTo: person.name,
      note: 'Only a person approves.',
    },
    summary: `${issue.code} sent to ${person.name} for approval`,
  };
});
