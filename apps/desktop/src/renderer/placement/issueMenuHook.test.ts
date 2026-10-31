// @vitest-environment jsdom
import { getIssueListActions } from '@aio/annotate';
import { afterEach, describe, expect, it } from 'vitest';
import { closeIssueMenu, issueMenu } from '../flyability/issueMenuStore';
import { startPlacement } from './index';

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  closeIssueMenu();
});

describe('startPlacement', () => {
  it("the register's issueMenu hook opens the issue menu store", () => {
    stop = startPlacement();
    getIssueListActions().issueMenu?.({ x: 12, y: 34 }, ['i1', 'i2'], 'i2');
    expect(issueMenu.getState().at).toEqual({ x: 12, y: 34, ids: ['i1', 'i2'], clicked: 'i2' });
  });
});
