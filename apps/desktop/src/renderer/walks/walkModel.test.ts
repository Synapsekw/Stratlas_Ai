import {
  WALK_SCHEMA,
  type JobRecord,
  type PipelinePackStatus,
  type WalkFile,
  type WalkProcessSummary,
} from '@aio/schema';
import { describe, expect, it } from 'vitest';
import { paneOptions, resolveSplit, type SplitPref } from '../workspace/splitModel';
import {
  autoStartParams,
  formatWalkTime,
  importAnswered,
  importedWalkRows,
  jobForWalk,
  levelOn,
  originalCheck,
  packOffersWalkProcess,
  pickWalk,
  playbackSrc,
  splitWithWalk,
  walkForRow,
  walkKeyAction,
  walkUnstabilised,
  walkStatus,
  walkStatusText,
  type JobLike,
} from './walkModel';

describe('formatWalkTime', () => {
  it('writes minutes and seconds, hours only when there are any', () => {
    expect(formatWalkTime(0)).toBe('0:00');
    expect(formatWalkTime(9.9)).toBe('0:09');
    expect(formatWalkTime(81.9)).toBe('1:21');
    expect(formatWalkTime(600)).toBe('10:00');
    expect(formatWalkTime(3725)).toBe('1:02:05');
  });

  it('reads anything that is not a time as zero', () => {
    expect(formatWalkTime(Number.NaN)).toBe('0:00');
    expect(formatWalkTime(-3)).toBe('0:00');
    expect(formatWalkTime(Infinity)).toBe('0:00');
  });
});

describe('walkKeyAction', () => {
  const paused = { playing: false, rate: 1, fps: 30 };
  const playing = { playing: true, rate: 1, fps: 30 };

  it('Space plays and pauses; K pauses at normal speed', () => {
    expect(walkKeyAction(' ', paused)).toEqual({ play: true, rate: 1 });
    expect(walkKeyAction(' ', playing)).toEqual({ play: false });
    expect(walkKeyAction('k', { ...playing, rate: 4 })).toEqual({ play: false, rate: 1 });
  });

  it('L plays, then doubles the speed up to 8 times', () => {
    expect(walkKeyAction('L', paused)).toEqual({ play: true, rate: 1 });
    expect(walkKeyAction('l', playing)).toEqual({ rate: 2 });
    expect(walkKeyAction('l', { ...playing, rate: 8 })).toEqual({ rate: 8 });
  });

  it('J slows a fast playback, else pauses and steps back a second', () => {
    expect(walkKeyAction('j', { ...playing, rate: 4 })).toEqual({ rate: 2 });
    expect(walkKeyAction('j', playing)).toEqual({ play: false, seekBy: -1 });
    expect(walkKeyAction('j', paused)).toEqual({ play: false, seekBy: -1 });
  });

  it('comma, period and the arrow keys step one frame', () => {
    expect(walkKeyAction(',', playing)).toEqual({ play: false, seekBy: -1 / 30 });
    expect(walkKeyAction('ArrowLeft', paused)).toEqual({ play: false, seekBy: -1 / 30 });
    expect(walkKeyAction('.', paused)).toEqual({ play: false, seekBy: 1 / 30 });
    expect(walkKeyAction('ArrowRight', { ...paused, fps: 0 })).toEqual({
      play: false,
      seekBy: 1 / 30,
    });
  });

  it('leaves every other key alone', () => {
    expect(walkKeyAction('a', paused)).toBeNull();
    expect(walkKeyAction('Enter', paused)).toBeNull();
  });
});

describe('importAnswered', () => {
  it('is the moment main answers an import, not the moment the panel is free again', () => {
    // main was importing and has answered: the walk list is asked for again now, even though
    // the import is still busy with a drawing's page question
    expect(importAnswered({ cancellable: true }, { cancellable: false })).toBe(true);
    expect(importAnswered({ cancellable: false }, { cancellable: false })).toBe(false);
    expect(importAnswered({ cancellable: false }, { cancellable: true })).toBe(false);
    expect(importAnswered({ cancellable: true }, { cancellable: true })).toBe(false);
  });
});

describe('pickWalk', () => {
  const walks = [{ id: 'b' }, { id: 'a' }];
  it('keeps the chosen walk while the project has it, else takes the first', () => {
    expect(pickWalk(walks, 'a')?.id).toBe('a');
    expect(pickWalk(walks, 'gone')?.id).toBe('b');
    expect(pickWalk(walks, null)?.id).toBe('b');
    expect(pickWalk<{ id: string }>([], 'a')).toBeUndefined();
  });
});

describe('splitWithWalk', () => {
  const options = paneOptions([], 0, 0, { walks: 1 });

  it('puts the 360 video on the right of the default split', () => {
    const next = splitWithWalk(undefined, options);
    expect(next).toMatchObject({ left: '3d', right: 'walk360' });
  });

  it('leaves a split alone that already shows it', () => {
    const saved: SplitPref = { left: 'walk360', right: 'map' };
    expect(splitWithWalk(saved, options)).toMatchObject({ left: 'walk360', right: 'map' });
  });

  it('keeps the left side the person chose', () => {
    const saved: SplitPref = { left: 'map', right: '3d' };
    expect(splitWithWalk(saved, options)).toMatchObject({ left: 'map', right: 'walk360' });
  });
});

describe('the split and walks', () => {
  it('offers the 360 video pane only when the project has a walk', () => {
    expect(paneOptions([], 0)).not.toContain('walk360');
    expect(paneOptions([], 0, 0, { walks: 0 })).not.toContain('walk360');
    expect(paneOptions([], 0, 0, { walks: 2 })).toContain('walk360');
  });

  it('falls back to the default when a remembered 360 video pane has nothing to show', () => {
    const saved: SplitPref = { left: '3d', right: 'walk360' };
    expect(resolveSplit(saved, paneOptions([], 0))).toMatchObject({ left: '3d', right: 'map' });
    expect(resolveSplit(saved, paneOptions([], 0, 0, { walks: 1 }))).toMatchObject({
      left: '3d',
      right: 'walk360',
    });
  });
});

describe('walkUnstabilised', () => {
  it('is true for a walk stitched from a camera file, false for a stitched MP4', () => {
    expect(walkUnstabilised({ source: { layout: 'insv-dual-stream' } })).toBe(true);
    expect(walkUnstabilised({ source: { layout: 'dual-fisheye' } })).toBe(true);
    expect(walkUnstabilised({ source: { layout: 'equirect' } })).toBe(false);
  });
});

// ---------------------------------------------------------------- walk.process

const walkOf = (id: string, file: string, layout: WalkFile['source']['layout']): WalkFile => ({
  schema: WALK_SCHEMA,
  id,
  name: file,
  createdAt: '2026-10-12T08:00:00.000Z',
  source: { file, layout, streams: [{ width: 128, height: 128, codec: 'avc1', fps: 30 }] },
  video: {
    src: `walks/${id}/playback.mp4`,
    width: 256,
    height: 128,
    durationS: 1,
    fps: 30,
    audio: false,
  },
});
const insv = walkOf('vid-1', 'VID_20260101_120000_00_001.insv', 'insv-dual-stream');
const summary = (o: Partial<WalkProcessSummary> = {}): WalkProcessSummary => ({
  createdAt: '2026-10-12T10:00:00.000Z',
  source: 'sfm',
  warnings: 0,
  ...o,
});
const job = (o: Partial<JobLike> = {}): JobLike => ({
  id: 'j1',
  status: 'running',
  progress: 0.42,
  updatedAt: '2026-10-12T11:00:00.000Z',
  ...o,
});

describe('walkStatus', () => {
  it('stays on processing between a done job and the list reading its run record', () => {
    expect(walkStatus(insv, undefined, job({ status: 'done', progress: 1 }))).toEqual({
      kind: 'processing',
      pct: 99,
      jobId: 'j1',
    });
    expect(walkStatus(insv, summary(), job({ status: 'done', progress: 1 }))).toEqual({
      kind: 'processed',
      source: 'sfm',
    });
  });

  it('is not processed without a run record or a job', () => {
    expect(walkStatus(insv, undefined, undefined)).toEqual({ kind: 'not-processed' });
    expect(walkStatusText({ kind: 'not-processed' })).toBe('Not processed');
  });

  it('follows a running job in whole percent', () => {
    const s = walkStatus(insv, undefined, job());
    expect(s).toEqual({ kind: 'processing', pct: 42, jobId: 'j1' });
    expect(walkStatusText(s)).toBe('Processing 42 %');
    // never 100 % before the job is done
    expect(walkStatus(insv, undefined, job({ progress: 0.999, status: 'starting' }))).toEqual({
      kind: 'processing',
      pct: 99,
      jobId: 'j1',
    });
    // a running re-run says so over the older outputs
    expect(walkStatus(insv, summary(), job({ status: 'cancelling' })).kind).toBe('processing');
  });

  it('reads the path source of a processed walk', () => {
    const sfm = walkStatus(insv, summary(), undefined);
    expect(sfm).toEqual({ kind: 'processed', source: 'sfm' });
    expect(walkStatusText(sfm)).toBe('Processed');
    const pins = walkStatus(insv, summary({ source: 'pins-only' }), job({ status: 'done' }));
    expect(pins).toEqual({ kind: 'processed', source: 'pins-only' });
    expect(walkStatusText(pins)).toBe('Processed, path from pins only');
  });

  it('says a failed job failed, unless a newer run record came after it', () => {
    const failed = walkStatus(insv, undefined, job({ status: 'failed', error: 'No ffmpeg' }));
    expect(failed).toEqual({ kind: 'failed', message: 'No ffmpeg' });
    expect(walkStatusText(failed)).toBe('Processing failed: No ffmpeg');
    // a failed re-run of a processed walk: the failure is the news
    expect(walkStatus(insv, summary(), job({ status: 'failed', error: 'x' }))).toEqual({
      kind: 'failed',
      message: 'x',
    });
    expect(
      walkStatus(
        insv,
        summary({ createdAt: '2026-10-12T12:00:00.000Z' }),
        job({ status: 'failed', error: 'x' }),
      ),
    ).toEqual({ kind: 'processed', source: 'sfm' });
    expect(walkStatus(insv, undefined, job({ status: 'failed' }))).toEqual({
      kind: 'failed',
      message: 'The job stopped with an error.',
    });
  });

  it('is not processed after a cancelled or interrupted job without outputs', () => {
    expect(walkStatus(insv, undefined, job({ status: 'cancelled' }))).toEqual({
      kind: 'not-processed',
    });
    expect(walkStatus(insv, undefined, job({ status: 'interrupted' }))).toEqual({
      kind: 'not-processed',
    });
  });
});

describe('playbackSrc', () => {
  it('plays the levelled copy only when there is one and Level horizon is on', () => {
    const level = summary({ stabilized: 'walks/vid-1/stabilized.mp4' });
    expect(playbackSrc(insv, level, true)).toBe('walks/vid-1/stabilized.mp4');
    expect(playbackSrc(insv, level, false)).toBe('walks/vid-1/playback.mp4');
    expect(playbackSrc(insv, summary(), true)).toBe('walks/vid-1/playback.mp4');
    expect(playbackSrc(insv, undefined, true)).toBe('walks/vid-1/playback.mp4');
  });
});

describe('levelOn', () => {
  it('is on unless the person turned it off for that walk', () => {
    expect(levelOn({}, 'a')).toBe(true);
    expect(levelOn({ a: false }, 'a')).toBe(false);
    expect(levelOn({ a: false }, 'b')).toBe(true);
  });
});

describe('autoStartParams', () => {
  const path = 'D:\\camera\\VID_20260101_120000_00_001.insv';
  const row = { file: insv.source.file, status: 'imported' as const, path };

  it('carries the walk id and the path the import was given', () => {
    expect(autoStartParams(row, insv, true)).toEqual({ walk: 'vid-1', src: [path] });
  });

  it('starts from the playback copy when the path is not known', () => {
    expect(autoStartParams({ file: row.file, status: 'imported' }, insv, true)).toEqual({
      walk: 'vid-1',
    });
  });

  it('starts nothing for a skipped row, a proxy row, another walk or a pack without it', () => {
    expect(autoStartParams({ ...row, status: 'skipped' }, insv, true)).toBeNull();
    expect(autoStartParams({ ...row, status: 'error' }, insv, true)).toBeNull();
    const lrv = walkOf('lrv-1', 'LRV_20260101_120000_01_001.lrv', 'insv-dual-stream');
    expect(
      autoStartParams({ file: lrv.source.file, status: 'imported', path: 'D:\\x.lrv' }, lrv, true),
    ).toBeNull();
    expect(autoStartParams({ ...row, file: 'other.insv' }, insv, true)).toBeNull();
    expect(autoStartParams(row, insv, false)).toBeNull();
  });
});

describe('walkForRow', () => {
  it('finds the newest walk of an import row by its file name', () => {
    const older = { ...insv, id: 'vid-0' };
    expect(walkForRow([insv, older], { file: insv.source.file })?.id).toBe('vid-1');
    expect(walkForRow([insv], { file: 'nope.insv' })).toBeUndefined();
  });
});

describe('packOffersWalkProcess', () => {
  const status = (o: Partial<PipelinePackStatus>): PipelinePackStatus => ({
    state: 'ok',
    runtimeDir: 'r',
    platform: 'win32-x64',
    needs: [],
    others: [],
    installing: false,
    notify: false,
    ...o,
  });

  it('is true for a pack that lacks nothing, or one from the environment', () => {
    expect(packOffersWalkProcess(status({}))).toBe(true);
    expect(packOffersWalkProcess(status({ state: 'dev' }))).toBe(true);
  });

  it('is false with no usable pack, or before main answered', () => {
    expect(packOffersWalkProcess(null)).toBe(false);
    expect(packOffersWalkProcess(status({ state: 'missing' }))).toBe(false);
    expect(packOffersWalkProcess(status({ state: 'incompatible' }))).toBe(false);
  });

  it('is false for a pack before the first with walk.process', () => {
    const need = 'Processing 360 walks needs version 0.6.0 or later.';
    expect(packOffersWalkProcess(status({ state: 'too-old', needs: [need] }))).toBe(false);
  });

  it('reads a too old pack by what it cannot run', () => {
    const feature = 'Creating maps from photos needs version 0.4.0 or later.';
    expect(packOffersWalkProcess(status({ state: 'too-old', needs: [feature] }))).toBe(true);
    expect(
      packOffersWalkProcess(
        status({ state: 'too-old', needs: ['This version cannot run "Process 360 walk".'] }),
      ),
    ).toBe(false);
    expect(
      packOffersWalkProcess(
        status({ state: 'too-old', needs: ['This version cannot run "Direct rainfall".'] }),
      ),
    ).toBe(true);
    // several kinds missing: the sentence names only two; a pack that old has no walk.process
    expect(
      packOffersWalkProcess(
        status({
          state: 'too-old',
          needs: ['This version cannot run 3 kinds of job this app has, for example "A" and "B".'],
        }),
      ),
    ).toBe(false);
  });
});

describe('jobForWalk', () => {
  const rec = (o: Partial<JobRecord>): JobRecord => ({
    id: 'j',
    pipeline: 'walk.process',
    project: 'D:/p',
    params: { walk: 'vid-1' },
    status: 'running',
    progress: 0,
    steps: [],
    artifacts: [],
    createdAt: '2026-10-12T08:00:00.000Z',
    updatedAt: '2026-10-12T08:00:00.000Z',
    ...o,
  });

  it('takes the newest walk.process job of that walk in that project', () => {
    const jobs = [
      rec({ id: 'other-walk', params: { walk: 'vid-2' } }),
      rec({ id: 'other-project', project: 'D:/q' }),
      rec({ id: 'other-pipeline', pipeline: 'photo.align' }),
      rec({ id: 'newest', project: 'd:\\p\\' }),
      rec({ id: 'older' }),
    ];
    expect(jobForWalk(jobs, 'D:/p', 'vid-1')?.id).toBe('newest');
    expect(jobForWalk(jobs, 'D:/p', 'vid-9')).toBeUndefined();
  });
});

describe('originalCheck', () => {
  it('accepts the file the walk was imported from, by name', () => {
    expect(originalCheck('D:\\cam\\VID_1.insv', 'VID_1.insv')).toBeNull();
    expect(originalCheck('D:/cam/vid_1.INSV', 'VID_1.insv')).toBeNull();
  });

  it('says which file was picked when it is another one', () => {
    expect(originalCheck('D:\\cam\\VID_2.insv', 'VID_1.insv')).toBe(
      'VID_2.insv is not VID_1.insv. Pick the original file, or process without it.',
    );
  });
});

describe('importedWalkRows', () => {
  it('finds the original of a walk imported with its folder (Import a flight folder)', () => {
    const rows = importedWalkRows(
      [{ file: 'VID_1.insv', kind: 'video', status: 'imported' }],
      ['D:/flight/VID_1.insv', 'D:/flight'],
    );
    expect(rows).toEqual([
      { file: 'VID_1.insv', status: 'imported', path: 'D:/flight/VID_1.insv' },
    ]);
    const walk = walkOf('vid-1', 'VID_1.insv', 'insv-dual-stream');
    const row = rows[0];
    expect(row && autoStartParams(row, walk, true)).toEqual({
      walk: 'vid-1',
      src: ['D:/flight/VID_1.insv'],
    });
  });

  it('keeps the imported 360 video rows with the path each came from', () => {
    const rows = importedWalkRows(
      [
        { file: 'VID_1.insv', kind: 'video', status: 'imported' },
        { file: 'LRV_1.lrv', kind: 'video', status: 'skipped' },
        { file: 'a.jpg', kind: 'photo', status: 'imported' },
        { file: 'b.mp4', kind: 'video', status: 'imported' },
      ],
      ['D:\\cam\\VID_1.insv', 'D:\\cam\\a.jpg'],
    );
    expect(rows).toEqual([
      { file: 'VID_1.insv', status: 'imported', path: 'D:\\cam\\VID_1.insv' },
      { file: 'b.mp4', status: 'imported' },
    ]);
  });
});
