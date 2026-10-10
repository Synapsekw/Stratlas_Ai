#!/usr/bin/env node
/* eslint-disable no-console -- build script output */
// The team test board: docs/TESTING.md as one self-contained page for an online guided test run.
// Testers answer one line at a time (works, does not work, skip, comment); an overview shows every
// tester side by side. Claude publishes the built page as a private claude.ai Artifact; answers
// live in the Artifact's own store, so a rebuild after TESTING.md changes keeps them.
//
//   node tools/test-board/build.mjs                        the tool's own defaults
//   node tools/test-board/build.mjs --private <folder>     with a private folder
//
// Both write tools/test-board/dist (git-ignored). The private folder holds what must stay out of
// the repository: who tests, the verticals with their client projects, the setup steps and
// drafted lines. Its config.json overrides tools/test-board/config.json key by key, and its
// `setup` and `extra` documents are read from that folder. Without --private the build uses
// QUADRION_TEST_BOARD_PRIVATE, then tools/test-board/local (git-ignored) when it exists.
//
// Design: docs/plans/2026-10-10-team-test-board-design.md
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDoc } from '../review-board/parse.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Markdown inline (bold, code, links, italics) to HTML. Links to other docs become plain text. */
export function inline(md) {
  const code = [];
  let s = md.replace(/`([^`]*)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, text, url) =>
      /^https?:\/\//.test(url)
        ? `<a href="${url}" target="_blank" rel="noreferrer">${text}</a>`
        : text,
    )
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<i>$2</i>');
  // eslint-disable-next-line no-control-regex -- the placeholder that protects code spans
  return s.replace(/\u0000(\d+)\u0000/g, (_, k) => `<code>${esc(code[Number(k)])}</code>`);
}

const list = (tag, items) =>
  `<${tag}>${items
    .map(
      (i) =>
        `<li>${inline(i.md)}${i.sub.length ? `<ul>${i.sub.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>` : ''}</li>`,
    )
    .join('')}</${tag}>`;

/** A group's text blocks (everything but its test lines) as HTML. */
const notes = (group) =>
  group.blocks
    .map((b) => {
      if (b.type === 'p') return `<p>${inline(b.md)}</p>`;
      if (b.type === 'ul' || b.type === 'ol') return list(b.type, b.items);
      if (b.type === 'pre') return `<pre>${esc(b.text)}</pre>`;
      return '';
    })
    .join('');

const matches = (title, prefixes) => prefixes.some((p) => title === p || title.startsWith(p));

/** "Stage M6.1: your M6 feedback, fixed" to { short: "M6.1", name: "Your M6 feedback, fixed" }. */
function stageName(title) {
  const m = /^Stage (.+?):\s*(.+)$/.exec(title);
  if (!m) return { short: title.replace(/^Stage /, ''), name: title };
  return { short: m[1], name: m[2][0].toUpperCase() + m[2].slice(1) };
}

/** A document's sections that have test lines. A group without any keeps its text in the intro. */
function stagesOf(doc, config) {
  return doc.sections
    .filter((s) => s.groups.some((g) => g.items.some((i) => i.kind === 'check')))
    .filter((s) => !matches(s.title, config.exclude ?? []))
    .map((s) => {
      let intro = '';
      const groups = [];
      for (const g of s.groups) {
        const items = g.items
          .filter((i) => i.kind === 'check')
          .map((i) => ({ id: i.id, html: inline(i.md), sub: i.sub.map(inline), plain: i.plain }));
        if (items.length) groups.push({ title: g.title, notes: notes(g), items });
        else intro += (g.title ? `<h4>${inline(g.title)}</h4>` : '') + notes(g);
      }
      return { id: s.id, title: s.title, ...stageName(s.title), intro, groups };
    });
}

/**
 * Regroup the lines by vertical (a customer use case and its projects) instead of by milestone.
 * The first rule that fits a line decides: a rule names a stage and a group by the start of their
 * titles, and a line by a pattern on its text; what it leaves out fits everything. Lines keep
 * their ids, so answers given before a regrouping stay with their lines.
 */
function byVertical(stages, config) {
  const rules = config.rules.map((r) => ({ ...r, text: r.text ? new RegExp(r.text) : null }));
  const pick = (stage, group, item) =>
    rules.find(
      (r) =>
        (!r.stage || stage.title.startsWith(r.stage)) &&
        (!r.group || group.title.startsWith(r.group)) &&
        (!r.text || r.text.test(item.plain)),
    )?.to ?? config.fallback;
  const out = new Map(
    config.verticals.map((v) => [
      v.id,
      {
        id: `vertical:${v.id}`,
        title: v.name,
        short: v.short,
        name: v.name,
        intro: v.about ? `<p>${inline(v.about)}</p>` : '',
        groups: [],
      },
    ]),
  );
  for (const stage of stages) {
    const milestone = stage.title.startsWith('Stage ');
    const about = stage.intro
      ? `<details><summary>About ${esc(stage.short)}: ${esc(stage.name)}</summary>${stage.intro}</details>`
      : '';
    for (const group of stage.groups) {
      const parts = new Map();
      for (const item of group.items) {
        const to = pick(stage, group, item);
        if (!out.has(to))
          throw new Error(`No vertical "${to}" for "${stage.title}" / "${group.title}".`);
        parts.set(to, [...(parts.get(to) ?? []), item]);
      }
      for (const [to, items] of parts) {
        const title = [
          milestone ? stage.short : '',
          group.title || (milestone ? stage.name : ''),
        ].filter(Boolean);
        out.get(to).groups.push({
          title: title.join(' · '),
          notes: (milestone ? about : '') + group.notes,
          items,
        });
      }
    }
  }
  return [...out.values()].filter((v) => v.groups.length);
}

/**
 * The page's data: the guide (how to install and report), then every stage that has test lines,
 * in the configured order; with `verticals` configured, the same lines grouped by vertical. The
 * setup document (what a tester does once before the first line) comes first; an extra document
 * (lines the testing document does not have yet) comes last.
 */
export function buildModel(text, config, setupText = '', extraText = '') {
  const doc = parseDoc(text, 'testing', 'testing');
  const guide = doc.sections.find((s) => s.title === config.guide);
  let stages = [
    ...(setupText ? stagesOf(parseDoc(setupText, 'setup', 'testing'), config) : []),
    ...stagesOf(doc, config),
    ...(extraText ? stagesOf(parseDoc(extraText, 'extra', 'testing'), config) : []),
  ];

  const order = config.order ?? [];
  const rank = (s) => {
    const k = order.findIndex((p) => matches(s.title, [p]));
    return k === -1 ? order.length : k;
  };
  // sort is stable: stages the order does not name keep the document's order, after the named ones
  stages.sort((a, b) => rank(a) - rank(b));
  if (config.verticals) stages = byVertical(stages, config);
  for (const s of stages) for (const g of s.groups) for (const i of g.items) delete i.plain;

  return {
    title: config.title,
    source: config.source,
    testers: config.testers,
    owner: config.owner ?? 'the test lead',
    unit: config.unit ?? 'stage',
    guide: guide ? guide.groups.map((g) => ({ title: g.title, html: notes(g) })) : [],
    stages,
  };
}

/** JSON that is safe inside a <script> element. */
export const scriptJson = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

export function buildPage(text, config, template, setupText = '', extraText = '') {
  const model = buildModel(text, config, setupText, extraText);
  return {
    model,
    html: template
      .replace('__TITLE__', () => esc(config.title))
      .replace('__DATA__', () => scriptJson(model)),
  };
}

/** The private folder to build with, if any: --private, the environment, then the local folder. */
function privateFolder(argv) {
  const k = argv.indexOf('--private');
  if (k !== -1) {
    if (!argv[k + 1]) throw new Error('--private needs a folder.');
    return resolve(argv[k + 1]);
  }
  if (process.env.QUADRION_TEST_BOARD_PRIVATE)
    return resolve(process.env.QUADRION_TEST_BOARD_PRIVATE);
  const local = join(here, 'local');
  return existsSync(join(local, 'config.json')) ? local : null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const folder = privateFolder(process.argv.slice(2));
  const own = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
  const theirs = folder ? JSON.parse(readFileSync(join(folder, 'config.json'), 'utf8')) : {};
  const config = { ...own, ...theirs };
  // a document named by the private config lies in the private folder
  const read = (key) =>
    config[key] ? readFileSync(join(key in theirs ? folder : root, config[key]), 'utf8') : '';
  const text = readFileSync(join(root, config.source), 'utf8');
  const template = readFileSync(join(here, 'page.html'), 'utf8');
  const { model, html } = buildPage(text, config, template, read('setup'), read('extra'));
  const out = join(here, 'dist', 'test-board.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  // the Artifact adds its own document skeleton. This copy is a whole document: the file a tester
  // opens on their own PC, answers in, and returns as a results file.
  writeFileSync(
    join(here, 'dist', 'Quadrion-Test-Run.html'),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>${html}</body></html>`,
  );
  const lines = model.stages.reduce(
    (n, st) => n + st.groups.reduce((m, g) => m + g.items.length, 0),
    0,
  );
  for (const st of model.stages) {
    const n = st.groups.reduce((m, g) => m + g.items.length, 0);
    console.log(`  ${st.short.padEnd(8)} ${String(n).padStart(4)}  ${st.name}`);
  }
  console.log(folder ? `Private folder: ${folder}` : 'No private folder: the defaults.');
  console.log(
    `${model.stages.length} ${model.unit}s, ${lines} lines, ${(html.length / 1024).toFixed(0)} KB: ${out}`,
  );
}
