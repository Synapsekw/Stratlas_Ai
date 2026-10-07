/**
 * Decision 6: the agent may comment and list work, never approve. A tool whose name approves,
 * accepts, signs off or withdraws an approval must never reach the model. Main checks the whole
 * catalogue at start (`assertAgentCannotApprove`), so a later package cannot add one quietly.
 */
const APPROVING = /(^|_)(approve|approves|accept|accepts|sign_?off|signoff|withdraw)(_|$)/;

/** Tool names that would let the agent approve. `request_approval` (assign and comment) is fine. */
export function approvingTools(names: readonly string[]): string[] {
  return names.filter((n) => APPROVING.test(n));
}

export function assertAgentCannotApprove(names: readonly string[]): void {
  const bad = approvingTools(names);
  if (bad.length)
    throw new Error(`The agent must never approve; remove these tools: ${bad.join(', ')}`);
}

/** What the agent answers when asked to approve. */
export const AGENT_CANNOT_APPROVE =
  'Only a person can approve. Open the issue and use Approve, or ask a reviewer.';
