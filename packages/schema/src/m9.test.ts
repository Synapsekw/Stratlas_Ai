import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ALWAYS_ALLOWED,
  ApprovalPayload,
  ApprovalPolicy,
  BoundaryEdit,
  ChangeReview,
  Checkpoint,
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_HOSTING,
  DEFAULT_JOURNAL_POLICY,
  DEFAULT_TEAM_POLICY,
  Detection,
  DetectionOrigin,
  DeviceRecord,
  ENTITLEMENTS,
  EXPORT_FORMAT_KIND,
  ExchangeHeader,
  Hlc,
  Issue,
  IssueStatus,
  NarrativeFile,
  NarrativeVersion,
  OP_KINDS,
  OP_PAYLOADS,
  OP_PERMISSION,
  Op,
  PERMISSIONS,
  PackageHeader,
  ProcPart,
  REPORT_SECTIONS,
  Settings,
  allowAll,
  blobPath,
  can,
  checkpointFileName,
  ipc,
  ipcEvents,
  isKnownOpKind,
  missingBlobHeader,
  parseMissingBlobHeader,
  readerFor,
  setEntitlementProvider,
  verifiedAtLeast,
} from './index';

const here = fileURLToPath(new URL('.', import.meta.url));
const journalFixtures = join(here, '__fixtures__', 'journal');

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

/** Keys of an object schema, or of every option of a union of object schemas. */
function keysOf(schema: z.ZodType): string[] {
  const def = (schema as unknown as { def: { type: string } }).def;
  if (def.type === 'object') return Object.keys((schema as z.ZodObject).shape).sort();
  if (def.type === 'union') {
    const options = (schema as unknown as { options: z.ZodType[] }).options;
    return [...new Set(options.flatMap(keysOf))].sort();
  }
  throw new Error(`Not an object schema: ${def.type}`);
}

describe('M9 additive rule: no new field inside existing records', () => {
  it('round-trips an 0.8-shaped issues.json unchanged through the 0.9 schemas', () => {
    const raw = readJson(join(here, '__fixtures__', 'compat-0.8', 'issues.json'));
    const IssuesFile = z.object({ schema: z.literal('aio.issues/1'), issues: z.array(Issue) });
    const parsed = IssuesFile.parse(raw);
    expect(parsed).toEqual(raw);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(raw));
  });

  // Pinned at 0.8.0. A new key here would be stripped (Issue) or refused (strict records) by an
  // 0.8 build: collaboration data goes into journal ops and their projections instead.
  it('keeps the 0.8 key sets of Issue and the strict review records', () => {
    expect(keysOf(Issue)).toEqual([
      'author',
      'capture',
      'classId',
      'code',
      'createdAt',
      'id',
      'measurements',
      'note',
      'resolvedIn',
      'severity',
      'severityModelId',
      'sightings',
      'source',
      'status',
      'title',
      'track',
      'updatedAt',
    ]);
    expect(IssueStatus.options).toEqual(['draft', 'reviewed', 'approved', 'closed']);
    expect(keysOf(ChangeReview)).toEqual(['at', 'by', 'issueId', 'note', 'status']);
    expect(keysOf(DetectionOrigin)).toEqual([
      'author',
      'model',
      'promptVersion',
      'provider',
      'runId',
    ]);
    expect(keysOf(Detection)).toMatchInlineSnapshot(`
      [
        "bbox",
        "class",
        "component",
        "confidence",
        "createdAt",
        "frame",
        "geom",
        "height",
        "id",
        "issueId",
        "label",
        "note",
        "origin",
        "photo",
        "reviewedAt",
        "reviewedBy",
        "severity",
        "sheet",
        "source",
        "space",
        "status",
        "uncertain",
        "updatedAt",
        "width",
      ]
    `);
    expect(keysOf(BoundaryEdit)).toMatchInlineSnapshot(`
      [
        "areaM2",
        "author",
        "autoNet",
        "epoch",
        "heightM",
        "pile",
        "ring",
        "topM",
        "updatedAt",
        "volumes",
      ]
    `);
    expect(keysOf(NarrativeFile)).toEqual(['parts', 'schema']);
    expect(keysOf(NarrativeVersion)).toEqual([
      'author',
      'createdAt',
      'model',
      'provider',
      'source',
      'text',
    ]);
    expect(keysOf(ProcPart)).toMatchInlineSnapshot(`
      [
        "base",
        "baseY",
        "center",
        "class",
        "confidence",
        "diameter",
        "footprint",
        "height",
        "id",
        "kind",
        "name",
        "origin",
        "points",
        "radius",
        "roof",
        "roofHeight",
        "size",
        "status",
        "tag",
        "yawDeg",
      ]
    `);
  });

  it('adds only optional fields to the package header, settings and library entries', () => {
    const old = { schema: 'aio.package/1', projectId: 'p', createdAt: '2026-10-01T06:00:00Z' };
    expect(PackageHeader.parse(old).reply).toBeUndefined();
    const header = PackageHeader.parse({
      ...old,
      journal: 'summary',
      reply: {
        teamProjectId: `t_${'a'.repeat(26)}`,
        ownerKey: 'A'.repeat(43),
        comments: true,
        acceptance: true,
      },
    });
    expect(header.journal).toBe('summary');
    // non-strict: an older player strips what it does not know instead of refusing the package
    expect(PackageHeader.safeParse({ ...old, futureField: 1 }).success).toBe(true);
    const settings = {
      cloudAi: false,
      theme: 'dark',
      sidebarCollapsed: false,
      dataRoot: 'D:/Data',
      routes: [],
    };
    expect(Settings.safeParse(settings).success).toBe(true);
    expect(
      Settings.safeParse({
        ...settings,
        team: { autoSync: true, intervalMin: 15, blobCacheGb: 50 },
      }).success,
    ).toBe(true);
    expect(REPORT_SECTIONS).toContain('audit');
    expect(REPORT_SECTIONS).toContain('approvals');
    expect(EXPORT_FORMAT_KIND['audit-csv']).toBe('files');
  });
});

describe('M9 golden journal fixtures', () => {
  const valid = join(journalFixtures, 'valid');

  it('parse with the op, device and checkpoint schemas, payloads included', () => {
    const files = filesUnder(valid);
    const ops = files
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean))
      .map((l) => JSON.parse(l) as unknown);
    expect(ops.length).toBeGreaterThan(15);
    for (const raw of ops) {
      const op = Op.parse(raw);
      expect(isKnownOpKind(op.kind)).toBe(true);
      if (isKnownOpKind(op.kind)) OP_PAYLOADS[op.kind].parse(op.payload);
    }
    const devices = files.filter((f) => f.includes('devices'));
    expect(devices).toHaveLength(3);
    for (const f of devices) {
      const d = DeviceRecord.parse(readJson(f));
      expect(d.label).toMatch(/TEST-ONLY/);
    }
    const checkpoints = files.filter((f) => f.includes('checkpoints'));
    expect(checkpoints).toHaveLength(1);
    const cp = Checkpoint.parse(readJson(checkpoints[0] ?? ''));
    expect(checkpoints[0]?.endsWith(checkpointFileName(cp.hlc, cp.chain))).toBe(true);
  });

  it('list every tamper case of the plan with the problem Verify must name', () => {
    const cases = readJson(join(journalFixtures, 'cases.json')) as Record<
      string,
      { ok: boolean; expect: { code: string }[] }
    >;
    expect(Object.keys(cases).sort()).toEqual([
      'bad-signature',
      'dropped-segment',
      'edited-line',
      'edited-payload',
      'forked-chain',
      'payload-stripped',
      'redacted-payload',
      'removed-line',
      'reordered',
      'truncated-tail',
    ]);
    for (const [name, c] of Object.entries(cases)) {
      expect(existsSync(join(journalFixtures, 'tampered', name, 'journal'))).toBe(true);
      expect(c.ok).toBe(c.expect.length === 0);
    }
    const keys = readJson(join(journalFixtures, 'TEST-ONLY-KEYS.json')) as { testOnly: boolean };
    expect(keys.testOnly).toBe(true);
  });
});

describe('M9 contracts', () => {
  it('orders clock readings as strings', () => {
    const dev = `d_${'a'.repeat(52)}`;
    const a = Hlc.parse(`1790000000000.0001.${dev}`);
    const b = Hlc.parse(`1790000000000.0002.${dev}`);
    expect(a < b).toBe(true);
    expect(Hlc.safeParse('1790000000000.1.d_x').success).toBe(false);
  });

  it('names a payload schema and a permission for every op kind', () => {
    expect(Object.keys(OP_PAYLOADS).sort()).toEqual([...OP_KINDS].sort());
    expect(Object.keys(OP_PERMISSION).sort()).toEqual([...OP_KINDS].sort());
    expect(isKnownOpKind('issue.patch')).toBe(true);
    expect(isKnownOpKind('issue.future-kind')).toBe(false);
  });

  it('keeps the plan defaults for the founder decisions, as data', () => {
    expect(DEFAULT_APPROVAL_POLICY).toEqual({
      required: 1,
      fourEyes: true,
      closeBy: 'owner',
      viewersMayComment: false,
      clientAcceptance: 'record',
      materialFields: ['class', 'severity', 'sightings', 'measurements', 'status'],
    });
    expect(ApprovalPolicy.safeParse({ required: 6 }).success).toBe(false);
    expect(DEFAULT_TEAM_POLICY.minVerification).toBe('self');
    expect(DEFAULT_TEAM_POLICY.packageHistory).toBe('summary');
    expect(DEFAULT_JOURNAL_POLICY).toEqual({
      defaultOn: true,
      allowOffPrivate: true,
      allowOffTeam: false,
    });
    expect(DEFAULT_HOSTING).toEqual({
      modes: ['off', 'exchange', 'hub', 'server'],
      server: 'preview',
      hosted: false,
    });
    expect(verifiedAtLeast('owner', 'self')).toBe(true);
    expect(verifiedAtLeast('self', 'owner')).toBe(false);
  });

  it('requires a comment to request changes, and never lets a viewer approve', () => {
    const base = {
      id: 'ap_aaaaaaaaaaaaaaaa',
      target: { kind: 'issue', id: 'i1' },
      contentHash: 'a'.repeat(64),
    };
    expect(ApprovalPayload.safeParse({ ...base, decision: 'approve' }).success).toBe(true);
    expect(ApprovalPayload.safeParse({ ...base, decision: 'changes-requested' }).success).toBe(
      false,
    );
    expect(PERMISSIONS.approve.roles).not.toContain('viewer');
    expect(PERMISSIONS.approve.roles).not.toContain('client');
  });

  it('formats the missing-blob header and blob paths', () => {
    const sha = 'b'.repeat(64);
    expect(parseMissingBlobHeader(missingBlobHeader(sha, 12))).toEqual({ sha256: sha, size: 12 });
    expect(parseMissingBlobHeader('present')).toBeNull();
    expect(blobPath(sha)).toBe(`blobs/bb/${sha}`);
  });

  it('refuses a newer file version with an update message', () => {
    expect(readerFor('aio.op/1').kind).toBe('current');
    const newer = readerFor('aio.issues/2', 'Quadrion AI');
    expect(newer.kind).toBe('newer');
    if (newer.kind === 'newer') expect(newer.message).toMatch(/newer version of Quadrion AI/);
    expect(readerFor('aio.nothing/1').kind).toBe('unknown');
  });

  describe('entitlements seam', () => {
    afterEach(() => {
      setEntitlementProvider(allowAll);
    });
    it('allows everything in M9, and never refuses reading, pulling and Verify', () => {
      for (const e of ENTITLEMENTS) expect(can(e)).toBe(true);
      setEntitlementProvider({ can: () => false });
      for (const e of ALWAYS_ALLOWED) expect(can(e)).toBe(true);
      expect(can('collab.approve')).toBe(false);
    });
  });

  it('declares every M9 channel and event', () => {
    const channels = [
      'identity:get',
      'identity:set',
      'identity:exportCard',
      'identity:importCard',
      'members:list',
      'members:add',
      'members:setRole',
      'members:remove',
      'members:revokeDevice',
      'journal:history',
      'journal:verify',
      'journal:redact',
      'audit:export',
      'collab:read',
      'collab:comment',
      'collab:editComment',
      'collab:deleteComment',
      'collab:assign',
      'collab:approve',
      'collab:withdraw',
      'collab:policy',
      'team:share',
      'team:status',
      'team:leave',
      'sync:now',
      'sync:conflicts',
      'sync:resolve',
      'sync:quarantine',
      'sync:release',
      'exchange:plan',
      'exchange:export',
      'exchange:preview',
      'exchange:import',
      'exchange:reply',
      'blobs:status',
      'blobs:fetch',
      'blobs:cancel',
      'blobs:policy',
      'blobs:index',
      'server:enrol',
      'server:list',
      'server:forget',
    ];
    for (const c of channels) expect(Object.keys(ipc)).toContain(c);
    for (const e of ['journal:changed', 'sync:progress', 'exchange:progress', 'blobs:progress']) {
      expect(Object.keys(ipcEvents)).toContain(e);
    }
    const commands = [{ label: 'F01 to reviewed', ids: ['i_f01'] }];
    expect(
      ipc['project:writeIssues'].request.safeParse({ projectId: 'p', issues: [], commands })
        .success,
    ).toBe(true);
    expect(
      ipc['journal:verify'].response.safeParse({
        ok: false,
        error: 'x',
        code: 'not-implemented',
      }).success,
    ).toBe(true);
  });

  it('signs the exchange header and keeps unknown keys of newer writers', () => {
    const dev = `d_${'a'.repeat(52)}`;
    const header = {
      schema: 'aio.exchange/1',
      id: 'x_aaaaaaaaaaaaaaaa',
      kind: 'patch',
      teamProjectId: `t_${'a'.repeat(26)}`,
      createdAt: '2026-10-07T08:00:00Z',
      from: {
        actor: `a_${'a'.repeat(26)}`,
        device: dev,
        name: 'Rana Example',
        app: { name: 'test-app', version: '0.9.0' },
      },
      since: { all: true },
      chains: [],
      heads: {},
      counts: { ops: 0, devices: 0, blobs: 0, bytes: 0 },
      encrypted: false,
      sig: 'A'.repeat(86),
      laterField: { x: 1 },
    };
    const parsed = ExchangeHeader.parse(header);
    expect((parsed as Record<string, unknown>).laterField).toEqual({ x: 1 });
  });
});
