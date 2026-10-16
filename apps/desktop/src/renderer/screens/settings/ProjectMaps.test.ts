// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { summaryText } from './ProjectMaps';

const none = { total: 0, located: 0, missing: 0, overviewOnly: 0, uncovered: 0, noLocation: 0 };

describe('Offline maps summary', () => {
  it('does not call a library of demo projects empty: demos need no map download', () => {
    expect(summaryText(none)).toBe('No projects of your own yet');
  });

  it('counts the placed projects without a detailed map', () => {
    expect(summaryText({ ...none, total: 3, located: 3, missing: 1, uncovered: 1 })).toBe(
      '1 of 3 projects has no detailed street map',
    );
  });
});
