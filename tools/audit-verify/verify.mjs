#!/usr/bin/env node
/* eslint-disable no-console -- command line output */
// Stratlas audit verify: an independent check of a project's journal (the audit trail).
//
//   node verify.mjs <project folder | audit .json> [--json] [--now <iso time>]
//
// Needs Node 20 or later and nothing else: it uses only Node's own modules, so a customer can read
// every line of it. It checks the same things as Verify in the app (data-conventions section 17):
// hash chains, payload hashes, Ed25519 signatures, forks, gaps, order, missing segments, cut-off
// ends, checkpoints, redactions and revoked devices, and prints the audit head (a Merkle root
// over every chain's last entry) that reports print in their footer.
//
// Exit code: 0 when the journal is intact, 1 when there are problems, 2 when the input cannot be
// read or the command is wrong.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---- constants of the journal format (packages/schema/src/journal.ts)

const JOURNAL_OPS_DIR = 'journal/ops';
const CLOCK_AHEAD_NOTICE_MS = 5 * 60 * 1000;
const OP_ID_EXCLUDES = ['id', 'payload', 'sig'];
const AUDIT_SCHEMA = 'aio.audit/1';

const segmentFileName = (n) => `${String(n).padStart(6, '0')}.jsonl`;

// ---- primitives: canonical JSON (RFC 8785), SHA-256, Ed25519

/** RFC 8785 JSON Canonicalization Scheme: keys sorted by UTF-16 code units, no whitespace. */
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON has no NaN or Infinity.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new Error(`Canonical JSON cannot encode a ${typeof value}.`);
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const contentHash = (value) => sha256Hex(canonicalJson(value));
const without = (obj, keys) =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
const opId = (op) => contentHash(without(op, OP_ID_EXCLUDES));

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** A public key object from a raw base64url Ed25519 key, or null. */
function publicKeyObject(publicKey) {
  try {
    return createPublicKey({
      key: Buffer.concat([SPKI_ED25519, Buffer.from(publicKey, 'base64url')]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/** Check an Ed25519 signature over `<domain>\n<hash>` (UTF-8). */
function verifySignature(publicKey, domain, hash, signature) {
  try {
    const key = typeof publicKey === 'string' ? publicKeyObject(publicKey) : publicKey;
    if (!key) return false;
    const message = Buffer.from(`${domain}\n${hash}`, 'utf8');
    return edVerify(null, message, key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * The audit head: Merkle root over chain heads sorted by chain id. Leaf SHA-256 of
 * `<chain> <seq> <id>`, node SHA-256 of the two child hex strings, an odd node carried up.
 */
export function merkleRoot(heads) {
  let level = Object.keys(heads)
    .sort()
    .map((chain) => {
      const h = heads[chain];
      return sha256Hex(`${chain} ${String(h?.seq)} ${h?.id ?? ''}`);
    });
  if (level.length === 0) return sha256Hex('');
  while (level.length > 1) {
    const up = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i] ?? '';
      const r = level[i + 1];
      up.push(r === undefined ? l : sha256Hex(l + r));
    }
    level = up;
  }
  return level[0] ?? '';
}

function checkOp(raw, publicKey) {
  const id = typeof raw.id === 'string' && opId(raw) === raw.id;
  const payload = 'payload' in raw ? contentHash(raw.payload) === raw.ph : null;
  const signature =
    typeof raw.sig === 'string' && publicKey && typeof raw.id === 'string'
      ? verifySignature(publicKey, 'aio.op/1', raw.id, raw.sig)
      : null;
  return { id, payload, signature };
}

function checkCheckpoint(raw, publicKey) {
  const id = typeof raw.id === 'string' && contentHash(without(raw, ['id', 'sig'])) === raw.id;
  const heads = raw.heads;
  let root = false;
  if (heads && typeof heads === 'object' && !Array.isArray(heads)) {
    try {
      root = merkleRoot(heads) === raw.root;
    } catch {
      root = false;
    }
  }
  const signature =
    typeof raw.sig === 'string' && publicKey && typeof raw.id === 'string'
      ? verifySignature(publicKey, 'aio.checkpoint/1', raw.id, raw.sig)
      : null;
  return { id, root, signature };
}

function checkDeviceRecord(raw) {
  if (typeof raw.key !== 'string' || typeof raw.sig !== 'string') return false;
  return verifySignature(raw.key, 'aio.device/1', contentHash(without(raw, ['sig'])), raw.sig);
}

// ---- loading: files into devices, chains (segments in order) and checkpoints

const OPS_RE = /^journal\/ops\/([^/]+)\/(\d{6})\.jsonl$/;
const DEVICE_RE = /^journal\/devices\/([^/]+)\.json$/;
const CHECKPOINT_RE = /^journal\/checkpoints\/[^/]+\.json$/;

function parseObject(text) {
  try {
    const v = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** Split a `.jsonl` segment into numbered lines (1-based). Blank lines are skipped. */
function readSegment(text) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    const s = l.trim();
    if (s === '') return;
    try {
      const raw = JSON.parse(s);
      out.push(
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? { line: i + 1, ok: true, raw }
          : { line: i + 1, ok: false, error: 'Not a JSON object.' },
      );
    } catch (e) {
      out.push({ line: i + 1, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
  return out;
}

function loadJournal(files) {
  const devices = new Map();
  const chains = new Map();
  const checkpoints = [];
  for (const [file, text] of files) {
    const ops = OPS_RE.exec(file);
    if (ops) {
      const chain = ops[1] ?? '';
      const c = chains.get(chain) ?? { chain, segments: [] };
      c.segments.push({ n: Number(ops[2]), file, lines: readSegment(text) });
      chains.set(chain, c);
      continue;
    }
    const dev = DEVICE_RE.exec(file);
    if (dev) {
      devices.set(dev[1] ?? '', { file, raw: parseObject(text) });
      continue;
    }
    if (CHECKPOINT_RE.test(file)) checkpoints.push({ file, raw: parseObject(text) });
  }
  for (const c of chains.values()) c.segments.sort((a, b) => a.n - b.n);
  checkpoints.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { devices, chains, checkpoints };
}

// ---- verify

const str = (v) => (typeof v === 'string' ? v : undefined);
const int = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
const short = (chain) => chain.slice(0, 10);

/**
 * Verify a journal given as files: project-relative path (forward slashes, `journal/...`) to
 * text. `opts.now` is this computer's time (for clocks far ahead); `opts.quarantined` an optional
 * set of op ids held in quarantine. Returns the same report as Verify in the app.
 */
export function verifyFiles(files, opts = {}) {
  const j = loadJournal(files);
  const now = opts.now ?? new Date();
  const problems = [];
  const add = (p) => problems.push(p);

  // ---- devices: self-signed public keys
  const keys = new Map();
  for (const [dev, d] of j.devices) {
    if (d.raw?.id !== dev || !checkDeviceRecord(d.raw)) {
      add({
        code: 'bad-signature',
        file: d.file,
        message: `The device record ${dev.slice(0, 10)} is not signed by its own key.`,
      });
      keys.set(dev, null);
      continue;
    }
    keys.set(dev, publicKeyObject(d.raw.key));
  }

  // ---- every op line, in chain order
  const counts = { ops: 0, signed: 0, unsigned: 0, external: 0, quarantined: 0, redacted: 0 };
  const chains = [];
  const byChain = new Map();
  const byId = new Map();
  const stripped = [];
  const redactedIds = new Set();
  const revoked = new Map();
  const unknownDevices = new Set();
  const aheadMs = now.getTime() + CLOCK_AHEAD_NOTICE_MS;

  for (const c of j.chains.values()) {
    const dev = c.chain.split('.')[0] ?? '';
    const seen = [];
    // a whole segment file missing while a later one exists
    const missingSegments = [];
    const last = c.segments[c.segments.length - 1]?.n ?? 0;
    const present = new Set(c.segments.map((s) => s.n));
    for (let n = 1; n < last; n++) if (!present.has(n)) missingSegments.push(n);
    for (const n of missingSegments) {
      add({
        code: 'segment-missing',
        file: `${JOURNAL_OPS_DIR}/${c.chain}/${segmentFileName(n)}`,
        chain: c.chain,
        message: `Segment ${String(n)} of chain ${short(c.chain)} is missing; later segments follow it.`,
      });
    }
    for (const s of c.segments) {
      for (const l of s.lines) {
        if (!l.ok) {
          add({
            code: 'parse',
            file: s.file,
            line: l.line,
            message: `Line ${String(l.line)} is not a valid entry (${l.error}).`,
          });
          continue;
        }
        const raw = l.raw;
        const id = str(raw.id);
        const seq = int(raw.seq);
        if (id === undefined || seq === undefined || seq < 1 || raw.chain !== c.chain) {
          add({
            code: 'parse',
            file: s.file,
            line: l.line,
            message: `Line ${String(l.line)} is not an entry of chain ${short(c.chain)}.`,
          });
          continue;
        }
        const op = { file: s.file, line: l.line, raw, seq, id };
        seen.push(op);
        counts.ops += 1;
        const at = { file: s.file, line: l.line, chain: c.chain, seq, op: id };

        if (!keys.has(dev) && !unknownDevices.has(dev)) {
          unknownDevices.add(dev);
          add({
            ...at,
            code: 'unknown-device',
            message: `Chain ${short(c.chain)} has no device record with its public key.`,
          });
        }
        const check = checkOp(raw, keys.get(dev) ?? null);
        if (!check.id) {
          add({
            ...at,
            code: 'hash-mismatch',
            message: `Line ${String(l.line)} was changed after it was written: it no longer matches its hash.`,
          });
        }
        if (check.payload === false) {
          add({
            ...at,
            code: 'payload-hash',
            message: `The content of line ${String(l.line)} was changed after it was written.`,
          });
        }
        if (check.payload === null) stripped.push(op);
        if (typeof raw.sig !== 'string') {
          counts.unsigned += 1;
          add({
            ...at,
            code: 'unsigned',
            message: `Line ${String(l.line)} is not signed (the key vault was not available).`,
          });
        } else if (keys.get(dev)) {
          if (check.signature === true) counts.signed += 1;
          else
            add({
              ...at,
              code: 'bad-signature',
              message: `The signature on line ${String(l.line)} is not from the device that wrote it.`,
            });
        }
        if (raw.kind === 'record.external' || raw.via?.external) {
          counts.external += 1;
        }
        if (opts.quarantined?.has(id)) counts.quarantined += 1;
        const payload = raw.payload;
        if (raw.kind === 'op.redact' && check.id && typeof payload?.op === 'string') {
          redactedIds.add(payload.op);
        }
        if (raw.kind === 'comment.redact' && check.id && Array.isArray(payload?.ops)) {
          for (const x of payload.ops) if (typeof x === 'string') redactedIds.add(x);
        }
        if (raw.kind === 'device.revoke' && check.id && typeof payload?.device === 'string') {
          const hlc = str(raw.hlc) ?? '';
          const prev = revoked.get(payload.device);
          if (prev === undefined || hlc < prev) revoked.set(payload.device, hlc);
        }
        const hlc = str(raw.hlc);
        if (hlc && Number(hlc.slice(0, 13)) > aheadMs) {
          add({
            ...at,
            code: 'clock-ahead',
            message: `Line ${String(l.line)} was written with a clock ahead of this computer.`,
          });
        }
      }
    }

    // ---- order, gaps and forks within the chain
    const seqs = new Set(seen.map((o) => o.seq));
    const kept = new Map();
    let expected = 1;
    let reordered = false;
    // a missing first segment explains the gap before the first op that is there
    const firstPresentGapExplained = missingSegments.includes(1);
    for (const o of seen) {
      const at = { file: o.file, line: o.line, chain: c.chain, seq: o.seq, op: o.id };
      if (kept.has(o.seq)) {
        add({
          ...at,
          code: 'fork',
          message: `Line ${String(o.line)} is a second entry ${String(o.seq)} of chain ${short(c.chain)}: a copy of the project kept writing.`,
        });
        continue;
      }
      kept.set(o.seq, o);
      if (o.seq === expected) {
        while (kept.has(expected)) expected += 1;
        continue;
      }
      if (o.seq < expected) continue; // already named as out of order
      if (!reordered && [...Array(o.seq - expected).keys()].some((k) => seqs.has(expected + k))) {
        reordered = true;
        add({
          ...at,
          code: 'order',
          message: `Line ${String(o.line)} is out of order in chain ${short(c.chain)}.`,
        });
        continue;
      }
      if (!(firstPresentGapExplained && expected === 1)) {
        add({
          ...at,
          code: 'chain-gap',
          message: `Entries ${String(expected)} to ${String(o.seq - 1)} of chain ${short(c.chain)} are missing before line ${String(o.line)}.`,
        });
      }
      expected = o.seq + 1;
    }
    // prev links between consecutive seqs
    const ordered = [...kept.values()].sort((a, b) => a.seq - b.seq);
    ordered.forEach((o, i) => {
      const before = ordered[i - 1];
      const prev = o.raw.prev;
      const ok =
        o.seq === 1 ? prev === null : before?.seq === o.seq - 1 ? prev === before.id : true; // a gap: already named
      if (!ok) {
        add({
          code: 'fork',
          file: o.file,
          line: o.line,
          chain: c.chain,
          seq: o.seq,
          op: o.id,
          message: `Line ${String(o.line)} does not follow the entry before it in chain ${short(c.chain)}.`,
        });
      }
    });
    for (const o of ordered) byId.set(o.id, o);
    byChain.set(c.chain, ordered);
    const head = ordered[ordered.length - 1];
    chains.push({
      chain: c.chain,
      device: dev,
      ops: seen.length,
      segments: c.segments.length,
      head: head ? { seq: head.seq, id: head.id } : null,
    });
  }

  // ---- payloads removed: only with a redaction op naming them
  for (const o of stripped) {
    if (redactedIds.has(o.id)) {
      counts.redacted += 1;
      continue;
    }
    add({
      code: 'payload-missing',
      file: o.file,
      line: o.line,
      chain: o.raw.chain,
      seq: o.seq,
      op: o.id,
      message: `The content of line ${String(o.line)} was removed without a redaction.`,
    });
  }

  // ---- revoked devices: ops after the revocation
  for (const [dev, hlc] of revoked) {
    for (const [chain, ops] of byChain) {
      if (!chain.startsWith(`${dev}.`)) continue;
      for (const o of ops) {
        if ((str(o.raw.hlc) ?? '') > hlc) {
          add({
            code: 'revoked-device',
            file: o.file,
            line: o.line,
            chain,
            seq: o.seq,
            op: o.id,
            message: `Line ${String(o.line)} was written after its device was revoked.`,
          });
        }
      }
    }
  }

  // ---- references from other chains (deps) and checkpoints: truncated tails
  const truncated = new Map();
  const missingRef = (chain, id, seq) => {
    if (byId.has(id)) return;
    const ops = byChain.get(chain);
    const lastSeq = ops?.[ops.length - 1]?.seq ?? 0;
    if (seq !== undefined && seq <= lastSeq) return; // present but different: a fork, named above
    const want = seq ?? lastSeq + 1;
    truncated.set(chain, Math.max(truncated.get(chain) ?? 0, want));
  };
  for (const ops of byChain.values()) {
    for (const o of ops) {
      const deps = o.raw.deps;
      if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
        for (const [chain, id] of Object.entries(deps)) {
          if (typeof id === 'string') missingRef(chain, id, undefined);
        }
      }
    }
  }
  for (const cp of j.checkpoints) {
    if (!cp.raw) {
      add({ code: 'parse', file: cp.file, message: 'This checkpoint is not valid JSON.' });
      continue;
    }
    const dev = str(cp.raw.dev) ?? '';
    const key = keys.get(dev);
    const check = checkCheckpoint(cp.raw, key ?? undefined);
    if (!check.id || !check.root || (key && check.signature !== true)) {
      add({
        code: 'checkpoint-mismatch',
        file: cp.file,
        message: 'This checkpoint was changed after it was signed.',
      });
      continue;
    }
    const wellFormed = Object.values(cp.raw.heads).every(
      (h) =>
        h !== null && typeof h === 'object' && typeof h.id === 'string' && Number.isInteger(h.seq),
    );
    if (!wellFormed) {
      add({
        code: 'checkpoint-mismatch',
        file: cp.file,
        message: 'This checkpoint lists a chain head that is not valid.',
      });
      continue;
    }
    for (const [chain, h] of Object.entries(cp.raw.heads)) {
      const ops = byChain.get(chain);
      const there = ops?.find((o) => o.seq === h.seq);
      if (there && there.id !== h.id) {
        add({
          code: 'checkpoint-mismatch',
          file: cp.file,
          chain,
          seq: h.seq,
          message: `Entry ${String(h.seq)} of chain ${short(chain)} is not the one this checkpoint signed.`,
        });
        continue;
      }
      if (!there) missingRef(chain, h.id, h.seq);
    }
  }
  for (const [chain, seq] of truncated) {
    // a missing segment in the middle already explains references into it
    const dropped = problems.some((p) => p.code === 'segment-missing' && p.chain === chain);
    const ops = byChain.get(chain) ?? [];
    const lastSeq = ops[ops.length - 1]?.seq ?? 0;
    if (dropped && seq <= lastSeq) continue;
    add({
      code: 'truncated',
      chain,
      seq,
      ...(ops.length
        ? {
            file: `${JOURNAL_OPS_DIR}/${chain}/${segmentFileName(j.chains.get(chain)?.segments.at(-1)?.n ?? 1)}`,
          }
        : {}),
      message: `Chain ${short(chain)} ends at entry ${String(lastSeq)}, but entry ${String(seq)} is referenced: its end was cut off.`,
    });
  }

  // ---- the audit head: the Merkle root over every chain's head
  const heads = {};
  for (const c of chains) if (c.head) heads[c.chain] = c.head;
  chains.sort((a, b) => (a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0));
  return {
    ok: problems.length === 0,
    checkedAt: now.toISOString(),
    head: chains.length ? { root: merkleRoot(heads), count: counts.ops } : null,
    chains,
    counts,
    problems,
  };
}

// ---- reading the input

/** Every file under `<root>/journal`, keyed by its project-relative path with forward slashes. */
export function readProjectFolder(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(join(root, 'journal'));
  return out;
}

/** The journal files of an audit JSON export (`aio.audit/1`). */
export function readAuditJson(text) {
  let doc;
  try {
    doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new Error(`The file is not valid JSON (${e instanceof Error ? e.message : String(e)}).`, {
      cause: e,
    });
  }
  if (doc === null || typeof doc !== 'object' || doc.schema !== AUDIT_SCHEMA) {
    throw new Error(`The file is not a Stratlas audit export (schema "${AUDIT_SCHEMA}").`);
  }
  const journal = doc.journal;
  if (journal === null || typeof journal !== 'object' || Array.isArray(journal)) {
    throw new Error('The audit export has no "journal" files.');
  }
  const out = new Map();
  for (const [path, body] of Object.entries(journal)) {
    if (typeof body !== 'string') throw new Error(`The journal file ${path} is not text.`);
    out.set(path, body);
  }
  return out;
}

/** Journal files from a project folder (or its `journal` folder) or an audit JSON export. */
export function readInput(path) {
  const st = statSync(path);
  if (st.isDirectory()) {
    if (statSync(join(path, 'journal'), { throwIfNoEntry: false })?.isDirectory()) {
      return readProjectFolder(path);
    }
    if (basename(path) === 'journal') return readProjectFolder(dirname(path));
    throw new Error(`There is no journal folder in ${path}.`);
  }
  return readAuditJson(readFileSync(path, 'utf8'));
}

/** The report as a few lines of text. */
export function summary(report) {
  const { counts } = report;
  const chains = `${String(report.chains.length)} chain${report.chains.length === 1 ? '' : 's'}`;
  const entries = `${String(counts.ops)} entr${counts.ops === 1 ? 'y' : 'ies'}`;
  const head = report.head ? ` Audit head ${report.head.root}.` : '';
  if (report.ok) {
    const signed = counts.signed === counts.ops ? 'all signed' : `${String(counts.signed)} signed`;
    const extra = [
      counts.redacted ? `${String(counts.redacted)} redacted` : '',
      counts.external ? `${String(counts.external)} external` : '',
    ].filter(Boolean);
    return `Intact: ${entries} in ${chains}, ${[signed, ...extra].join(', ')}.${head}`;
  }
  const lines = [
    `Not intact: ${String(report.problems.length)} problem${report.problems.length === 1 ? '' : 's'} in ${entries} in ${chains}.${head}`,
    ...report.problems.map((p) => {
      const where = p.file ? `${p.file}${p.line ? `:${String(p.line)}` : ''}` : (p.chain ?? '');
      return `  ${p.code}  ${where}  ${p.message}`;
    }),
  ];
  return lines.join('\n');
}

const USAGE = 'Usage: node verify.mjs <project folder | audit .json> [--json] [--now <iso time>]';

/** Run the command line; returns the exit code. */
export function main(argv) {
  let path;
  let json = false;
  let now;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--now') {
      const v = argv[++i];
      now = v === undefined ? new Date(NaN) : new Date(v);
      if (Number.isNaN(now.getTime())) {
        console.error(`--now needs a date and time, such as 2026-10-07T12:00:00Z.\n${USAGE}`);
        return 2;
      }
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    } else if (a?.startsWith('--') || path !== undefined) {
      console.error(`Unknown argument ${String(a)}.\n${USAGE}`);
      return 2;
    } else path = a;
  }
  if (path === undefined) {
    console.error(USAGE);
    return 2;
  }
  let files;
  try {
    files = readInput(path);
  } catch (e) {
    console.error(`Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  let report;
  try {
    report = verifyFiles(files, { now });
  } catch (e) {
    console.error(`Cannot verify ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  console.log(json ? JSON.stringify(report, null, 2) : summary(report));
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
