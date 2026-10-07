import type { ApprovalView, CollabState } from '@aio/schema';
import { hlcDate } from './ids';

/** A person on the sign-off block. */
export interface SignOffPerson {
  actor: string;
  name: string;
  initials: string;
  /** `2026-10-07`. */
  date: string;
}

export interface SignOffBlock {
  /** The project has a team policy: the block applies. */
  shared: boolean;
  prepared: SignOffPerson | null;
  /** People whose current approvals cover findings in the report. */
  reviewed: SignOffPerson[];
  /** People whose current approvals cover the report itself. */
  approved: SignOffPerson[];
  /** Client acceptance: recorded, never a status (decision 6). */
  accepted: SignOffPerson[];
  /** Report approvals that went out of date when a finding changed. */
  outOfDate: SignOffPerson[];
  /** Findings approved at their current content, of all findings. */
  findings: { approved: number; total: number };
  required: number;
}

type Who = (actor: string) => { name: string; initials: string };

function people(list: readonly ApprovalView[], who: Who): SignOffPerson[] {
  const latest = new Map<string, ApprovalView>();
  for (const a of list) {
    const prev = latest.get(a.by);
    if (!prev || prev.at < a.at) latest.set(a.by, a);
  }
  return [...latest.values()]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((a) => ({ actor: a.by, ...who(a.by), date: hlcDate(a.at) }));
}

/**
 * The report's sign-off block (house report, section `approvals`): prepared by the person
 * printing, reviewed by those whose current approvals cover the findings, approved by those who
 * signed the report at its current inputs, and the client's acceptance listed apart.
 */
export function signOffBlock(
  state: CollabState,
  opts: {
    projectId: string;
    issueIds: readonly string[];
    who: Who;
    prepared?: { actor: string; date: string } | null;
  },
): SignOffBlock {
  const live = state.approvals.filter((a) => !a.withdrawn);
  const issueIds = new Set(opts.issueIds);
  const onIssues = live.filter(
    (a) => a.target.kind === 'issue' && issueIds.has(a.target.id) && a.decision === 'approve',
  );
  const onReport = live.filter((a) => a.target.kind === 'report' && a.target.id === opts.projectId);
  const approvedIssues = new Set(onIssues.filter((a) => a.current).map((a) => a.target.id));
  return {
    shared: state.policy !== null,
    prepared: opts.prepared
      ? { actor: opts.prepared.actor, ...opts.who(opts.prepared.actor), date: opts.prepared.date }
      : null,
    reviewed: people(
      onIssues.filter((a) => a.current),
      opts.who,
    ),
    approved: people(
      onReport.filter((a) => a.decision === 'approve' && a.current),
      opts.who,
    ),
    accepted: people(
      live.filter((a) => a.decision === 'accept' && a.current),
      opts.who,
    ),
    outOfDate: people(
      onReport.filter((a) => a.decision === 'approve' && !a.current),
      opts.who,
    ),
    findings: { approved: approvedIssues.size, total: issueIds.size },
    required: state.policy?.approval.required ?? 1,
  };
}
