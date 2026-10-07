/**
 * The multi-reviewer workflow (M9 stream T3): comments, assignments, approvals and the team policy
 * (`collab:*`), written as journal ops and read as their projection (data-conventions section 18).
 *
 * Main decides; the renderer only asks. Every write checks the role table, four-eyes and the
 * content hash here, and the agent can never approve: `approve` refuses an agent caller, and
 * `registerCollabIpc` refuses to start when any agent tool could approve (decision 6).
 *
 * Three seams are swappable until their streams land (see "Wiring" in the T3 report):
 * - `CollabJournal`: T1's journal service. Until then `createInterimJournal` appends unsigned
 *   `aio.op/1` lines to `journal/ops/<chain>/` itself (same format, no keys, one segment).
 * - `CollabIdentity`: T2's identity. Until then `createStubIdentity` reads `identity.json` in
 *   userData (T2's file) and falls back to a stable local actor.
 * - `CollabMembers`: T2's members projection. Until then `createStubMembers` folds the
 *   `member.*` ops of the journal.
 */
import {
  approvalOutcome,
  approveRefusal,
  allowed,
  assertAgentCannotApprove,
  changeItemMaterial,
  changeSetMaterial,
  detectionPassMaterial,
  isShared,
  issueMaterial,
  modelMaterial,
  newApprovalId,
  newCommentId,
  parseMentions,
  partMaterial,
  projectCollab,
  refOfTarget,
  reportMaterial,
  sortOps,
  stateOfTarget,
  visibleTo,
  type ApproveRefusal,
  type CollabOp,
  type IssueLike,
} from '@aio/collab';
import { base32, contentHash, createClock, readSegment, sealOp, sha256Hex } from '@aio/journal';
import {
  ApprovalPayload,
  CommentPayload,
  DEFAULT_APPROVAL_POLICY,
  IDENTITY_FILE,
  Identity,
  JOURNAL_OPS_DIR,
  MemberAddPayload,
  MemberRemovePayload,
  MemberRolePayload,
  PROCMODEL_DIR,
  segmentFileName,
  targetKey,
  type ApprovalPolicy,
  type CollabState,
  type CollabTarget,
  type IpcRequest,
  type IpcResponse,
  type OpKind,
  type Role,
  type TeamPolicy,
  type Via,
} from '@aio/schema';
import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { readJson } from './fsutil';
import type { Handle } from './notYet';

// ---------------------------------------------------------------- seams

/** This person as the journal names them. */
export interface Me {
  actor: string;
  name: string;
  initials: string;
}

/** A member as the role checks need them. */
export interface MemberLite extends Me {
  role: Role;
}

/** What an op says before the journal stamps it (chain, seq, clock, hashes, signature). */
export interface OpDraft {
  kind: OpKind;
  target: CollabOp['target'];
  payload: unknown;
  label?: string;
  via?: Via;
}

export interface CollabJournal {
  /** Every op of every chain of the project folder (payload absent when redacted). */
  read(root: string): Promise<CollabOp[]>;
  /** Append one op by `me` (fsync before return). */
  append(root: string, me: Me, draft: OpDraft): Promise<{ id: string; hlc: string }>;
  /** Remove the payloads of these ops from every segment (redaction); returns how many. */
  redactPayloads(root: string, opIds: readonly string[]): Promise<number>;
}

export interface CollabIdentity {
  me(): Promise<Me | null>;
}

export interface CollabMembers {
  list(root: string, ops: readonly CollabOp[]): Promise<MemberLite[]>;
}

/** The projects main has open: a folder (writable) or a package (read only). */
export interface CollabProjects {
  root(id: string): string | undefined;
  package(id: string): unknown;
}

// ---------------------------------------------------------------- interim adapters

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
export function createStubIdentity(opts: {
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
export function createStubMembers(): CollabMembers {
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
export function createInterimJournal(opts: { userData: string }): CollabJournal {
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

// ---------------------------------------------------------------- material content

/** A file or record name that stays inside its folder. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

/**
 * Reads the records approvals sign and hashes their material views (SHA-256 over canonical
 * JSON). Files are read once per request (`preload`), then hashed synchronously.
 */
export function createMaterials(root: string, projectId: string) {
  const files = new Map<string, unknown>();
  const read = async (rel: string) => {
    if (files.has(rel)) return;
    files.set(rel, await readJson(join(root, rel)).catch(() => undefined));
  };
  const fileOf = (t: CollabTarget): string | null => {
    switch (t.kind) {
      case 'issue':
      case 'report':
        return 'issues.json';
      case 'change-set':
        return SAFE_NAME.test(t.id) ? `change/${t.id}.json` : null;
      case 'change-item':
        return t.in && SAFE_NAME.test(t.in) ? `change/${t.in}.json` : null;
      case 'detection-pass':
        return SAFE_NAME.test(t.id) && t.id.endsWith('.json') ? `detections/${t.id}` : null;
      case 'model':
        return SAFE_NAME.test(t.id) ? `${PROCMODEL_DIR}/${t.id}.procmodel.json` : null;
      case 'part':
        return t.in && SAFE_NAME.test(t.in) ? `${PROCMODEL_DIR}/${t.in}.procmodel.json` : null;
      case 'project':
        return null;
    }
  };
  const issues = (): IssueLike[] => {
    const f = files.get('issues.json') as { issues?: IssueLike[] } | undefined;
    return Array.isArray(f?.issues) ? f.issues : [];
  };
  const obj = (rel: string | null) =>
    rel ? (files.get(rel) as Record<string, unknown> | undefined) : undefined;
  const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

  return {
    async preload(targets: readonly CollabTarget[]) {
      await read('issues.json');
      for (const t of targets) {
        const rel = fileOf(t);
        if (rel) await read(rel);
      }
    },
    issues,
    issue(id: string): IssueLike | undefined {
      return issues().find((i) => i.id === id);
    },
    /** The material hash of a target under `fields`; null when it is gone. Call `preload` first. */
    hash(t: CollabTarget, fields: ApprovalPolicy['materialFields']): string | null {
      const f = obj(fileOf(t));
      switch (t.kind) {
        case 'issue': {
          const i = issues().find((x) => x.id === t.id);
          return i ? contentHash(issueMaterial(i, fields)) : null;
        }
        case 'report':
          return t.id === projectId
            ? contentHash(reportMaterial(projectId, issues(), fields))
            : null;
        case 'change-set':
          return f ? contentHash(changeSetMaterial(f)) : null;
        case 'change-item': {
          const item = list(f?.items).find((x) => x.id === t.id);
          return item ? contentHash(changeItemMaterial(item as { id: string })) : null;
        }
        case 'detection-pass':
          return f ? contentHash(detectionPassMaterial(f)) : null;
        case 'model':
          return f ? contentHash(modelMaterial(f)) : null;
        case 'part': {
          const part = list(f?.parts).find((x) => x.id === t.id);
          return part ? contentHash(partMaterial(part)) : null;
        }
        case 'project':
          return contentHash({ project: projectId });
      }
    },
  };
}

/** Issue fields per material field, as `issue.patch` names them. */
const PATCH_FIELDS: Record<string, string[]> = {
  class: ['classId', 'severityModelId'],
  severity: ['severity'],
  measurements: ['measurements'],
  title: ['title'],
  note: ['note'],
};
const MATERIAL_KINDS = new Set([
  'issue.create',
  'issue.sighting.add',
  'issue.sighting.remove',
  'issue.merge',
  'issue.restore',
]);

/**
 * Who made an issue and who last changed it materially (four-eyes). From the journal's issue ops
 * once T1 writes them; before that, the creator is the member whose name the issue's free-text
 * author holds.
 */
export function issueAuthors(
  issue: IssueLike,
  ops: readonly CollabOp[],
  members: readonly MemberLite[],
  fields: ApprovalPolicy['materialFields'],
): { creator: string; lastEditor?: string } {
  const own = sortOps(ops.filter((o) => o.target.rec === 'issue' && o.target.id === issue.id));
  const created = own.find((o) => o.kind === 'issue.create');
  const byName = members.find(
    (m) => m.name.toLocaleLowerCase() === (issue.author ?? '').trim().toLocaleLowerCase(),
  );
  const creator = created?.act ?? byName?.actor ?? '';
  const keys = new Set(fields.flatMap((f) => PATCH_FIELDS[f] ?? []));
  const material = own.filter((o) => {
    if (MATERIAL_KINDS.has(o.kind)) return true;
    if (o.kind !== 'issue.patch') return false;
    const p = o.payload as { set?: Record<string, unknown>; unset?: string[] } | undefined;
    if (!p) return true;
    return [...Object.keys(p.set ?? {}), ...(p.unset ?? [])].some((k) => keys.has(k));
  });
  const last = material.at(-1)?.act;
  return { creator, ...(last && last !== creator ? { lastEditor: last } : {}) };
}

// ---------------------------------------------------------------- the service

interface Fail {
  ok: false;
  error: string;
  code?: 'forbidden' | 'read-only';
}
const fail = (error: string, code?: Fail['code']): Fail => ({
  ok: false,
  error,
  ...(code ? { code } : {}),
});

const REFUSAL: Record<ApproveRefusal, string> = {
  agent: 'Only a person can approve. The assistant cannot.',
  'not-shared': 'Approvals need a shared project. Use the status buttons instead.',
  role: 'Your role in this project cannot do this.',
  'four-eyes': 'Another reviewer must approve this. You made it or last changed it.',
  already: 'You have already approved this.',
  'not-reviewed': 'Mark it reviewed before approving.',
  'acceptance-off': 'Client acceptance is switched off for this project.',
};

export interface CollabDeps {
  projects: CollabProjects;
  journal: CollabJournal;
  identity: CollabIdentity;
  members: CollabMembers;
}

/** How a write came about: the agent may comment and assign, never approve. */
export interface CallerContext {
  via?: Via;
}

const isAgent = (ctx: CallerContext | undefined) => Boolean(ctx?.via && 'agent' in ctx.via);

export function createCollabService(deps: CollabDeps) {
  const { projects, journal, identity, members: memberSource } = deps;

  async function load(projectId: string) {
    const root = projects.root(projectId);
    if (root === undefined) return null;
    const ops = await journal.read(root);
    const members = await memberSource.list(root, ops);
    const me = await identity.me();
    const shared = isShared(ops);
    const roles = new Map(members.map((m) => [m.actor, m.role]));
    const roleOf = (a: string): Role | undefined => (shared ? roles.get(a) : undefined);
    const isOwner = (a: string) => roleOf(a) === 'owner';
    const materials = createMaterials(root, projectId);
    const targets = ops
      .filter((o) => o.kind === 'approval.add')
      .map((o) => (o.payload as { target?: CollabTarget } | undefined)?.target)
      .filter((t): t is CollabTarget => Boolean(t));
    await materials.preload(targets);
    const fieldsOf = (p: TeamPolicy | null) =>
      (p?.approval ?? DEFAULT_APPROVAL_POLICY).materialFields;
    const state = projectCollab(ops, {
      isOwner,
      materialHashOf: (t, p) => materials.hash(t, fieldsOf(p)),
    });
    const policy = state.policy?.approval ?? DEFAULT_APPROVAL_POLICY;
    const myRole = me ? roleOf(me.actor) : undefined;
    return { root, ops, members, me, shared, roleOf, isOwner, materials, state, policy, myRole };
  }
  type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

  /** A writable, open project and a known person, or why not. */
  async function writable(projectId: string): Promise<(Loaded & { me: Me }) | Fail> {
    if (projects.package(projectId))
      return fail('This project is a read-only package. Nothing can be changed.', 'read-only');
    const l = await load(projectId);
    if (!l) return fail(`Project "${projectId}" is not open.`);
    if (!l.me) return fail('Set your name in Settings first.');
    return { ...l, me: l.me };
  }

  const isFail = (v: unknown): v is Fail =>
    typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;

  /** A short label for history ("F03", "change register c1-c2-issues"). */
  function labelOf(l: Loaded, t: CollabTarget): string {
    switch (t.kind) {
      case 'issue':
        return l.materials.issue(t.id)?.code ?? t.id;
      case 'change-item':
        return `change ${t.id}`;
      case 'change-set':
        return `change register ${t.id}`;
      case 'detection-pass':
        return `detection pass ${t.id}`;
      case 'part':
        return `part ${t.id}`;
      case 'model':
        return `model ${t.id}`;
      case 'report':
        return 'the report';
      case 'project':
        return 'the project';
    }
  }
  const nameOf = (l: Loaded, actor: string) =>
    l.members.find((m) => m.actor === actor)?.name ?? (l.me?.actor === actor ? l.me.name : actor);

  /** Comment permission for a visibility: unshared projects have no roles (one person). */
  function mayComment(l: Loaded, visibility: 'team' | 'client'): boolean {
    if (!l.shared) return true;
    return allowed(visibility === 'client' ? 'comment.client' : 'comment.team', l.myRole, l.policy);
  }

  function mentionsOf(l: Loaded, text: string, asked: readonly string[] = []): string[] {
    const known = new Set(l.members.map((m) => m.actor));
    const found = parseMentions(text, l.members);
    return [...new Set([...asked.filter((a) => known.has(a)), ...found])];
  }

  /** For an issue: its authors and status; others have neither. */
  function targetFacts(
    l: Loaded,
    t: CollabTarget,
  ): { hash: string | null; creator: string; lastEditor?: string; status?: string } {
    const hash = l.materials.hash(t, l.policy.materialFields);
    const issue = t.kind === 'issue' ? l.materials.issue(t.id) : undefined;
    if (!issue) return { hash, creator: '' };
    return {
      hash,
      ...issueAuthors(issue, l.ops, l.members, l.policy.materialFields),
      ...(issue.status ? { status: issue.status } : {}),
    };
  }

  return {
    async read(req: IpcRequest<'collab:read'>): Promise<IpcResponse<'collab:read'>> {
      if (projects.package(req.projectId)) {
        const empty: CollabState = { comments: [], assignments: [], approvals: [], policy: null };
        return { ok: true, state: empty };
      }
      const l = await load(req.projectId);
      if (!l) return fail(`Project "${req.projectId}" is not open.`);
      const state = visibleTo(req.target ? stateOfTarget(l.state, req.target) : l.state, l.myRole);
      return { ok: true, state };
    },

    async comment(
      req: IpcRequest<'collab:comment'>,
      ctx?: CallerContext,
    ): Promise<IpcResponse<'collab:comment'>> {
      const l = await writable(req.projectId);
      if (isFail(l)) return l;
      const visibility = req.visibility ?? 'team';
      if (!mayComment(l, visibility)) return fail(REFUSAL.role, 'forbidden');
      if (req.replyTo && !l.state.comments.some((c) => c.id === req.replyTo))
        return fail('The comment you reply to is gone.');
      const parsed = CommentPayload.safeParse({
        id: newCommentId(),
        target: req.target,
        text: req.text,
        visibility,
        mentions: mentionsOf(l, req.text, req.mentions),
        ...(req.view ? { view: req.view } : {}),
        ...(req.replyTo ? { replyTo: req.replyTo } : {}),
      });
      if (!parsed.success)
        return fail(parsed.error.issues[0]?.message ?? 'The comment is not valid.');
      await journal.append(l.root, l.me, {
        kind: 'comment.add',
        target: refOfTarget(req.target),
        payload: parsed.data,
        label: `Comment on ${labelOf(l, req.target)}`,
        ...(ctx?.via ? { via: ctx.via } : {}),
      });
      return { ok: true, id: parsed.data.id };
    },

    async editComment(
      req: IpcRequest<'collab:editComment'>,
    ): Promise<IpcResponse<'collab:editComment'>> {
      const l = await writable(req.projectId);
      if (isFail(l)) return l;
      const c = l.state.comments.find((x) => x.id === req.id);
      if (!c || c.deleted || c.redacted) return fail('This comment is gone.');
      if (c.author !== l.me.actor) return fail('Only the author can edit a comment.', 'forbidden');
      await journal.append(l.root, l.me, {
        kind: 'comment.edit',
        target: refOfTarget(c.target),
        payload: { id: c.id, text: req.text, mentions: mentionsOf(l, req.text) },
        label: `Comment on ${labelOf(l, c.target)} edited`,
      });
      return { ok: true };
    },

    async deleteComment(
      req: IpcRequest<'collab:deleteComment'>,
    ): Promise<IpcResponse<'collab:deleteComment'>> {
      const l = await writable(req.projectId);
      if (isFail(l)) return l;
      const c = l.state.comments.find((x) => x.id === req.id);
      if (!c || c.deleted || c.redacted) return fail('This comment is gone.');
      if (c.author !== l.me.actor && !l.isOwner(l.me.actor))
        return fail('Only the author or an owner can delete a comment.', 'forbidden');
      await journal.append(l.root, l.me, {
        kind: 'comment.delete',
        target: refOfTarget(c.target),
        payload: { id: c.id },
        label: `Comment on ${labelOf(l, c.target)} deleted`,
      });
      return { ok: true };
    },

    /**
     * Owner only: remove the text of every version of a comment from every copy. The redaction op
     * names the ops whose payloads go, so Verify accepts them missing (`comment.redact`).
     */
    async redactComment(req: {
      projectId: string;
      id: string;
      reason?: string;
    }): Promise<{ ok: true; removed: number } | Fail> {
      const l = await writable(req.projectId);
      if (isFail(l)) return l;
      if (!l.isOwner(l.me.actor)) return fail('Only an owner can redact a comment.', 'forbidden');
      const c = l.state.comments.find((x) => x.id === req.id);
      if (!c || c.redacted) return fail('This comment is gone.');
      const ops = l.ops
        .filter(
          (o) =>
            (o.kind === 'comment.add' || o.kind === 'comment.edit') &&
            (o.payload as { id?: string } | undefined)?.id === req.id,
        )
        .map((o) => o.id);
      if (!ops.length) return fail('This comment has nothing left to redact.');
      await journal.append(l.root, l.me, {
        kind: 'comment.redact',
        target: refOfTarget(c.target),
        payload: { id: req.id, ops, ...(req.reason ? { reason: req.reason } : {}) },
        label: `Comment on ${labelOf(l, c.target)} redacted`,
      });
      const removed = await journal.redactPayloads(l.root, ops);
      return { ok: true, removed };
    },

    async assign(
      req: IpcRequest<'collab:assign'>,
      ctx?: CallerContext,
    ): Promise<IpcResponse<'collab:assign'>> {
      const l = await writable(req.projectId);
      if (isFail(l)) return l;
      if (l.shared && !allowed('assign', l.myRole, l.policy))
        return fail(REFUSAL.role, 'forbidden');
      if (req.assignee !== null) {
        const known = l.shared
          ? l.members.some((m) => m.actor === req.assignee && m.role !== 'client')
          : req.assignee === l.me.actor;
        if (!known) return fail('That person is not a member of this project.');
      }
      const who = req.assignee ? nameOf(l, req.assignee) : null;
      await journal.append(l.root, l.me, {
        kind: 'assign.set',
        target: refOfTarget(req.target),
        payload: {
          target: req.target,
          assignee: req.assignee,
          ...(req.due ? { due: req.due } : {}),
          ...(req.note ? { note: req.note } : {}),
        },
        label: who
          ? `${labelOf(l, req.target)} assigned to ${who}`
          : `${labelOf(l, req.target)} unassigned`,
        ...(ctx?.via ? { via: ctx.via } : {}),
      });
      return { ok: true };
    },

    /**
     * Approve, request changes or accept. Main computes the content hash. The agent never gets
     * here (decision 6): a caller with `via.agent` is refused before anything else.
     */
    async approve(
      req: IpcRequest<'collab:approve'>,
      ctx?: CallerContext,
    ): Promise<IpcResponse<'collab:approve'>> {
      if (isAgent(ctx)) return fail(REFUSAL.agent, 'forbidden');
      const l = await writable(req.projectId);
      if (isFail(l)) return l;
      await l.materials.preload([req.target]);
      const facts = targetFacts(l, req.target);
      if (facts.hash === null) return fail('This item is not in the project any more.');
      const mine = l.state.approvals.filter(
        (a) => a.by === l.me.actor && targetKey(a.target) === targetKey(req.target),
      );
      const refusal = approveRefusal({
        decision: req.decision,
        me: l.me.actor,
        role: l.myRole,
        shared: l.shared,
        policy: l.policy,
        target: { creator: facts.creator, lastEditor: facts.lastEditor, materialHash: facts.hash },
        mine,
        status: facts.status,
      });
      if (refusal)
        return fail(
          REFUSAL[refusal],
          refusal === 'already' || refusal === 'not-reviewed' ? undefined : 'forbidden',
        );
      const payload = ApprovalPayload.safeParse({
        id: newApprovalId(),
        target: req.target,
        decision: req.decision,
        contentHash: facts.hash,
        ...(req.comment?.trim() ? { comment: req.comment.trim() } : {}),
      });
      if (!payload.success)
        return fail(payload.error.issues[0]?.message ?? 'Not a valid approval.');
      const label = labelOf(l, req.target);
      await journal.append(l.root, l.me, {
        kind: 'approval.add',
        target: refOfTarget(req.target),
        payload: payload.data,
        label:
          req.decision === 'approve'
            ? `${label} approved by ${l.me.name}`
            : req.decision === 'accept'
              ? `${label} accepted by ${l.me.name}`
              : `Changes requested on ${label}`,
      });
      if (req.decision !== 'approve') return { ok: true, approved: false };
      const after = await load(req.projectId);
      if (!after) return { ok: true, approved: false };
      const outcome = approvalOutcome(
        l.policy,
        after.state.approvals.filter((a) => targetKey(a.target) === targetKey(req.target)),
        {
          creator: facts.creator,
          lastEditor: facts.lastEditor,
          materialHash: facts.hash,
          roleOf: after.roleOf,
        },
      );
      return { ok: true, approved: outcome.approved && facts.status !== 'approved' };
    },

    async withdraw(req: IpcRequest<'collab:withdraw'>): Promise<IpcResponse<'collab:withdraw'>> {
      const l = await writable(req.projectId);
      if (isFail(l)) return l;
      const a = l.state.approvals.find((x) => x.id === req.id);
      if (!a || a.withdrawn) return fail('This approval is gone.');
      if (a.by !== l.me.actor)
        return fail('Only the person who approved can withdraw.', 'forbidden');
      await journal.append(l.root, l.me, {
        kind: 'approval.withdraw',
        target: refOfTarget(a.target),
        payload: { id: a.id },
        label: `${labelOf(l, a.target)} approval withdrawn`,
      });
      return { ok: true };
    },

    async policy(req: IpcRequest<'collab:policy'>): Promise<IpcResponse<'collab:policy'>> {
      const l = await writable(req.projectId);
      if (isFail(l)) return l;
      if (!l.shared) return fail('Share the project first.');
      if (!l.isOwner(l.me.actor)) return fail('Only an owner can change the policy.', 'forbidden');
      await journal.append(l.root, l.me, {
        kind: 'policy.set',
        target: { rec: 'policy', id: 'team' },
        payload: req.policy,
        label: 'Approval policy changed',
      });
      return { ok: true };
    },
  };
}

export type CollabService = ReturnType<typeof createCollabService>;

// ---------------------------------------------------------------- IPC

export interface CollabIpcDeps {
  handle: Handle;
  projects: CollabProjects;
  /** userData: the interim adapters derive ids from it and read `identity.json` there. */
  userData: string;
  journal?: CollabJournal;
  identity?: CollabIdentity;
  members?: CollabMembers;
  /** Every tool the agent may be offered: checked at start, none may approve (decision 6). */
  agentTools?: () => readonly string[];
}

export function registerCollabIpc(deps: CollabIpcDeps): CollabService {
  if (deps.agentTools) assertAgentCannotApprove(deps.agentTools());
  const { handle, projects } = deps;
  const service = createCollabService({
    projects,
    journal: deps.journal ?? createInterimJournal({ userData: deps.userData }),
    identity: deps.identity ?? createStubIdentity({ userData: deps.userData }),
    members: deps.members ?? createStubMembers(),
  });
  handle('collab:read', (req) => service.read(req));
  handle('collab:comment', (req) => service.comment(req));
  handle('collab:editComment', (req) => service.editComment(req));
  handle('collab:deleteComment', (req) => service.deleteComment(req));
  handle('collab:assign', (req) => service.assign(req));
  // The renderer's Approve button only: no agent route exists to this channel (decision 6).
  handle('collab:approve', (req) => service.approve(req));
  handle('collab:withdraw', (req) => service.withdraw(req));
  handle('collab:policy', (req) => service.policy(req));
  return service;
}
