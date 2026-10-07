import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { segmentFileName } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { createChainWriter } from './chain';
import { loadJournal } from './load';
import { auditEntries, howOf, pageEntries } from './query';
import { rolesFrom, stripPayload } from './redact';
import { signerFromSeed } from './sign';
import { loadJournalFiles } from './fixtureFiles';
import { verifyJournal } from './verify';

const fixtures = fileURLToPath(new URL('../../schema/src/__fixtures__/journal/', import.meta.url));
const keys = JSON.parse(readFileSync(join(fixtures, 'TEST-ONLY-KEYS.json'), 'utf8')) as {
  people: { name: string; actor: string; chain: string; seed: string }[];
};
const [rana, omar] = keys.people as [(typeof keys.people)[0], (typeof keys.people)[0]];
const NOW = new Date('2026-10-07T12:00:00.000Z');

describe('auditEntries', () => {
  const entries = auditEntries(loadJournal(loadJournalFiles(join(fixtures, 'valid'))));

  it('lists every op newest first with names, labels and how', () => {
    expect(entries).toHaveLength(16);
    expect(entries[0]?.kind).toBe('checkpoint');
    const sev = entries.find((e) => e.label === 'F01 severity 3 to 4');
    expect(sev).toMatchObject({
      actor: { id: rana.actor, name: 'Rana Example', initials: 'RE' },
      how: 'hand',
      state: 'ok',
      changes: [{ field: 'severity', after: 4 }],
    });
    expect(entries.find((e) => e.via && 'agent' in e.via)?.how).toBe('agent');
    expect(entries.find((e) => e.kind === 'issue.status')?.changes).toEqual([
      { field: 'status', before: 'reviewed', after: 'approved' },
    ]);
  });

  it('filters by record, who and how, and pages with a cursor', () => {
    const f01 = { target: { rec: 'issue', id: 'i_f01' } };
    const all = pageEntries(entries, f01, 1000);
    expect(all.entries.length).toBe(10);
    expect(all.cursor).toBeNull();
    const first = pageEntries(entries, f01, 4);
    expect(first.entries).toHaveLength(4);
    const second = pageEntries(entries, f01, 4, first.cursor ?? undefined);
    expect(second.entries[0]?.op).toBe(all.entries[4]?.op);
    expect(
      pageEntries(entries, { actors: [omar.actor] }).entries.every(
        (e) => e.actor.id === omar.actor,
      ),
    ).toBe(true);
    expect(pageEntries(entries, { how: ['agent'] }).entries).toHaveLength(1);
    expect(pageEntries(entries, { kinds: ['comment'] }).entries).toHaveLength(2);
  });

  it('names how a change came about', () => {
    expect(howOf({ via: { pipeline: { name: 'inspection.run', jobId: 'j' } } })).toBe('pipeline');
    expect(howOf({ via: { external: { found: 'open' } } })).toBe('external');
    expect(howOf({ kind: 'record.external' })).toBe('external');
    expect(howOf({ via: { import: { source: 'server' } } })).toBe('server');
    expect(howOf({})).toBe('hand');
  });
});

describe('redaction', () => {
  it('keeps the chain verifiable and shows who redacted', () => {
    const files = loadJournalFiles(join(fixtures, 'valid'));
    const j = loadJournal(files);
    const ranaChain = j.chains.get(rana.chain);
    const seg = ranaChain?.segments.at(-1);
    const lastLine = seg?.lines.at(-1);
    if (!seg || !lastLine?.ok) throw new Error('No tail for Rana');
    const omarFirst = j.chains.get(omar.chain)?.segments[0]?.lines[0];
    if (!omarFirst?.ok) throw new Error('No first op of Omar');
    const target = omarFirst.raw;
    const w = createChainWriter({
      chain: rana.chain,
      actor: rana.actor,
      signer: signerFromSeed(rana.seed),
      tail: {
        seq: Number(lastLine.raw.seq),
        id: String(lastLine.raw.id),
        hlc: String(lastLine.raw.hlc),
        segment: seg.n,
        segmentBytes: 0,
        segmentOps: seg.lines.length,
        sinceCheckpoint: 0,
      },
      now: () => NOW.getTime(),
    });
    const r = w.next({
      kind: 'op.redact',
      target: { rec: 'op', id: String(target.id) },
      payload: { op: target.id, chain: target.chain, seq: target.seq, reason: 'Personal data' },
    });
    files.set(seg.file, (files.get(seg.file) ?? '') + r.line);
    const omarFile = `journal/ops/${omar.chain}/${segmentFileName(1)}`;
    const stripped = stripPayload(files.get(omarFile) ?? '', String(target.id));
    expect(stripped).not.toBeNull();
    files.set(omarFile, stripped ?? '');
    expect(stripPayload(stripped ?? '', String(target.id))).toBeNull();

    const report = verifyJournal(files, { now: NOW });
    expect(report.problems).toEqual([]);
    expect(report.counts.redacted).toBe(1);
    const e = auditEntries(loadJournal(files)).find((x) => x.op === target.id);
    expect(e?.redacted).toEqual({ by: rana.actor, at: r.op.hlc });
  });

  it('reads members and roles from the journal', () => {
    const j = loadJournal(loadJournalFiles(join(fixtures, 'valid')));
    const ops = [...j.chains.values()].flatMap((c) =>
      c.segments.flatMap((s) => s.lines.flatMap((l) => (l.ok ? [{ raw: l.raw }] : []))),
    );
    const roles = rolesFrom(ops);
    expect(roles.get(rana.actor)).toBe('owner');
    expect(roles.get(omar.actor)).toBe('reviewer');
  });
});
