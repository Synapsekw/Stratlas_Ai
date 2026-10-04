/** Plain-text exports: the issue CSV of export_issues and a conversation as Markdown (AI-8). */
import type { Conversation, Issue } from '@aio/schema';
import { issuePoint } from './tool-kit';

const CSV_HEAD = [
  'code',
  'title',
  'class',
  'severity',
  'status',
  'source',
  'author',
  'created',
  'updated',
  'x',
  'y',
  'z',
  'note',
];

function cell(v: string | number | undefined): string {
  if (v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV, one row per issue, with the issue's 3D point when it has one. */
export function issuesCsv(
  issues: readonly Issue[],
  classLabels: ReadonlyMap<string, string>,
): string {
  const rows = issues.map((i) => {
    const p = issuePoint(i);
    const xyz = p ? p.map((n) => n.toFixed(3)) : ['', '', ''];
    return [
      i.code,
      i.title,
      classLabels.get(i.classId) ?? i.classId,
      i.severity,
      i.status,
      i.source,
      i.author,
      i.createdAt,
      i.updatedAt,
      ...xyz,
      i.note,
    ]
      .map(cell)
      .join(',');
  });
  return [CSV_HEAD.join(','), ...rows].join('\r\n') + '\r\n';
}

const STEP_STATUS: Record<string, string> = {
  running: 'running',
  awaiting: 'waiting for approval',
  done: 'done',
  rejected: 'rejected',
  error: 'failed',
  undone: 'undone',
  cancelled: 'not run',
};

/** A conversation as Markdown: messages, tool steps with their outcome, and the token meter. */
export function conversationMarkdown(c: Conversation, projectName: string): string {
  const out: string[] = [
    `# ${c.title || 'Agent conversation'}`,
    '',
    `Project: ${projectName}  `,
    `Window: ${c.window}  `,
    `Started: ${c.createdAt}  `,
    `Last change: ${c.updatedAt}  `,
    `Tokens: ${String(c.usage.inputTokens)} in, ${String(c.usage.outputTokens)} out` +
      (c.usage.costUsd > 0 ? `, about $${c.usage.costUsd.toFixed(2)}` : ''),
    '',
  ];
  for (const t of c.turns) {
    if (t.kind === 'user') {
      out.push('## You', '', t.text);
      const tags = [...(t.frame ? ['frame attached'] : []), ...t.chips];
      if (tags.length) out.push('', `_Context: ${tags.join(', ')}_`);
      out.push('');
      continue;
    }
    out.push('## Agent', '');
    for (const p of t.parts) {
      if (p.type === 'text') {
        out.push(p.text);
        continue;
      }
      const s = c.steps[p.callId];
      if (!s) continue;
      const summary = s.summary ? `: ${s.summary}` : '';
      out.push(`- \`${s.name}\` (${STEP_STATUS[s.status] ?? s.status})${summary}`);
    }
    if (t.status === 'error' && t.error) out.push('', `_Error: ${t.error}_`);
    if (t.status === 'stopped') out.push('', '_Stopped._');
    out.push('');
  }
  return out.join('\n');
}
