#!/usr/bin/env node
/* eslint-disable no-console -- build script output */
// The team demo (M9 stream T3): adds a review journal to a synthetic project folder: the project
// shared by "Rana Example" (owner) with "Omar Sample" and "Lina Test" (reviewers), and, in the
// demo scenario, an assignment, a thread with a mention and a saved view, a reply, an approval and
// a client-visible comment. Fictional people only (@example.com); never run it on client data.
//
//   node tools/demo/team.mjs <projectDir> [--scenario demo|shared]
//   node tools/demo/team.mjs --identity <userDataDir> <rana|omar|lina>
//
// Ops are unsigned `aio.op/1` lines (no device keys before T2), one chain per person, with fixed
// clocks: running it twice gives the same bytes. T4's history generator replaces the hand-written
// ops when it lands (open conflicts need its merge engine).
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const projectRequire = createRequire(join(repo, 'packages', 'project', 'package.json'));
const { createJiti } = projectRequire('jiti');
const jiti = createJiti(import.meta.url);
const journal = await jiti.import(join(repo, 'packages', 'journal', 'src', 'index.ts'));
const collab = await jiti.import(join(repo, 'packages', 'collab', 'src', 'index.ts'));
const schema = await jiti.import(join(repo, 'packages', 'schema', 'src', 'index.ts'));

const sha = (s) => createHash('sha256').update(s).digest();
const actorOf = (key) => `a_${journal.base32(sha(`aio.demo-actor\n${key}`)).slice(0, 26)}`;
const deviceOf = (key) => `d_${journal.base32(sha(`aio.demo-device\n${key}`))}`;
const replicaOf = (key) => `r_${journal.base32(sha(`aio.demo-replica\n${key}`)).slice(0, 16)}`;
const keyOf = (key) => sha(`aio.demo-key\n${key}`).toString('base64url');

/** The fictional team. */
export const PEOPLE = {
  rana: { name: 'Rana Example', initials: 'RE', email: 'rana@example.com', role: 'owner' },
  omar: { name: 'Omar Sample', initials: 'OS', email: 'omar@example.com', role: 'reviewer' },
  lina: { name: 'Lina Test', initials: 'LT', email: 'lina@example.com', role: 'reviewer' },
};
for (const [key, p] of Object.entries(PEOPLE)) {
  p.key = key;
  p.actor = actorOf(key);
  p.device = deviceOf(key);
  p.chain = `${p.device}.${replicaOf(key)}`;
}

/** `userData/identity.json` for one of the team (T2's file; the T3 stub identity reads it). */
export function identityOf(key) {
  const p = PEOPLE[key];
  if (!p) throw new Error(`No demo person "${key}"`);
  return {
    schema: 'aio.identity/1',
    actor: p.actor,
    name: p.name,
    initials: p.initials,
    email: p.email,
    createdAt: '2026-10-07T08:00:00.000Z',
  };
}

export async function writeIdentity(userDataDir, key) {
  await mkdir(userDataDir, { recursive: true });
  await writeFile(
    join(userDataDir, 'identity.json'),
    `${JSON.stringify(identityOf(key), null, 2)}\n`,
  );
}

/** Appends ops chain by chain, with fixed clocks and the other chains' heads as deps. */
function createWriter(start) {
  const heads = new Map();
  const lines = new Map();
  let tick = 0;
  return {
    add(person, kind, target, payload, label) {
      tick += 1;
      const ms = start + tick * 60_000;
      const hlc = journal.formatHlc({ ms, counter: 0, device: person.device });
      const head = heads.get(person.chain);
      const deps = Object.fromEntries(
        [...heads].filter(([c]) => c !== person.chain).map(([c, h]) => [c, h.id]),
      );
      const op = journal.sealOp(
        {
          v: 1,
          chain: person.chain,
          dev: person.device,
          act: person.actor,
          seq: (head?.seq ?? 0) + 1,
          hlc,
          prev: head?.id ?? null,
          ...(Object.keys(deps).length ? { deps } : {}),
          kind,
          target,
          ...(label ? { label } : {}),
        },
        payload,
      );
      heads.set(person.chain, { seq: op.seq, id: op.id });
      lines.set(person.chain, [...(lines.get(person.chain) ?? []), JSON.stringify(op)]);
      return op;
    },
    lines,
  };
}

const ids = (prefix, n) => `${prefix}${journal.base32(sha(`aio.demo-${prefix}${n}`)).slice(0, 16)}`;

/**
 * Write the team journal into `projectDir` (replacing the demo chains). `shared`: the share and
 * the members only (tests start there). `demo`: plus the review work on the first issues (F03 and
 * F05 when the project has them).
 */
export async function writeTeamJournal(projectDir, { scenario = 'demo' } = {}) {
  const { rana, omar, lina } = PEOPLE;
  const w = createWriter(Date.UTC(2026, 9, 7, 8, 0, 0));
  w.add(
    rana,
    'project.share',
    { rec: 'project', id: 'team' },
    { teamProjectId: 'demo-team', name: 'Demo team project' },
    'Project shared',
  );
  for (const p of [rana, omar, lina])
    w.add(
      rana,
      'member.add',
      { rec: 'member', id: p.actor },
      {
        actor: p.actor,
        name: p.name,
        initials: p.initials,
        email: p.email,
        role: p.role,
        devices: [{ id: p.device, key: keyOf(p.key) }],
      },
      `${p.name} added as ${p.role}`,
    );

  let summary = { ops: 1 + 3, issues: [] };
  if (scenario === 'demo') {
    const file = JSON.parse(await readFile(join(projectDir, 'issues.json'), 'utf8'));
    const issues = Array.isArray(file.issues) ? file.issues : [];
    const pick = (code, n) => issues.find((i) => i.code === code) ?? issues[n];
    const f03 = pick('F03', 0);
    const f05 = pick('F05', 1);
    if (!f03 || !f05) throw new Error('The team demo needs a project with at least two issues.');
    const t3 = { kind: 'issue', id: f03.id };
    const t5 = { kind: 'issue', id: f05.id };
    const ref = (t) => ({ rec: t.kind, id: t.id });
    w.add(
      rana,
      'assign.set',
      ref(t3),
      { target: t3, assignee: omar.actor, due: '2026-10-09' },
      `${f03.code} assigned to ${omar.name}`,
    );
    const c1 = ids('cm_', 1);
    w.add(
      rana,
      'comment.add',
      ref(t3),
      {
        id: c1,
        target: t3,
        text: `@Omar please check the weld on ${f03.code}.`,
        visibility: 'team',
        mentions: [omar.actor],
      },
      `Comment on ${f03.code}`,
    );
    w.add(
      omar,
      'comment.add',
      ref(t3),
      {
        id: ids('cm_', 2),
        target: t3,
        text: 'On it, I will look at the close-up photos today.',
        visibility: 'team',
        mentions: [],
        replyTo: c1,
      },
      `Comment on ${f03.code}`,
    );
    const hash = journal.contentHash(
      collab.issueMaterial(f05, schema.DEFAULT_APPROVAL_POLICY.materialFields),
    );
    w.add(
      lina,
      'approval.add',
      ref(t5),
      { id: ids('ap_', 1), target: t5, decision: 'approve', contentHash: hash },
      `${f05.code} approved by ${lina.name}`,
    );
    w.add(
      lina,
      'comment.add',
      ref(t5),
      {
        id: ids('cm_', 3),
        target: t5,
        text: `${f05.code} is confirmed and ready for the client.`,
        visibility: 'client',
        mentions: [],
      },
      `Comment on ${f05.code}`,
    );
    summary = { ops: 4 + 5, issues: [f03.code, f05.code] };
  }

  for (const p of [rana, omar, lina]) {
    const dir = join(projectDir, schema.JOURNAL_OPS_DIR, p.chain);
    await rm(dir, { recursive: true, force: true });
    const lines = w.lines.get(p.chain);
    if (!lines) continue;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, schema.segmentFileName(1)), `${lines.join('\n')}\n`);
  }
  return summary;
}

const args = process.argv.slice(2);
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (args[0] === '--identity') {
    const [, dir, key] = args;
    if (!dir || !key) throw new Error('Usage: team.mjs --identity <userDataDir> <rana|omar|lina>');
    await writeIdentity(resolve(dir), key);
    console.log(`Wrote ${PEOPLE[key].name} to ${join(resolve(dir), 'identity.json')}`);
  } else {
    const dir = args[0];
    if (!dir) throw new Error('Usage: team.mjs <projectDir> [--scenario demo|shared]');
    const i = args.indexOf('--scenario');
    const scenario = i >= 0 ? args[i + 1] : 'demo';
    const r = await writeTeamJournal(resolve(dir), { scenario });
    console.log(
      `Team journal: ${String(r.ops)} ops${r.issues.length ? ` on ${r.issues.join(', ')}` : ''}`,
    );
  }
}
