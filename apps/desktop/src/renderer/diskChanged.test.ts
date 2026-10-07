// @vitest-environment jsdom
import { changeStore } from '@aio/change';
import { afterEach, describe, expect, it } from 'vitest';
import { CHANGED_ON_DISK_PHRASE as MAIN_PHRASE, changedOnDiskMessage } from '../main/fsutil';
import {
  CHANGED_ON_DISK_PHRASE,
  diskChanged,
  isChangedOnDisk,
  reportIfChangedOnDisk,
  watchDiskChanged,
} from './diskChanged';

afterEach(() => {
  diskChanged.getState().dismiss();
});

describe('changed-on-disk refusals', () => {
  it('matches the sentence main answers (the phrase is the contract)', () => {
    expect(CHANGED_ON_DISK_PHRASE).toBe(MAIN_PHRASE);
    expect(isChangedOnDisk(changedOnDiskMessage('issues.json'))).toBe(true);
    expect(isChangedOnDisk('Could not save issues.json: EPERM')).toBe(false);
    expect(isChangedOnDisk(undefined)).toBe(false);
  });

  it('shows a refusal and leaves other errors to their screens', () => {
    expect(reportIfChangedOnDisk('The report text was not saved: disk full')).toBe(false);
    expect(diskChanged.getState().message).toBeNull();
    const message = changedOnDiskMessage('report/narrative.json');
    expect(reportIfChangedOnDisk(message)).toBe(true);
    expect(diskChanged.getState().message).toBe(message);
  });

  it('picks up a refused change review from its store', () => {
    const stop = watchDiskChanged();
    const message = changedOnDiskMessage('change/c1.json');
    changeStore.setState({ error: message });
    expect(diskChanged.getState().message).toBe(message);
    stop();
    changeStore.setState({ error: null });
  });
});
