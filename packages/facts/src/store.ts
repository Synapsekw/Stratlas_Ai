/**
 * The fact index on disk: one SQLite file per project (`node:sqlite`, built into Node 24 and
 * Electron 44, so nothing native ships), with an FTS5 table over labels and text.
 *
 * Writes only come from `sync`, which applies the difference between what the index holds and a
 * fresh extract (`extractFacts`), so the index always equals a rebuild from the same sources.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  FACT_INDEX_VERSION,
  type Fact,
  type FactHistory,
  type FactIndexStatus,
  type FactLink,
  type FactQuery,
  type FactRelation,
} from '@aio/schema';
import type { Extracted } from './extract';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  label TEXT NOT NULL,
  text TEXT,
  capture TEXT,
  date TEXT,
  at TEXT,
  value REAL,
  unit TEXT,
  status TEXT,
  source TEXT,
  evidence TEXT NOT NULL,
  op TEXT,
  e REAL,
  n REAL,
  day TEXT,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS facts_subject ON facts(subject);
CREATE INDEX IF NOT EXISTS facts_kind ON facts(kind, day);
CREATE INDEX IF NOT EXISTS facts_capture ON facts(capture);
CREATE TABLE IF NOT EXISTS links (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  rel TEXT NOT NULL,
  PRIMARY KEY (src, dst, rel)
);
CREATE INDEX IF NOT EXISTS links_dst ON links(dst);
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  label, text, content='facts', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, label, text) VALUES (new.rowid, new.label, new.text);
END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, label, text) VALUES ('delete', old.rowid, old.label, old.text);
END;
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, label, text) VALUES ('delete', old.rowid, old.label, old.text);
  INSERT INTO facts_fts(rowid, label, text) VALUES (new.rowid, new.label, new.text);
END;
`;

const COLUMNS = [
  'id',
  'kind',
  'subject',
  'label',
  'text',
  'capture',
  'date',
  'at',
  'value',
  'unit',
  'status',
  'source',
  'evidence',
  'op',
  'e',
  'n',
] as const;

/** What a `sync` changed. */
export interface SyncResult {
  added: number;
  changed: number;
  removed: number;
  linksAdded: number;
  linksRemoved: number;
}

/** The read and write API of one project's index. */
export interface FactIndex {
  /** Make the index equal `next` (a fresh `extractFacts`), changing only the rows that differ. */
  sync(next: Extracted, builtAt?: string): SyncResult;
  /** Facts matching `q`: best text match first, else newest first. */
  query(q: FactQuery): { facts: Fact[]; total: number };
  /** One subject's own facts, linked facts and journal events, oldest first. */
  historyOf(subject: string, limit?: number): FactHistory;
  /** Links from or to a subject (both directions; `from` is always the stored direction). */
  linksOf(subject: string): FactLink[];
  status(): FactIndexStatus;
  /** Every fact and link, sorted: two indexes of the same sources dump the same. */
  dump(): Extracted;
  close(): void;
}

type Row = Record<string, SQLInputValue>;

const str = (v: SQLInputValue | undefined): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? v.toString() : '';

const hashOf = (f: Fact) => JSON.stringify(COLUMNS.map((c) => f[c] ?? null));

/** The day a fact sorts and filters by: its survey date, else the day it happened. */
const dayOf = (f: Fact): string | null => f.date ?? (f.at ? f.at.slice(0, 10) : null);

function toFact(r: Row): Fact {
  const out: Record<string, unknown> = {};
  for (const c of COLUMNS) {
    const v = r[c];
    if (v !== null && v !== undefined) out[c] = v;
  }
  return out as Fact;
}

/** FTS5 query from free words: every word must match, each as a prefix. */
export function ftsQuery(text: string): string | null {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!tokens.length) return null;
  return tokens
    .slice(0, 12)
    .map((t) => `"${t}"*`)
    .join(' ');
}

const DROP_SQL = `
DROP TRIGGER IF EXISTS facts_ai; DROP TRIGGER IF EXISTS facts_ad; DROP TRIGGER IF EXISTS facts_au;
DROP TABLE IF EXISTS facts_fts; DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS facts;
DROP TABLE IF EXISTS meta;
`;

/** Create the tables; an index of another `FACT_INDEX_VERSION` is dropped and made again. */
function prepare(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  const hasMeta = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
    .get();
  if (hasMeta) {
    const v = db.prepare(`SELECT value FROM meta WHERE key = 'version'`).get() as
      { value: string } | undefined;
    if (v?.value !== String(FACT_INDEX_VERSION)) db.exec(DROP_SQL);
  }
  db.exec(SCHEMA_SQL);
  db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('version', ?)`).run(
    String(FACT_INDEX_VERSION),
  );
}

/** Open (or create) the index file; `:memory:` for tests. An index of another version is made again. */
export function openFactIndex(file: string): FactIndex {
  const db = new DatabaseSync(file);
  try {
    prepare(db);
  } catch (e) {
    // not a database, or a damaged one: the caller may delete the file and open again
    db.close();
    throw e;
  }

  const insert = db.prepare(
    `INSERT INTO facts(${COLUMNS.join(', ')}, day, hash) VALUES (${COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE facts SET ${COLUMNS.filter((c) => c !== 'id')
      .map((c) => `${c} = ?`)
      .join(', ')}, day = ?, hash = ? WHERE id = ?`,
  );
  const remove = db.prepare(`DELETE FROM facts WHERE id = ?`);
  const linkIns = db.prepare(`INSERT OR IGNORE INTO links(src, dst, rel) VALUES (?, ?, ?)`);
  const linkDel = db.prepare(`DELETE FROM links WHERE src = ? AND dst = ? AND rel = ?`);
  const values = (f: Fact): SQLInputValue[] => COLUMNS.map((c) => f[c] ?? null);

  function sync(next: Extracted, builtAt = new Date().toISOString()): SyncResult {
    const res: SyncResult = { added: 0, changed: 0, removed: 0, linksAdded: 0, linksRemoved: 0 };
    db.exec('BEGIN');
    try {
      const have = new Map<string, string>();
      for (const r of db.prepare(`SELECT id, hash FROM facts`).all() as Row[]) {
        have.set(str(r.id), str(r.hash));
      }
      for (const f of next.facts) {
        const h = hashOf(f);
        const old = have.get(f.id);
        if (old === undefined) {
          insert.run(...values(f), dayOf(f), h);
          res.added++;
        } else if (old !== h) {
          update.run(...values(f).slice(1), dayOf(f), h, f.id);
          res.changed++;
        }
        have.delete(f.id);
      }
      for (const id of have.keys()) {
        remove.run(id);
        res.removed++;
      }
      const key = (l: FactLink) => `${l.from}\u0000${l.to}\u0000${l.rel}`;
      const links = new Map<string, FactLink>();
      for (const r of db.prepare(`SELECT src, dst, rel FROM links`).all() as Row[]) {
        const l = { from: str(r.src), to: str(r.dst), rel: str(r.rel) as FactRelation };
        links.set(key(l), l);
      }
      for (const l of next.links) {
        if (!links.delete(key(l))) {
          linkIns.run(l.from, l.to, l.rel);
          res.linksAdded++;
        }
      }
      for (const l of links.values()) {
        linkDel.run(l.from, l.to, l.rel);
        res.linksRemoved++;
      }
      db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('builtAt', ?)`).run(builtAt);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return res;
  }

  function where(q: FactQuery, alias: string): { sql: string; args: SQLInputValue[] } {
    const parts: string[] = [];
    const args: SQLInputValue[] = [];
    if (q.kinds?.length) {
      parts.push(`${alias}.kind IN (${q.kinds.map(() => '?').join(', ')})`);
      args.push(...q.kinds);
    }
    if (q.subject) {
      parts.push(`${alias}.subject = ?`);
      args.push(q.subject);
    }
    if (q.capture) {
      parts.push(`${alias}.capture = ?`);
      args.push(q.capture);
    }
    if (q.status) {
      parts.push(`${alias}.status = ?`);
      args.push(q.status);
    }
    if (q.from) {
      parts.push(`${alias}.day >= ?`);
      args.push(q.from);
    }
    if (q.to) {
      parts.push(`${alias}.day <= ?`);
      args.push(q.to);
    }
    if (q.near) {
      const { e, n, radiusM: r } = q.near;
      parts.push(
        `${alias}.e BETWEEN ? AND ? AND ${alias}.n BETWEEN ? AND ? AND ((${alias}.e - ?) * (${alias}.e - ?) + (${alias}.n - ?) * (${alias}.n - ?)) <= ?`,
      );
      args.push(e - r, e + r, n - r, n + r, e, e, n, n, r * r);
    }
    return { sql: parts.length ? parts.join(' AND ') : '1 = 1', args };
  }

  function query(q: FactQuery): { facts: Fact[]; total: number } {
    const limit = Math.min(500, Math.max(1, q.limit ?? 50));
    const w = where(q, 'f');
    const match = q.text ? ftsQuery(q.text) : null;
    if (match) {
      const from = `facts_fts JOIN facts f ON f.rowid = facts_fts.rowid WHERE facts_fts MATCH ? AND ${w.sql}`;
      const total = db.prepare(`SELECT COUNT(*) AS c FROM ${from}`).get(match, ...w.args) as Row;
      const rows = db
        .prepare(`SELECT f.* FROM ${from} ORDER BY bm25(facts_fts, 4.0, 1.0), f.id LIMIT ?`)
        .all(match, ...w.args, limit) as Row[];
      return { facts: rows.map(toFact), total: Number(total.c) };
    }
    const total = db
      .prepare(`SELECT COUNT(*) AS c FROM facts f WHERE ${w.sql}`)
      .get(...w.args) as Row;
    const rows = db
      .prepare(
        `SELECT f.* FROM facts f WHERE ${w.sql} ORDER BY f.day IS NULL, f.day DESC, f.at DESC, f.id LIMIT ?`,
      )
      .all(...w.args, limit) as Row[];
    return { facts: rows.map(toFact), total: Number(total.c) };
  }

  function linksOf(subject: string): FactLink[] {
    const rows = db
      .prepare(
        `SELECT src, dst, rel FROM links WHERE src = ? UNION SELECT src, dst, rel FROM links WHERE dst = ? ORDER BY 1, 2, 3`,
      )
      .all(subject, subject) as Row[];
    return rows.map((r) => ({
      from: str(r.src),
      to: str(r.dst),
      rel: str(r.rel) as FactRelation,
    }));
  }

  const ORDER = `ORDER BY day IS NULL, day, at, id`;

  function historyOf(subject: string, limit = 200): FactHistory {
    const cap = Math.min(500, Math.max(1, limit));
    const own = db
      .prepare(`SELECT * FROM facts WHERE subject = ? AND kind != 'event' ${ORDER} LIMIT ?`)
      .all(subject, cap) as Row[];
    const events = db
      .prepare(`SELECT * FROM facts WHERE subject = ? AND kind = 'event' ${ORDER} LIMIT ?`)
      .all(subject, cap) as Row[];
    const linked: FactHistory['linked'] = [];
    const rels = new Map<string, FactRelation>();
    for (const l of linksOf(subject)) {
      const other = l.from === subject ? l.to : l.from;
      if (!rels.has(other)) rels.set(other, l.rel);
    }
    const others = [...rels.keys()];
    for (let i = 0; i < others.length && linked.length < cap; i += 200) {
      const chunk = others.slice(i, i + 200);
      const rows = db
        .prepare(
          `SELECT * FROM facts WHERE subject IN (${chunk.map(() => '?').join(', ')}) AND kind != 'event' ${ORDER} LIMIT ?`,
        )
        .all(...chunk, cap - linked.length) as Row[];
      for (const r of rows) {
        const f = toFact(r);
        linked.push({ rel: rels.get(f.subject) ?? 'about', fact: f });
      }
    }
    const day = (f: Fact) => dayOf(f) ?? '￿';
    linked.sort((a, b) =>
      day(a.fact) !== day(b.fact)
        ? day(a.fact) < day(b.fact)
          ? -1
          : 1
        : a.fact.id < b.fact.id
          ? -1
          : 1,
    );
    return { subject, facts: own.map(toFact), linked, events: events.map(toFact) };
  }

  function status(): FactIndexStatus {
    const counts: Record<string, number> = {};
    for (const r of db
      .prepare(`SELECT kind, COUNT(*) AS c FROM facts GROUP BY kind`)
      .all() as Row[]) {
      counts[str(r.kind)] = Number(r.c);
    }
    const links = db.prepare(`SELECT COUNT(*) AS c FROM links`).get() as Row;
    const built = db.prepare(`SELECT value FROM meta WHERE key = 'builtAt'`).get() as
      { value: string } | undefined;
    return {
      state: built ? 'ready' : 'none',
      ...(built ? { builtAt: built.value } : {}),
      counts,
      links: Number(links.c),
    };
  }

  function dump(): Extracted {
    const facts = (db.prepare(`SELECT * FROM facts ORDER BY id`).all() as Row[]).map(toFact);
    const links = (
      db.prepare(`SELECT src, dst, rel FROM links ORDER BY src, dst, rel`).all() as Row[]
    ).map((r) => ({ from: str(r.src), to: str(r.dst), rel: str(r.rel) as FactRelation }));
    return { facts, links };
  }

  return {
    sync,
    query,
    historyOf,
    linksOf,
    status,
    dump,
    close: () => {
      db.close();
    },
  };
}
