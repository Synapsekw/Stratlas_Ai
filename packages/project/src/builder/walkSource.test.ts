import { describe, expect, it } from 'vitest';
import {
  classifyWalkSource,
  insta360Name,
  isStitched360,
  isWalkFile,
  proxyOwner,
  type WalkTrack,
} from './walkSource';

const lens = (w = 2880, h = 2880): WalkTrack => ({
  handler: 'vide',
  width: w,
  height: h,
  codec: 'hvc1',
  fps: 59.94,
  durationMs: 81_898,
  spherical: null,
});
const sound: WalkTrack = {
  handler: 'soun',
  width: 0,
  height: 0,
  codec: 'mp4a',
  fps: 46.88,
  durationMs: 81_877,
  spherical: null,
};

describe('insta360Name', () => {
  it('reads the clip and its proxy, with the camera time', () => {
    expect(insta360Name('VID_20260101_120000_00_001.insv')).toEqual({
      role: 'clip',
      stamp: '20260101_120000',
      seq: '001',
      capturedAt: '2026-01-01T12:00:00',
    });
    expect(insta360Name('LRV_20260101_120000_01_001.lrv')).toMatchObject({
      role: 'proxy',
      stamp: '20260101_120000',
      seq: '001',
    });
    // some cameras write the proxy with the clip's extension
    expect(insta360Name('lrv_20260101_120000_11_002.INSV')?.role).toBe('proxy');
  });

  it('is null for other names and for dates that are not dates', () => {
    expect(insta360Name('walk.insv')).toBeNull();
    expect(insta360Name('VID_20261301_120000_00_001.insv')).toBeNull();
    expect(insta360Name('flight-0001.MP4')).toBeNull();
  });
});

describe('isWalkFile', () => {
  it('takes the camera extensions in any case, nothing else', () => {
    expect(isWalkFile('a.insv')).toBe(true);
    expect(isWalkFile('A.LRV')).toBe(true);
    expect(isWalkFile('a.mp4')).toBe(false);
    expect(isWalkFile('insv')).toBe(false);
  });
});

describe('proxyOwner', () => {
  const clip = 'VID_20260101_120000_00_001.insv';
  it('pairs a proxy with the clip of the same time and number', () => {
    expect(proxyOwner('LRV_20260101_120000_01_001.lrv', [clip, 'other.mp4'])).toBe(clip);
  });
  it('does not pair across times, numbers or with another proxy', () => {
    expect(proxyOwner('LRV_20260101_120001_01_001.lrv', [clip])).toBeNull();
    expect(proxyOwner('LRV_20260101_120000_01_002.lrv', [clip])).toBeNull();
    expect(proxyOwner('LRV_20260101_120000_01_001.lrv', ['LRV_20260101_120000_01_001.lrv'])).toBe(
      null,
    );
    expect(proxyOwner(clip, [clip])).toBeNull();
    expect(proxyOwner('notes.lrv', [clip])).toBeNull();
  });
});

describe('classifyWalkSource', () => {
  it('a camera file with one square track per lens is two lens streams', () => {
    const r = classifyWalkSource({
      name: 'VID_20260101_120000_00_001.insv',
      tracks: [lens(), lens(), sound],
    });
    expect(r).toMatchObject({ ok: true, layout: 'insv-dual-stream', audio: true, lowRes: false });
    if (r.ok) expect(r.video).toHaveLength(2);
  });

  it('a proxy with one 2:1 track is both fisheye pictures in one frame, at low resolution', () => {
    const r = classifyWalkSource({
      name: 'LRV_20260101_120000_01_001.lrv',
      tracks: [{ ...lens(1664, 832), codec: 'avc1', fps: 29.97 }, sound],
    });
    expect(r).toMatchObject({ ok: true, layout: 'dual-fisheye', lowRes: true });
  });

  it('skips a camera file with one lens stream, saying what it found', () => {
    const r = classifyWalkSource({ name: 'VID_20200101_120000_00_001.insv', tracks: [lens()] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('one video track (2880 x 2880)');
      expect(r.message).toContain('Add 360 video');
    }
  });

  it('skips a single 2:1 track in a clip that is not a proxy (unverified layout)', () => {
    const r = classifyWalkSource({
      name: 'VID_20200101_120000_00_001.insv',
      tracks: [lens(5760, 2880)],
    });
    expect(r.ok).toBe(false);
  });

  it('skips lens streams of different sizes, three streams and files without a picture', () => {
    for (const tracks of [[lens(), lens(1920, 1920)], [lens(), lens(), lens()], [sound], []]) {
      const r = classifyWalkSource({ name: 'clip.insv', tracks });
      expect(r.ok).toBe(false);
    }
    const two = classifyWalkSource({
      name: 'clip.insv',
      tracks: [lens(3840, 2160), lens(3840, 2160)],
    });
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.message).toContain('3840 x 2160');
  });

  it('a 2:1 MP4 is equirectangular; without sound it says so', () => {
    const r = classifyWalkSource({
      name: 'tour.mp4',
      tracks: [{ ...lens(3840, 1920), codec: 'avc1' }],
    });
    expect(r).toMatchObject({ ok: true, layout: 'equirect', audio: false, lowRes: false });
  });

  it('an MP4 that is not 2:1 is refused, unless its metadata says equirectangular', () => {
    const flat = classifyWalkSource({ name: 'drone.mp4', tracks: [lens(3840, 2160)] });
    expect(flat.ok).toBe(false);
    if (!flat.ok) expect(flat.message).toContain('3840 x 2160');
    const tagged = classifyWalkSource({
      name: 'crop.mp4',
      tracks: [{ ...lens(3840, 2160), spherical: 'equirectangular' }],
    });
    expect(tagged).toMatchObject({ ok: true, layout: 'equirect' });
  });

  it('a 2:1 MP4 whose metadata names another projection is refused', () => {
    const r = classifyWalkSource({
      name: 'cube.mp4',
      tracks: [{ ...lens(3840, 1920), spherical: 'other' }],
    });
    expect(r.ok).toBe(false);
  });

  it('other file types are not 360 video', () => {
    const r = classifyWalkSource({ name: 'clip.avi', tracks: [lens(3840, 1920)] });
    expect(r.ok).toBe(false);
  });
});

describe('isStitched360', () => {
  const v = (
    width: number,
    height: number,
    spherical: WalkTrack['spherical'] = null,
  ): WalkTrack => ({
    handler: 'vide',
    width,
    height,
    codec: 'hvc1',
    fps: 30,
    durationMs: 2000,
    spherical,
  });

  it('an MP4 or MOV with equirectangular metadata or a 2:1 frame is a stitched 360 video', () => {
    expect(isStitched360('VID_20261013_export.mp4', [v(5760, 2880, 'equirectangular')])).toBe(true);
    expect(isStitched360('tour.MOV', [v(3840, 1920)])).toBe(true);
  });

  it('a 16:9 clip, a non equirectangular sphere, a camera file or no video is not', () => {
    expect(isStitched360('flat-clip.mp4', [v(3840, 2160)])).toBe(false);
    expect(isStitched360('cube.mp4', [v(3840, 1920, 'other')])).toBe(false);
    expect(isStitched360('VID_1.insv', [v(2880, 2880), v(2880, 2880)])).toBe(false);
    expect(isStitched360('audio.mp4', [])).toBe(false);
  });
});
