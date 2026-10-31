import { beforeEach, describe, expect, it } from 'vitest';
import { projectListStore, revealInList } from './projectListStore';

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
});
