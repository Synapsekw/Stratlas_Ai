import type { Quat, Vec3 } from '@aio/schema';
import type { ViewPose } from '@aio/video';

/**
 * Spot history (spec Part S1): a spot is a camera, a facing and a target on the ground; the search
 * returns, per survey date, the images of the same spot. Pure data; no file is written.
 */

/** What a match shows: a ground photo, a drone photo, a 360, a walk frame or a video frame. */
export type SpotKind = 'photo' | 'drone' | 'pano' | 'walk' | 'video';

/** One image the viewer can show: a photo or panorama by id, a walk or clip at `t` seconds. */
export type SpotItem =
  | { kind: 'photo'; layer: string; photo: string }
  | { kind: 'pano'; layer: string; pano: string }
  | { kind: 'walk'; layer: string; t: number }
  | { kind: 'video'; layer: string; t: number };

/** How the viewer is opened: the clicked item, its exact camera when the caller knows it, its look. */
export interface SpotOpen {
  item: SpotItem;
  /** A video frame's calibrated camera at `t` (the Frames pane has it). */
  pose?: { pos: Vec3; q: Quat };
  /** A 360 or walk frame's current compass bearing of the look. */
  lookDeg?: number;
}

export interface Spot {
  camera?: Vec3;
  /** Compass bearing of the view (0 north, 90 east); absent when it looks straight down. */
  bearingDeg?: number;
  /** Where the view's centre line meets the ground. */
  target: Vec3;
  /** The camera is more than `aerialAboveM` above the target. */
  aerial: boolean;
}

/** A placed walk at one moment: camera position, its ground, the picture centre's bearing. */
export interface TrackSample {
  t: number;
  pos: Vec3;
  groundY: number;
  bearingDeg: number;
}

/** A clip at one moment (video seconds) with its calibrated camera. */
export interface FrameSample {
  t: number;
  pose: ViewPose;
}

/** What the search reads. `capture` undefined: an undated layer (found as an origin, never a slot). */
export interface PhotoEntry {
  kind: 'photo';
  layer: string;
  capture: string | undefined;
  id: string;
  /** Absent: no position (no GPS), it cannot match. */
  pos?: Vec3;
  /** Position and direction with the hand correction; null without a direction. */
  pose: ViewPose | null;
  /** The photo has its own lens (drone matching needs one). */
  hasLens: boolean;
}
export interface PanoEntry {
  kind: 'pano';
  layer: string;
  capture: string | undefined;
  id: string;
  pos: Vec3;
  headingDeg: number;
}
export interface WalkEntry {
  kind: 'walk';
  layer: string;
  capture: string | undefined;
  /** Null: not placed, it cannot match. */
  samples: readonly TrackSample[] | null;
}
export interface VideoEntry {
  kind: 'video';
  layer: string;
  capture: string | undefined;
  /** Null: the flight log cannot be read, it cannot match. */
  samples: readonly FrameSample[] | null;
}
export type SpotEntry = PhotoEntry | PanoEntry | WalkEntry | VideoEntry;

export interface SpotMatch {
  capture: string;
  kind: SpotKind;
  item: SpotItem;
  /** Horizontal distance from the spot's camera (or its target when it is aerial), metres. */
  distanceM: number;
  /** Angle between the facings, degrees; null when either has none. */
  angleDeg: number | null;
  /** Compass bearing a 360 or walk frame opens turned to (towards the target). */
  lookDeg?: number;
  /** A walk frame's picture centre bearing at its moment: the frame turns by look minus this. */
  centreDeg?: number;
  /** Lower ranks first within its class (ground-level or aerial). */
  score: number;
  aerial: boolean;
}

export interface SpotDate {
  capture: string;
  /** Best first; the first fills the slot, the others sit behind "+n". */
  matches: SpotMatch[];
  /** Items of this date that cannot match (no position, not placed, unreadable flight). */
  skipped: number;
}

/** Every survey date, oldest first, with its matches. */
export interface SpotHistory {
  spot: Spot;
  dates: SpotDate[];
}
