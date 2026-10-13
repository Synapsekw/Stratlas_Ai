import type { ImportItem, Layer } from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { importDestination, importHeadline } from './importSummary';

const walk = { kind: 'walk', id: 'walk-tour', name: 'tour' } as Layer;
const clip = { kind: 'video', id: 'clip-a', name: 'a' } as Layer;
const row = (over: Partial<ImportItem>): ImportItem => ({
  file: 'f.mp4',
  kind: 'video',
  status: 'imported',
  ...over,
});

describe('where each file went', () => {
  it('names the group a file was added to', () => {
    expect(importDestination(row({ layerId: 'walk-tour' }), [walk, clip])).toBe(
      'Added as a walk under 360 walks',
    );
    expect(importDestination(row({ layerId: 'clip-a' }), [walk, clip])).toBe(
      'Added to Datasets, Video',
    );
    expect(importDestination(row({ kind: 'photo', layerId: 'photos' }), [])).toBe(
      'Added to Datasets, Photos',
    );
  });

  it('says why a file was skipped or failed, and what waits for processing', () => {
    expect(importDestination(row({ status: 'skipped', message: 'No DJI SRT.' }), [])).toBe(
      'Skipped: No DJI SRT.',
    );
    expect(importDestination(row({ status: 'error', message: 'Disk full.' }), [])).toBe(
      'Failed: Disk full.',
    );
    expect(importDestination(row({ status: 'skipped' }), [])).toBe(
      'Skipped: not a file this app reads',
    );
    expect(importDestination(row({ status: 'queued' }), [])).toBe(
      'Processing; it appears when it is done',
    );
    expect(importDestination(row({ status: 'needs-pipeline' }), [])).toBe(
      'Needs the processing tools',
    );
  });

  it('the headline says when nothing came in', () => {
    expect(importHeadline([row({}), row({ status: 'skipped' })])).toBe('Imported 1 of 2 files');
    expect(importHeadline([row({ status: 'skipped' })])).toBe('Nothing imported: 1 file skipped');
    expect(importHeadline([row({ status: 'error' }), row({ status: 'skipped' })])).toBe(
      'Nothing imported: 1 file failed, 1 skipped',
    );
  });
});
