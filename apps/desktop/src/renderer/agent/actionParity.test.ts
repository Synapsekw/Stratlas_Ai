// @vitest-environment jsdom
import { AGENT_ACTIONS, AGENT_TARGET_KINDS } from '@aio/ai';
import { registeredActions } from '@aio/ui';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Agent parity with the right-click registry (A2): every action a person can run from a menu is
 * either offered to the agent (with a risk: a write asks for approval) or excluded with a reason,
 * in `AGENT_ACTIONS` (`@aio/ai` action-tool-specs.ts). A new menu action without an entry fails
 * here, so no feature lands without a decision about the agent.
 */
beforeAll(async () => {
  const { registerSidebarActions } = await import('../shell/actions');
  registerSidebarActions();
});

const ids = () => registeredActions().map((a) => a.id);

describe('agent coverage of the action registry', () => {
  it('has an entry, covered or excluded with a reason, for every registered action', () => {
    const missing = ids().filter((id) => AGENT_ACTIONS[id] === undefined);
    expect(
      missing,
      'Add these to AGENT_ACTIONS in packages/ai/src/action-tool-specs.ts: a risk, or exclude with a reason',
    ).toEqual([]);
  });

  it('names no action the registry does not have', () => {
    const known = new Set(ids());
    expect(Object.keys(AGENT_ACTIONS).filter((id) => !known.has(id))).toEqual([]);
  });

  it('gives every covered action a target the agent can name', () => {
    const nameable = new Set<string>(AGENT_TARGET_KINDS);
    const stranded = registeredActions()
      .filter((a) => {
        const e = AGENT_ACTIONS[a.id];
        return e !== undefined && 'risk' in e && !a.targets.some((k) => nameable.has(k));
      })
      .map((a) => a.id);
    expect(stranded).toEqual([]);
  });

  it('asks for approval before every delete or danger action it covers', () => {
    const unguarded = registeredActions()
      .filter((a) => a.section === 'danger')
      .filter((a) => {
        const e = AGENT_ACTIONS[a.id];
        return e !== undefined && 'risk' in e && e.risk !== 'write';
      })
      .map((a) => a.id);
    expect(unguarded).toEqual([]);
  });
});
