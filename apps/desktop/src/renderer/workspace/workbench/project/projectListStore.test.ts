import { beforeEach, describe, expect, it } from 'vitest';
import { projectListStore, requestToolsScroll, revealInList } from './projectListStore';

beforeEach(() => {
  projectListStore.setState(projectListStore.getInitialState());
});

describe('projectListStore', () => {
  it('a reveal names its group and row, and grows its seq every time', () => {
    revealInList('antennas', 'ant-1');
    expect(projectListStore.getState().reveal).toEqual({ group: 'antennas', id: 'ant-1', seq: 1 });
    // the same row again is a new request (it scrolls again); another group's counts on
    revealInList('antennas', 'ant-1');
    revealInList('measurements', null);
    expect(projectListStore.getState().reveal).toEqual({
      group: 'measurements',
      id: null,
      seq: 3,
    });
  });

  it('a tools-scroll request grows toolsSeq', () => {
    expect(projectListStore.getState().toolsSeq).toBe(0);
    requestToolsScroll();
    requestToolsScroll();
    expect(projectListStore.getState().toolsSeq).toBe(2);
  });
});
