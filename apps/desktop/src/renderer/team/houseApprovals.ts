// The house report's sign-off section (M9 T3, section `approvals`): prepared, reviewed and
// approved with names, initials and dates; the client's acceptance listed apart. Main passes the
// block in the page query (`signoff`); a project that is not shared has none and prints as in 0.8.
import type { SignOffBlock, SignOffPerson } from '@aio/collab';
import { t } from '@aio/ui';
import type { Pager } from '../reportPage/house/pager';
import { el, heading, txt } from '../reportPage/house/sections';

type Key = Parameters<typeof t>[0];
const tk = (key: string, vars?: Record<string, string | number>) => t(key as Key, vars);

const isPerson = (p: unknown): p is SignOffPerson =>
  typeof p === 'object' &&
  p !== null &&
  typeof (p as SignOffPerson).name === 'string' &&
  typeof (p as SignOffPerson).initials === 'string' &&
  typeof (p as SignOffPerson).date === 'string';

/** The block from the page query; null when absent or not one (never throws). */
export function parseSignOff(raw: string | null): SignOffBlock | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as unknown;
    if (typeof b !== 'object' || b === null) return null;
    const o = b as Record<string, unknown>;
    if (o.shared !== true) return null;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter(isPerson) : []);
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const f = (typeof o.findings === 'object' && o.findings ? o.findings : {}) as Record<
      string,
      unknown
    >;
    return {
      shared: true,
      prepared: isPerson(o.prepared) ? o.prepared : null,
      reviewed: list(o.reviewed),
      approved: list(o.approved),
      accepted: list(o.accepted),
      outOfDate: list(o.outOfDate),
      findings: { approved: num(f.approved, 0), total: num(f.total, 0) },
      required: num(o.required, 1),
    };
  } catch {
    return null;
  }
}

const people = (list: readonly SignOffPerson[]): string =>
  list.length
    ? list.map((p) => `<b>${txt(p.name)}</b> (${txt(p.initials)}), ${txt(p.date)}`).join('<br>')
    : txt(tk('collab.sign.none'));

/** The sign-off table, then the out-of-date note when a finding changed after sign-off. */
export function signOffHtml(b: SignOffBlock): string {
  const rows: [string, string][] = [
    [tk('collab.sign.prepared'), b.prepared ? people([b.prepared]) : txt(tk('collab.sign.none'))],
    [
      tk('collab.sign.reviewed'),
      `${people(b.reviewed)}<br><span class="muted">${txt(
        tk('collab.sign.findings', { approved: b.findings.approved, total: b.findings.total }),
      )}</span>`,
    ],
    [tk('collab.sign.approved'), people(b.approved)],
  ];
  if (b.accepted.length) rows.push([tk('collab.sign.accepted'), people(b.accepted)]);
  return `<table class="grid signoff" data-testid="house-signoff"><tbody>${rows
    .map(([k, v]) => `<tr><th>${txt(k)}</th><td>${v}</td></tr>`)
    .join('')}</tbody></table>`;
}

export function layoutApprovals(p: Pager, kicker: string, b: SignOffBlock): void {
  heading(p, kicker, tk('house.sec.approvals'));
  p.add(el(signOffHtml(b)));
  if (b.outOfDate.length) p.add(el(`<p class="nar">${txt(tk('collab.sign.outOfDate'))}</p>`));
}
