// @vitest-environment jsdom
import { AGENT_ACTIONS, AGENT_TARGET_KINDS } from '@aio/ai';
import { registeredActions, type Action } from '@aio/ui';
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

const TABLE = 'AGENT_ACTIONS in packages/ai/src/action-tool-specs.ts';

/** The fix a failure asks for, written so the next session can make it without asking. */
const howToAdd = (id: string) =>
  `Add one line for "${id}" to ${TABLE}: either a risk ` +
  `('${id}': VIEW for a view-only action, WRITE for one that changes data or writes a file, ` +
  `CONFIRM when it opens a confirm box, FINISH when it opens a dialog the person completes), ` +
  `or an exclusion with the reason the agent may not run it ` +
  `('${id}': { exclude: 'Opens a name field for the person to type in.' }).`;

/** Menu sections that only show or open things; the others change the project. */
const VIEW_SECTIONS = new Set<Action['section']>(['open', 'view', 'compare']);

const covered = (a: Action) => {
  const e = AGENT_ACTIONS[a.id];
  return e !== undefined && 'risk' in e ? e : null;
};

describe('agent coverage of the action registry', () => {
  it('has an entry, covered or excluded with a reason, for every registered action', () => {
    for (const a of registeredActions()) {
      expect(AGENT_ACTIONS[a.id], howToAdd(a.id)).toBeDefined();
    }
  });

  it('names no action the registry does not have', () => {
    const known = new Set(registeredActions().map((a) => a.id));
    for (const id of Object.keys(AGENT_ACTIONS)) {
      expect(
        known.has(id),
        `"${id}" is in ${TABLE} but no menu registers it: remove its line`,
      ).toBe(true);
    }
  });

  it('gives every covered action a target the agent can name', () => {
    const nameable = new Set<string>(AGENT_TARGET_KINDS);
    for (const a of registeredActions()) {
      if (!covered(a)) continue;
      expect(
        a.targets.some((k) => nameable.has(k)),
        `"${a.id}" only acts on ${a.targets.join(', ')}: exclude it in ${TABLE} with a reason`,
      ).toBe(true);
    }
  });

  it('asks for approval before every action filed under edit, date, file or danger', () => {
    for (const a of registeredActions()) {
      const e = covered(a);
      if (!e || VIEW_SECTIONS.has(a.section)) continue;
      expect(
        e.risk === 'write' || (e.why?.length ?? 0) > 10,
        `"${a.id}" sits in the ${a.section} section: make it WRITE in ${TABLE}, or viewIn('why only the view changes')`,
      ).toBe(true);
      if (a.section === 'danger') expect(e.risk, `"${a.id}" is a danger action`).toBe('write');
    }
  });

  it('says a run waits for the person when the action opens a confirm box', () => {
    const asking = registeredActions()
      .filter((a) => /askRemove|askDelete|\.confirm\(/.test(a.run.toString()))
      .map((a) => a.id);
    // the check reads the run's code, so it must still see the known ones; a run behind a
    // wrapper (date.delete, through the date folder helper) is held by its table line instead
    expect(asking).toEqual(expect.arrayContaining(['layer.delete', 'antenna.delete']));
    for (const id of ['date.delete', 'layers.rereadPhotos']) {
      const e = AGENT_ACTIONS[id];
      expect(e && 'risk' in e ? e.then : undefined, id).toBe('confirm');
    }
    for (const a of registeredActions()) {
      const e = covered(a);
      if (!e) continue;
      const asks = /askRemove|askDelete|\.confirm\(/.test(a.run.toString());
      if (asks)
        expect(e.then, `"${a.id}" asks the person to confirm: make it CONFIRM in ${TABLE}`).toBe(
          'confirm',
        );
    }
  });
});
