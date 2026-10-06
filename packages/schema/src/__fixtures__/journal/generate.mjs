#!/usr/bin/env node
/* eslint-disable no-console -- generator output */
// Golden journal fixtures (M9 T0): a valid three-device history and one copy per tamper case.
//
//   node packages/schema/src/__fixtures__/journal/generate.mjs     (or: pnpm fixtures:journal)
//
// Deterministic: the keys come from fixed seeds, Ed25519 signatures are deterministic, and every
// time is a fixed clock, so running it again gives the same bytes. It is deliberately a second,
// dependency-free implementation of the journal format (data-conventions section 17), so the
// fixtures check @aio/journal and tools/audit-verify rather than echo them.
//
// The three people are fictional ("Rana Example", "Omar Sample", "Lina Test", @example.com) and
// their keys are TEST-ONLY: public in this repository, never trusted outside tests.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- primitives

/** RFC 8785 JSON canonicalisation (keys sorted by UTF-16 code units, ES number and string forms). */
export function jcs(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS: numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
  }
  throw new Error(`JCS: cannot encode ${typeof value}`);
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const sha256Bytes = (data) => createHash('sha256').update(data).digest();

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

function keyFromSeed(seedHex) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, Buffer.from(seedHex, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const raw = spki.subarray(spki.length - 32);
  return { privateKey, raw, b64: raw.toString('base64url') };
}

/** Ed25519 over `<domain>\n<hash>` (UTF-8). */
const signHash = (privateKey, domain, hash) =>
  sign(null, Buffer.from(`${domain}\n${hash}`, 'utf8'), privateKey).toString('base64url');

const without = (obj, keys) =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));

const BASE_MS = Date.UTC(2026, 9, 1, 6, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const hlc = (ms, counter, dev) =>
  `${String(ms).padStart(13, '0')}.${String(counter).padStart(4, '0')}.${dev}`;

// ---------------------------------------------------------------- people and devices (TEST-ONLY)

const PEOPLE = [
  { key: 'rana', name: 'Rana Example', initials: 'RE', email: 'rana@example.com', role: 'owner' },
  { key: 'omar', name: 'Omar Sample', initials: 'OS', email: 'omar@example.com', role: 'reviewer' },
  { key: 'lina', name: 'Lina Test', initials: 'LT', email: 'lina@example.com', role: 'reviewer' },
];

const APP = { name: 'test-app', version: '0.9.0' };
const TEAM = `t_${base32(sha256Bytes('aio-fixture:team')).slice(0, 26)}`;

const people = Object.fromEntries(
  PEOPLE.map((p) => {
    const seed = sha256(`aio-fixture:TEST-ONLY-device-seed:${p.key}`);
    const k = keyFromSeed(seed);
    const dev = `d_${base32(sha256Bytes(k.raw))}`;
    const actor = `a_${base32(sha256Bytes(`aio-fixture:actor:${p.key}`)).slice(0, 26)}`;
    const replica = `r_${base32(sha256Bytes(`aio-fixture:replica:${p.key}`)).slice(0, 16)}`;
    return [p.key, { ...p, seed, ...k, dev, actor, replica, chain: `${dev}.${replica}` }];
  }),
);
const { rana, omar, lina } = people;

function deviceCert(issuer, subject, at) {
  const cert = {
    level: 'owner',
    issuer: { actor: issuer.actor, device: issuer.dev },
    actor: subject.actor,
    device: subject.dev,
    issuedAt: iso(at),
  };
  return { ...cert, sig: signHash(issuer.privateKey, 'aio.cert/1', sha256(jcs(cert))) };
}

function deviceRecord(p, certs) {
  const rec = {
    schema: 'aio.device/1',
    id: p.dev,
    alg: 'ed25519',
    key: p.b64,
    actor: p.actor,
    name: p.name,
    initials: p.initials,
    label: 'TEST-ONLY fixture device',
    app: APP,
    createdAt: iso(BASE_MS - 3_600_000),
    certs,
  };
  return { ...rec, sig: signHash(p.privateKey, 'aio.device/1', sha256(jcs(rec))) };
}

// ---------------------------------------------------------------- chains

/** One device's chain: ops in order, split into segments where `rotateAfter` says. */
function chainOf(p, rotateAfter = []) {
  return { p, ops: [], segments: [[]], rotateAfter, counter: 0, lastMs: 0 };
}

function append(c, ms, kind, target, payload, extra = {}) {
  const seq = c.ops.length + 1;
  const counter = ms === c.lastMs ? c.counter + 1 : 0;
  c.lastMs = ms;
  c.counter = counter;
  const op = {
    v: 1,
    chain: c.p.chain,
    dev: c.p.dev,
    act: c.p.actor,
    seq,
    hlc: hlc(ms, counter, c.p.dev),
    prev: seq === 1 ? null : c.ops[seq - 2].id,
    ...(extra.deps ? { deps: extra.deps } : {}),
    kind,
    target,
    ...(extra.base ? { base: extra.base } : {}),
    ph: sha256(jcs(payload)),
    ...(extra.via ? { via: extra.via } : {}),
    ...(extra.label ? { label: extra.label } : {}),
  };
  const id = sha256(jcs(op));
  const full = {
    v: 1,
    id,
    ...without(op, ['v']),
    payload,
    sig: signHash(c.p.privateKey, 'aio.op/1', id),
  };
  // keep the field order of the plan: v, id, chain, dev, act, seq, hlc, prev, deps, kind, ...
  const ordered = {};
  for (const k of [
    'v',
    'id',
    'chain',
    'dev',
    'act',
    'seq',
    'hlc',
    'prev',
    'deps',
    'kind',
    'target',
    'base',
    'ph',
    'payload',
    'via',
    'label',
    'sig',
  ]) {
    if (full[k] !== undefined) ordered[k] = full[k];
  }
  c.ops.push(ordered);
  c.segments[c.segments.length - 1].push(ordered);
  if (c.rotateAfter.includes(seq)) c.segments.push([]);
  return ordered;
}

const head = (c) => c.ops[c.ops.length - 1];
const depsOn = (...chains) => Object.fromEntries(chains.map((c) => [c.p.chain, head(c).id]));

// ---------------------------------------------------------------- the valid history

function history() {
  const R = chainOf(rana, [6]);
  const O = chainOf(omar);
  const L = chainOf(lina);
  let t = BASE_MS;
  const next = () => (t += 60_000);

  const issue = {
    id: 'i_f01',
    code: 'F01',
    classId: 'corrosion',
    severityModelId: 'sev-5',
    severity: 3,
    status: 'draft',
    title: 'Corrosion on flange',
    note: '',
    author: rana.name,
    createdAt: iso(BASE_MS),
    updatedAt: iso(BASE_MS),
    sightings: [
      {
        on: 'mesh',
        layer: 'site-mesh',
        geom: { type: 'spoint', p: [1.5, 2, -3], n: [0, 1, 0] },
      },
    ],
    source: 'human',
  };
  const issueRef = { rec: 'issue', id: issue.id };
  const target = { kind: 'issue', id: issue.id };
  const member = (p, cert) => ({
    actor: p.actor,
    name: p.name,
    initials: p.initials,
    email: p.email,
    role: p.role,
    devices: [{ id: p.dev, key: p.b64 }],
    ...(cert ? { cert } : {}),
  });
  const certOmar = deviceCert(rana, omar, BASE_MS);
  const certLina = deviceCert(rana, lina, BASE_MS);

  append(
    R,
    next(),
    'project.share',
    { rec: 'project', id: TEAM },
    {
      teamProjectId: TEAM,
      name: 'Demo site (synthetic)',
    },
  );
  append(R, next(), 'member.add', { rec: 'member', id: rana.actor }, member(rana));
  append(R, next(), 'member.add', { rec: 'member', id: omar.actor }, member(omar, certOmar));
  append(R, next(), 'member.add', { rec: 'member', id: lina.actor }, member(lina, certLina));
  append(
    R,
    next(),
    'policy.set',
    { rec: 'policy', id: 'team' },
    {
      approval: { required: 2, fourEyes: true },
    },
  );
  append(R, next(), 'issue.create', issueRef, { record: issue }, { label: 'Add F01' });
  // segment 2 of Rana's chain starts here
  append(
    R,
    next(),
    'issue.patch',
    issueRef,
    { set: { severity: 4 } },
    {
      base: sha256(jcs(issue)),
      label: 'F01 severity 3 to 4',
    },
  );
  append(
    O,
    next(),
    'comment.add',
    issueRef,
    {
      id: 'cm_aaaaaaaaaaaaaaaa',
      target,
      text: 'Weld seam looks pitted; please check the flange.',
      visibility: 'team',
      mentions: [],
    },
    { deps: depsOn(R) },
  );
  const sighting = {
    on: 'image',
    layer: 'photos',
    photo: 'p_0007',
    geom: { type: 'box', x: 120, y: 80, w: 64, h: 48 },
  };
  append(
    L,
    next(),
    'issue.sighting.add',
    issueRef,
    { hash: sha256(jcs(sighting)), sighting },
    { deps: depsOn(R, O), label: 'Add a sighting to F01' },
  );
  append(
    O,
    next(),
    'assign.set',
    issueRef,
    { target, assignee: lina.actor, due: '2026-10-09' },
    {
      deps: depsOn(L),
    },
  );
  append(
    L,
    next(),
    'comment.add',
    issueRef,
    {
      id: 'cm_bbbbbbbbbbbbbbbb',
      target,
      text: '@Omar Sample checked on site; photo attached.',
      visibility: 'team',
      mentions: [omar.actor],
    },
    {
      deps: depsOn(O),
      via: { agent: { conversation: 'c_fixture', callId: 't1', provider: 'local', model: 'test' } },
    },
  );
  append(
    O,
    next(),
    'issue.status',
    issueRef,
    { from: 'draft', to: 'reviewed' },
    {
      deps: depsOn(L),
      label: 'F01 to reviewed',
    },
  );
  const material = sha256('aio-fixture:F01 material content after review');
  append(
    L,
    next(),
    'approval.add',
    issueRef,
    {
      id: 'ap_cccccccccccccccc',
      target,
      decision: 'approve',
      contentHash: material,
    },
    { deps: depsOn(O) },
  );
  append(
    O,
    next(),
    'approval.add',
    issueRef,
    {
      id: 'ap_dddddddddddddddd',
      target,
      decision: 'approve',
      contentHash: material,
    },
    { deps: depsOn(L) },
  );
  append(
    R,
    next(),
    'issue.status',
    issueRef,
    { from: 'reviewed', to: 'approved' },
    {
      deps: depsOn(O, L),
      label: 'F01 approved',
    },
  );

  // a signed checkpoint over every head, then the checkpoint op
  const ms = next();
  const heads = Object.fromEntries(
    [R, O, L]
      .map((c) => [c.p.chain, { seq: head(c).seq, id: head(c).id }])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  const cpHlc = hlc(ms, 0, rana.dev);
  const cp = {
    schema: 'aio.checkpoint/1',
    chain: rana.chain,
    dev: rana.dev,
    act: rana.actor,
    hlc: cpHlc,
    seq: head(R).seq,
    heads,
    count: R.ops.length + O.ops.length + L.ops.length,
    root: merkleRoot(heads),
  };
  const cpId = sha256(jcs(cp));
  const checkpoint = { ...cp, id: cpId, sig: signHash(rana.privateKey, 'aio.checkpoint/1', cpId) };
  const cpFile = `${String(ms).padStart(13, '0')}.0000.${rana.chain}.json`;
  append(
    R,
    ms + 1,
    'checkpoint',
    { rec: 'project', id: TEAM },
    {
      file: cpFile,
      root: cp.root,
      count: cp.count,
    },
  );

  return { R, O, L, checkpoint, cpFile, devices: { certOmar, certLina } };
}

/** Merkle root over heads sorted by chain: leaf SHA-256("<chain> <seq> <id>"), node SHA-256(l + r). */
function merkleRoot(heads) {
  let level = Object.keys(heads)
    .sort()
    .map((chain) => sha256(`${chain} ${heads[chain].seq} ${heads[chain].id}`));
  if (level.length === 0) return sha256('');
  while (level.length > 1) {
    const up = [];
    for (let i = 0; i < level.length; i += 2) {
      up.push(i + 1 < level.length ? sha256(level[i] + level[i + 1]) : level[i]);
    }
    level = up;
  }
  return level[0];
}

// ---------------------------------------------------------------- writing

const line = (op) => `${JSON.stringify(op)}\n`;
const segName = (n) => `${String(n).padStart(6, '0')}.jsonl`;

function writeJournal(root, h) {
  rmSync(root, { recursive: true, force: true });
  const devs = join(root, 'journal', 'devices');
  mkdirSync(devs, { recursive: true });
  const records = [
    deviceRecord(rana, []),
    deviceRecord(omar, [h.devices.certOmar]),
    deviceRecord(lina, [h.devices.certLina]),
  ];
  for (const r of records)
    writeFileSync(join(devs, `${r.id}.json`), `${JSON.stringify(r, null, 2)}\n`);
  for (const c of [h.R, h.O, h.L]) {
    const dir = join(root, 'journal', 'ops', c.p.chain);
    mkdirSync(dir, { recursive: true });
    c.segments
      .filter((s) => s.length > 0)
      .forEach((s, i) => writeFileSync(join(dir, segName(i + 1)), s.map(line).join('')));
  }
  const cps = join(root, 'journal', 'checkpoints');
  mkdirSync(cps, { recursive: true });
  writeFileSync(join(cps, h.cpFile), `${JSON.stringify(h.checkpoint, null, 2)}\n`);
}

const rel = (c, n) => `journal/ops/${c.p.chain}/${segName(n)}`;

function readLines(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean);
}
function writeLines(file, lines) {
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
}
/** Replace line `n` (1-based) of a segment with what `edit` returns. */
function editLine(root, relFile, n, edit) {
  const file = join(root, relFile);
  const lines = readLines(file);
  lines[n - 1] = edit(lines[n - 1]);
  writeLines(file, lines);
}

function main() {
  const h = history();
  const valid = join(here, 'valid');
  writeJournal(valid, h);
  const tampered = join(here, 'tampered');
  rmSync(tampered, { recursive: true, force: true });

  /** Each case: a description, what Verify must report (at least), and how to make it. */
  const cases = {};
  const add = (name, description, expect, make) => {
    const root = join(tampered, name);
    cpSync(valid, root, { recursive: true });
    make(root);
    cases[name] = { description, ok: expect.length === 0, expect };
  };

  add(
    'edited-payload',
    'A letter of Lina\'s comment text changed in Notepad: the payload no longer hashes to "ph".',
    [{ code: 'payload-hash', file: rel(h.L, 1), line: 2, seq: 2 }],
    (root) => editLine(root, rel(h.L, 1), 2, (l) => l.replace('photo attached', 'photo deleted')),
  );
  add(
    'edited-line',
    "The label of Rana's severity edit changed: the op fields no longer hash to its id.",
    [{ code: 'hash-mismatch', file: rel(h.R, 2), line: 1, seq: 7 }],
    (root) => editLine(root, rel(h.R, 2), 1, (l) => l.replace('3 to 4', '3 to 2')),
  );
  add(
    'removed-line',
    "Rana's third op (adding Omar) was deleted from segment 1.",
    [{ code: 'chain-gap', file: rel(h.R, 1), line: 3, seq: 4 }],
    (root) => {
      const file = join(root, rel(h.R, 1));
      writeLines(
        file,
        readLines(file).filter((_, i) => i !== 2),
      );
    },
  );
  add(
    'reordered',
    "Omar's second and third ops swapped places in his segment.",
    [{ code: 'order', file: rel(h.O, 1), line: 2 }],
    (root) => {
      const file = join(root, rel(h.O, 1));
      const lines = readLines(file);
      [lines[1], lines[2]] = [lines[2], lines[1]];
      writeLines(file, lines);
    },
  );
  add(
    'truncated-tail',
    "Omar's last op (his approval) was cut off; Rana's later op and the checkpoint reference it.",
    [{ code: 'truncated', chain: omar.chain, seq: 4 }],
    (root) => {
      const file = join(root, rel(h.O, 1));
      writeLines(file, readLines(file).slice(0, -1));
    },
  );
  add(
    'dropped-segment',
    "Rana's first segment file is missing; segment 2 and the other chains reference its ops.",
    [{ code: 'segment-missing', file: rel(h.R, 1), chain: rana.chain }],
    (root) => rmSync(join(root, rel(h.R, 1))),
  );
  add(
    'forked-chain',
    "A copied folder kept writing Lina's chain: a second, validly signed op claims her seq 3.",
    [{ code: 'fork', file: rel(h.L, 1), line: 4, seq: 3 }],
    (root) => {
      // Lina's chain as it was after seq 2, continued by the copy with a different op
      const L2 = chainOf(lina);
      for (const op of h.L.ops.slice(0, 2)) {
        L2.ops.push(op);
        L2.segments[0].push(op);
      }
      L2.lastMs = Number(h.L.ops[1].hlc.slice(0, 13));
      const forked = append(
        L2,
        BASE_MS + 30 * 60_000,
        'comment.add',
        { rec: 'issue', id: 'i_f01' },
        {
          id: 'cm_eeeeeeeeeeeeeeee',
          target: { kind: 'issue', id: 'i_f01' },
          text: 'Written in a copied folder.',
          visibility: 'team',
          mentions: [],
        },
      );
      const file = join(root, rel(h.L, 1));
      writeLines(file, [...readLines(file), JSON.stringify(forked)]);
    },
  );
  add(
    'bad-signature',
    "Omar's first op carries a signature made with Lina's key.",
    [{ code: 'bad-signature', file: rel(h.O, 1), line: 1, seq: 1 }],
    (root) =>
      editLine(root, rel(h.O, 1), 1, (l) => {
        const op = JSON.parse(l);
        op.sig = signHash(lina.privateKey, 'aio.op/1', op.id);
        return JSON.stringify(op);
      }),
  );
  add(
    'payload-stripped',
    "The payload of Omar's first comment was removed and no redaction op names it.",
    [{ code: 'payload-missing', file: rel(h.O, 1), line: 1, seq: 1 }],
    (root) =>
      editLine(root, rel(h.O, 1), 1, (l) => JSON.stringify(without(JSON.parse(l), ['payload']))),
  );
  add(
    'redacted-payload',
    "Legitimate redaction: Rana (owner) redacts Omar's first comment with an op.redact op; the " +
      'payload is gone, the chain still verifies (counts.redacted = 1).',
    [],
    (root) => {
      editLine(root, rel(h.O, 1), 1, (l) => JSON.stringify(without(JSON.parse(l), ['payload'])));
      const target = h.O.ops[0];
      const R2 = { ...h.R, ops: [...h.R.ops], segments: [[]], rotateAfter: [] };
      const ms = Number(head(h.R).hlc.slice(0, 13)) + 60_000;
      const redact = append(
        R2,
        ms,
        'op.redact',
        { rec: 'op', id: target.id },
        { op: target.id, chain: target.chain, seq: target.seq, reason: 'Personal data' },
        { deps: { [omar.chain]: head(h.O).id, [lina.chain]: head(h.L).id } },
      );
      const file = join(root, rel(h.R, 2));
      writeLines(file, [...readLines(file), JSON.stringify(redact)]);
    },
  );

  writeFileSync(join(here, 'cases.json'), `${JSON.stringify(cases, null, 2)}\n`);
  writeFileSync(
    join(here, 'TEST-ONLY-KEYS.json'),
    `${JSON.stringify(
      {
        warning:
          'TEST-ONLY Ed25519 seeds for the golden journal fixtures. They are public in this repository: never trust them outside tests.',
        testOnly: true,
        team: TEAM,
        people: PEOPLE.map((p) => {
          const x = people[p.key];
          return {
            name: x.name,
            initials: x.initials,
            email: x.email,
            role: x.role,
            actor: x.actor,
            device: x.dev,
            replica: x.replica,
            chain: x.chain,
            publicKey: x.b64,
            seed: x.seed,
          };
        }),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Journal fixtures written: valid and ${Object.keys(cases).length} tampered cases.`);
}

main();
