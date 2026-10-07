#!/usr/bin/env node
/* eslint-disable no-console -- command-line output */
// Review board: the founder's interactive view of docs/TESTING.md and docs/release/CHECKLIST-1.0.md.
// Every checkbox line and table row can be marked and commented on (with pasted screenshots); Submit
// writes a summary the integration lead reads. The documents are read on every request, so the board
// always shows the committed text. Answers stay on this machine in .review-board/ (git-ignored).
//
//   node tools/review-board/server.mjs        then open http://127.0.0.1:4178
//
// Binds to 127.0.0.1 only and makes no outgoing requests.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDoc } from './parse.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const here = fileURLToPath(new URL('.', import.meta.url));
const store = join(repo, '.review-board');
const attachDir = join(store, 'attachments');
const submitDir = join(store, 'submissions');
const stateFile = join(store, 'state.json');
const PORT = Number(process.env.REVIEW_BOARD_PORT ?? 4178);

export const DOCS = [
  { id: 'testing', title: 'Testing', file: 'docs/TESTING.md', kind: 'testing' },
  {
    id: 'checklist',
    title: '1.0 checklist',
    file: 'docs/release/CHECKLIST-1.0.md',
    kind: 'checklist',
  },
  { id: 'setup', title: 'Setup guide', file: 'docs/release/FOUNDER-SETUP-GUIDE.md', kind: 'setup' },
];

async function loadDocs() {
  const out = [];
  for (const d of DOCS) {
    const text = await readFile(join(repo, d.file), 'utf8').catch(() => null);
    if (text === null) continue; // a document not written yet has no tab
    out.push({ ...parseDoc(text, d.id, d.kind), ...d });
  }
  return out;
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    return { items: {}, submissions: [] };
  }
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

async function body(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const STATUS_WORDS = {
  testing: { pass: 'Works', fail: 'Does not work', skip: 'Skipped' },
  checklist: { ok: 'Agreed', question: 'Question or change', decided: 'Decided' },
  setup: { done: 'Done', stuck: 'Stuck or question', later: 'Not now' },
};

/** The summary the integration lead reads: what failed or needs an answer first, then the rest. */
export function summary(docs, state, at) {
  const lines = [`# Review board submission`, '', `Submitted ${at}.`, ''];
  for (const doc of docs) {
    const words = STATUS_WORDS[doc.kind];
    const all = doc.sections.flatMap((s) =>
      s.groups.flatMap((g) => g.items.map((i) => ({ s, g, i }))),
    );
    const counts = {};
    for (const { i } of all.filter(({ i }) => i.counted)) {
      const st = state.items[i.id]?.status ?? 'none';
      counts[st] = (counts[st] ?? 0) + 1;
    }
    const countText = Object.entries(words)
      .map(([k, w]) => `${w} ${counts[k] ?? 0}`)
      .concat(`not marked ${counts.none ?? 0}`)
      .join(', ');
    lines.push(`## ${doc.title} (${doc.file})`, '', countText + '.', '');
    for (const section of doc.sections) {
      const note = state.items[section.noteId]?.comment?.trim();
      const marked = section.groups.flatMap((g) =>
        g.items
          .map((i) => ({ g, i, r: state.items[i.id] }))
          .filter(({ r }) => r && (r.status || r.comment?.trim() || r.attachments?.length)),
      );
      if (!note && marked.length === 0) continue;
      lines.push(`### ${section.title}`, '');
      if (note) lines.push(`Section note: ${note}`, '');
      const order = Object.keys(words);
      marked.sort(
        (a, b) =>
          rank(a.r.status, doc.kind) - rank(b.r.status, doc.kind) ||
          order.indexOf(a.r.status) - order.indexOf(b.r.status),
      );
      for (const { g, i, r } of marked) {
        const where = g.title ? `${g.title}: ` : '';
        const status = r.status ? words[r.status] : 'Comment only';
        lines.push(`- **${status}** · ${where}${i.plain}`);
        if (r.comment?.trim())
          lines.push(`  - Comment: ${r.comment.trim().replace(/\n+/g, ' / ')}`);
        for (const a of r.attachments ?? [])
          lines.push(`  - Screenshot: .review-board/attachments/${a}`);
        lines.push(`  - id: \`${i.id}\``);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function rank(status, kind) {
  if (kind === 'testing') return { fail: 0, skip: 1, pass: 2 }[status] ?? 1.5;
  if (kind === 'setup') return { stuck: 0, later: 1, done: 2 }[status] ?? 1.5;
  return { question: 0, decided: 1, ok: 2 }[status] ?? 1.5;
}

function send(res, code, type, data) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}
const json = (res, code, value) =>
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(value));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', await readFile(join(here, 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/docs')
      return json(res, 200, await loadDocs());
    if (req.method === 'GET' && url.pathname === '/api/state')
      return json(res, 200, await readState());
    if (req.method === 'PUT' && url.pathname.startsWith('/api/item/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/item/'.length));
      const patch = JSON.parse((await body(req, 1024 * 1024)).toString('utf8'));
      await mkdir(store, { recursive: true });
      const state = await readState();
      const prev = state.items[id] ?? {};
      const next = { ...prev, ...pick(patch), updatedAt: new Date().toISOString() };
      const empty = !next.status && !next.comment && !(next.attachments ?? []).length;
      state.items = Object.fromEntries(
        Object.entries({ ...state.items, [id]: next }).filter(([k]) => k !== id || !empty),
      );
      await writeAtomic(stateFile, JSON.stringify(state, null, 2));
      return json(res, 200, state.items[id] ?? {});
    }
    if (req.method === 'POST' && url.pathname === '/api/attach') {
      const id = url.searchParams.get('item') ?? 'item';
      const type = req.headers['content-type'] ?? '';
      const ext = type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png';
      const data = await body(req);
      const name = `${id.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}-${createHash('sha256').update(data).digest('hex').slice(0, 10)}.${ext}`;
      await mkdir(attachDir, { recursive: true });
      await writeFile(join(attachDir, name), data);
      return json(res, 200, { name });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/attachments/')) {
      const name = url.pathname.slice('/attachments/'.length);
      if (!/^[\w.-]+$/.test(name)) return send(res, 400, 'text/plain', 'Bad name');
      const ext = name.split('.').pop();
      const type = ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
      return send(res, 200, type, await readFile(join(attachDir, name)));
    }
    if (req.method === 'POST' && url.pathname === '/api/submit') {
      const docs = await loadDocs();
      const state = await readState();
      const at = new Date();
      const stamp = at.toISOString().replace(/[:.]/g, '-');
      await mkdir(submitDir, { recursive: true });
      const md = summary(
        docs,
        state,
        at.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }),
      );
      await writeFile(join(submitDir, `${stamp}.md`), md);
      await writeFile(
        join(submitDir, `${stamp}.json`),
        JSON.stringify({ at: at.toISOString(), state }, null, 2),
      );
      await writeAtomic(join(store, 'latest-submission.md'), md);
      state.submissions = [...(state.submissions ?? []), at.toISOString()];
      await writeAtomic(stateFile, JSON.stringify(state, null, 2));
      return json(res, 200, {
        at: at.toISOString(),
        file: `.review-board/submissions/${stamp}.md`,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/submissions') {
      const files = await readdir(submitDir).catch(() => []);
      return json(
        res,
        200,
        files
          .filter((f) => f.endsWith('.md'))
          .sort()
          .reverse(),
      );
    }
    send(res, 404, 'text/plain', 'Not found');
  } catch (e) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

function pick(p) {
  const out = {};
  if ('status' in p) out.status = typeof p.status === 'string' && p.status ? p.status : undefined;
  if ('comment' in p) out.comment = typeof p.comment === 'string' ? p.comment : '';
  if ('attachments' in p && Array.isArray(p.attachments))
    out.attachments = p.attachments.filter((a) => typeof a === 'string' && /^[\w.-]+$/.test(a));
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Review board on http://127.0.0.1:${PORT} (answers in .review-board/)`);
  });
}
