import { useTaxonomy } from '@aio/annotate';
import { PANO_FOV, dragLook, zoomLook, type PanoLook } from '@aio/engine';
import {
  shiftLocal,
  type AssetRef,
  type DateShift,
  type WalkFile,
  type WalkLayer,
} from '@aio/schema';
import { Icon, Tip, useT } from '@aio/ui';
import { createPanoVideoView, type PanoVideoView } from '@aio/video';
import { assetUrl, dateShiftOf, useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useStore } from 'zustand';
import { detectionLook } from '../detections/look';
import { loadDetections, useDetections } from '../detections/store';
import { SpotHistoryButton } from '../workspace/spot/SpotHistoryEntry';
import { wrapDeg } from '../workspace/spot/spotGeom';
import { bearingFromHeadingRad } from '../workspace/spot/spotWalk';
import { captureLabel, useCaptureIndex } from '../workspace/compare';
import type { SplitModel } from '../workspace/SplitPanes';
import type { Side } from '../workspace/splitModel';
import { framesNear } from './detOverlay';
import { northTick, viewClickYawRad } from './placeModel';
import {
  placeSession,
  placeUi,
  usePlacedWalk,
  useWalkViewHeadingAt,
  walkColour,
} from './placeWalk';
import { PlaceWalkHere } from './PlaceWalkStrip';
import {
  APART_M,
  detourBands,
  endWalkCompare,
  ensureWalkCompare,
  followerSeek,
  followStep,
  inBand,
  leadClock,
  leadClockOf,
  leadTimeAt,
  linkedYawDeg,
  lookBearingDeg,
  moveLeadTo,
  otherSide,
  pairFollower,
  placeRate,
  relookDeg,
  speedAt,
  trackOf,
  useWalkCompare,
  walkCompare,
  type Band,
  type CompareMode,
  type TrackPt,
} from './walkCompare';
import './walkCompare.css';
import {
  beamHalfRad,
  clearWalkView,
  fanPoints,
  headingFromBearingDeg,
  horizontalFov,
  setWalkView,
  shiftBearingDeg,
  shiftHeadingRad,
  walkViewPublisher,
  useWalkView,
} from './walkView';
import {
  formatWalkTime,
  levelOn,
  pickWalk,
  playbackRef,
  walkKeyAction,
  walkUnstabilised,
} from './walkModel';
import { WalkDetOverlay, type OverlayBox } from './WalkDetOverlay';
import { useWalks, walks } from './walks';
import { walkFolderId, walkRecordKey } from './walkStore';

/** Where the view starts: along the picture centre, level, at the panorama viewer's zoom. */
const START: PanoLook = { yawDeg: 0, pitchDeg: 0, fovDeg: PANO_FOV.start };

type Status = 'loading' | 'ready' | 'error' | 'no-graphics';

/** Presses inside this many screen pixels are a click (Align view), not a drag. */
const CLICK_PX = 4;

/** Frame steps before main has listed the walk's record (its real rate comes with it). */
const DEFAULT_FPS = 30;

/** How often (ms) the follower checks its pace against the lead's clock. */
const FOLLOW_MS = 100;

const NO_BANDS: readonly Band[] = [];

/** What a player does in a two-walk compare. */
interface CompareRole {
  side: Side;
  role: 'lead' | 'follow';
  /** The other pane's walk. */
  other: WalkLayer;
  /** The survey date of the other walk, as the bar names it. */
  otherDate: string;
  mode: CompareMode;
  linkLook: boolean;
  /** This pane's look leads while linked (the pane under the pointer). */
  driver: boolean;
  /** This walk was seeked into a detour and plays on its own. */
  solo: boolean;
  /** This walk's track and the other's, in the scene (empty while not placed). */
  own: readonly TrackPt[];
  otherTrack: readonly TrackPt[];
  /** The stretches of this walk where the other has no frame near (shaded on the scrubber). */
  bands: readonly Band[];
}

/**
 * The look-around player of one walk: its equirectangular playback copy on the inside of a
 * sphere. Drag to look, wheel to zoom, the bar below plays and scrubs. It has its own clock: a
 * walk has no place on the project timeline yet.
 */
function WalkPlayer({
  projectId,
  walk,
  record,
  src,
  levelled,
  level,
  compare,
}: {
  /** Set while the split compares two walks. */
  compare?: CompareRole | undefined;
  projectId: string;
  walk: WalkLayer;
  /** The walk's `walk.json` as main listed it (frame rate, sound); absent until it answers. */
  record: WalkFile | undefined;
  /** The video to play (`playbackRef`): the levelled copy or the playback copy. */
  src: AssetRef;
  /** The walk has a levelled copy: the bar offers **Level horizon**. */
  levelled: boolean;
  level: boolean;
}) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const view = useRef<PanoVideoView | null>(null);
  const look = useRef<PanoLook>(START);
  const drag = useRef<{ x: number; y: number; x0: number; y0: number } | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [shown, setShown] = useState<PanoLook>(START);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(walk.durationS);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [sound, setSound] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // where the other copy stopped when Level horizon switched copies: the new one goes on there
  const resume = useRef<{ time: number; play: boolean } | null>(null);
  const srcKey = 'path' in src ? src.path : `hash:${src.hash}`;
  const url = assetUrl(projectId, src);
  // Place walk: the session follows this player's time, seeks it, and takes Align view clicks
  const aiming = useStore(placeSession, (s) => s.layerId === walk.id && s.armed === 'align-360');
  const seekReq = useStore(placeUi, (s) => (s.layerId === walk.id ? s.seek : null));
  const headingAt = useWalkViewHeadingAt(walk);
  const heading = headingAt(time);
  // the line-up of this walk's date and the other's: a turned date turns the look and north
  const ownShift = useDateShift(walk.id);
  const otherShift = useDateShift(compare?.other.id ?? null);
  const audio = record?.video.audio ?? false;
  // a seek asked while the video still seeks waits for it (a follower may seek again)
  const pendingSeek = useRef<number | null>(null);
  // play or pause, for the lead's answer to the follower's play button (set every render)
  const toggleRef = useRef<(play: boolean) => void>(() => undefined);
  // the pane under the pointer (or the one dragged, zoomed) leads the linked look
  const userLook = useRef<() => void>(() => undefined);
  // the lead tells the follower where it is on every change of its video's clock; a video waiting
  // for data (a stall) does not play, so the follower holds with it
  const isLead = useRef(false);
  const waiting = useRef(false);
  useEffect(() => {
    isLead.current = compare?.role === 'lead';
    userLook.current = () => {
      if (compare?.linkLook && !compare.driver) walkCompare.setState({ driver: compare.side });
    };
  });
  const poster = walk.poster ? assetUrl(projectId, walk.poster) : undefined;
  // detections on this walk's frames (local detection writes them as drafts for the review)
  const allDetections = useDetections((s) => s.review.detections);
  const { classById } = useTaxonomy();
  const [showDets, setShowDets] = useState(true);
  const walkDets = useMemo(
    () => allDetections.filter((d) => d.source.kind === 'frame' && d.source.layer === walk.id),
    [allDetections, walk.id],
  );
  // the frames the detection passes sampled: a sampled frame that found nothing shows nothing
  const sampled = useDetections((s) => s.sampled[walk.id]);
  const nearDets = useMemo(
    () => framesNear(walkDets, walk.id, time, sampled),
    [walkDets, walk.id, time, sampled],
  );
  const overlayBoxes = useMemo<OverlayBox[]>(
    () => nearDets.map((d) => ({ detection: d, ...detectionLook(d, classById.get(d.classId)) })),
    [nearDets, classById],
  );
  // the boxes are in the playback copy's pixels: the levelled copy is turned and cannot show them
  const onLevelled = levelled && level;

  const setLook = (next: PanoLook) => {
    look.current = next;
    view.current?.setLook(next);
    setShown(next);
  };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    // aio:// answers with CORS headers so WebGL can read the frames
    v.crossOrigin = 'anonymous';
    v.disablePictureInPicture = true;
    v.src = url;
    video.current = v;
    waiting.current = false;
    // the player is made per walk: another copy of the same walk keeps where the person looks

    let pano: PanoVideoView | null = null;
    try {
      pano = createPanoVideoView(el, v, look.current);
      view.current = pano;
    } catch {
      queueMicrotask(() => {
        setStatus('no-graphics');
      });
    }
    const onReady = () => {
      setStatus((s) => (s === 'no-graphics' ? s : 'ready'));
      const at = resume.current;
      if (at) {
        resume.current = null;
        v.currentTime = at.time;
        if (at.play) v.play().catch(() => undefined);
      }
      if (Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
    };
    const publishClock = () => {
      if (!isLead.current) return;
      leadClock.setState({ now: leadClockOf(v, walk.id, performance.now(), waiting.current) });
    };
    const onTime = () => {
      setTime(v.currentTime);
      publishClock();
      const place = placeSession.getState();
      if (place.layerId === walk.id) place.setTime(v.currentTime);
    };
    const onSeeked = () => {
      const next = pendingSeek.current;
      pendingSeek.current = null;
      if (next !== null && Math.abs(next - v.currentTime) > 0.04) v.currentTime = next;
    };
    const onPlay = () => {
      setPlaying(!v.paused && !v.ended);
      publishClock();
    };
    const onError = () => {
      setStatus((s) => (s === 'no-graphics' ? s : 'error'));
    };
    const onRate = () => {
      setRate(v.playbackRate);
      publishClock();
    };
    const onWaiting = () => {
      waiting.current = true;
      publishClock();
    };
    const onPlaying = () => {
      waiting.current = false;
      publishClock();
    };
    v.addEventListener('loadeddata', onReady);
    v.addEventListener('durationchange', onReady);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('seeked', onTime);
    v.addEventListener('seeking', onTime);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPlay);
    v.addEventListener('ended', onPlay);
    v.addEventListener('ratechange', onRate);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('error', onError);

    // the wheel zooms the view and must not scroll the page behind it
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      userLook.current();
      const next = zoomLook(look.current, e.deltaY);
      look.current = next;
      pano?.setLook(next);
      setShown(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    // the view's size places the north tick
    const sized =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            setBox({ w: el.clientWidth, h: el.clientHeight });
          });
    sized?.observe(el);

    return () => {
      sized?.disconnect();
      el.removeEventListener('wheel', onWheel);
      v.removeEventListener('loadeddata', onReady);
      v.removeEventListener('durationchange', onReady);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('seeked', onTime);
      v.removeEventListener('seeking', onTime);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPlay);
      v.removeEventListener('ended', onPlay);
      v.removeEventListener('ratechange', onRate);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('error', onError);
      resume.current = { time: v.currentTime, play: !v.paused && !v.ended };
      pano?.dispose();
      view.current = null;
      video.current = null;
      v.pause();
      v.removeAttribute('src');
      v.load();
    };
  }, [url, walk.id]);

  // where this walk is and where it looks, for its Beam on the map, the drawings and in 3D (once
  // a frame at most while it is dragged): in the walk's own frame, which they turn by its date's
  // line-up (`worldLookDeg` is the compass bearing on screen)
  const headingDeg = heading === null ? null : bearingFromHeadingRad(heading);
  const lookDeg = headingDeg === null ? null : lookBearingDeg(headingDeg, shown.yawDeg);
  const worldLookDeg =
    headingDeg === null ? null : lookBearingDeg(headingDeg, shown.yawDeg, ownShift);
  const publisher = useRef<ReturnType<typeof walkViewPublisher> | null>(null);
  useEffect(() => {
    const pub = walkViewPublisher(walk.id);
    publisher.current = pub;
    return () => {
      publisher.current = null;
      pub.stop();
    };
  }, [walk.id]);
  useEffect(() => {
    publisher.current?.publish({
      t: time,
      lookDeg,
      pitchDeg: shown.pitchDeg,
      fovDeg: shown.fovDeg,
      hfovDeg: horizontalFov(shown.fovDeg, box.w, box.h),
    });
  }, [walk.id, time, lookDeg, shown, box]);

  // the lead: its clock for the follower, from the moment it leads
  const role = compare?.role;
  useEffect(() => {
    const v = video.current;
    if (role !== 'lead' || status !== 'ready' || !v) return;
    leadClock.setState({ now: leadClockOf(v, walk.id, performance.now(), waiting.current) });
  }, [role, status, walk.id]);
  // the follower's play button plays and pauses the lead
  const leadPlay = useWalkCompare((s) => (role === 'lead' ? s.leadPlay : null));
  useEffect(() => {
    if (!leadPlay) return;
    // answered once: a lead that comes later (Swap lead) must not act on it again
    walkCompare.setState({ leadPlay: null });
    toggleRef.current(leadPlay.play);
  }, [leadPlay]);
  // the follower was scrubbed outside a detour: the lead goes to the place nearest its new spot
  const leadSeek = useWalkCompare((s) => (role === 'lead' ? s.leadSeek : null));
  useEffect(() => {
    const v = video.current;
    if (!leadSeek) return;
    walkCompare.setState({ leadSeek: null });
    if (!v) return;
    const end = Number.isFinite(v.duration) ? v.duration : leadSeek.t;
    v.currentTime = Math.max(0, Math.min(end, leadSeek.t));
    setTime(v.currentTime);
  }, [leadSeek]);

  // the follower keeps pace with the lead: the moment nearest the lead's spot (or its second),
  // reached by playing at a matched rate; it seeks only when it drifts too far, and pauses and
  // seeks with the lead. It stops following when it takes the lead (Swap lead) or plays on its own
  // in a detour: then it goes on as it is, at its own rate
  const following = role === 'follow' && compare !== undefined && !compare.solo;
  const own = compare?.own;
  const otherTrack = compare?.otherTrack;
  const otherId = compare?.other.id;
  const mode = compare?.mode ?? 'place';
  const [dist, setDist] = useState<number | null>(null);
  useEffect(() => {
    const v = video.current;
    if (!following || status !== 'ready' || !v || !own || !otherTrack) return;
    let prevT: number | null = null;
    const tick = () => {
      const c = leadClock.getState().now;
      if (!c || c.walk !== otherId) return;
      const leadT = leadTimeAt(c, performance.now());
      const p = pairFollower(otherTrack, own, leadT, mode, prevT);
      prevT = p.t;
      const end = Number.isFinite(v.duration) ? v.duration : duration;
      const target = Math.max(0, Math.min(end, p.t));
      const desiredRate =
        mode === 'place' && p.dist !== null
          ? placeRate(c.rate, speedAt(otherTrack, leadT), speedAt(own, p.t))
          : c.rate;
      const step = followStep({
        targetT: target,
        currentT: v.currentTime,
        desiredRate,
        leadPlaying: c.playing,
      });
      if (step.seekTo !== null) {
        if (v.seeking) pendingSeek.current = step.seekTo;
        else v.currentTime = step.seekTo;
      }
      if (step.rate !== null && Math.abs(v.playbackRate - step.rate) > 0.01)
        v.playbackRate = step.rate;
      if (step.play && v.paused && !v.ended) v.play().catch(() => undefined);
      else if (!step.play && !v.paused) v.pause();
      // the chip moves in tenths of a metre: no render for less
      const shownDist = p.dist === null ? null : Math.round(p.dist * 10) / 10;
      setDist((d) => (d === shownDist ? d : shownDist));
    };
    tick();
    const timer = window.setInterval(tick, FOLLOW_MS);
    return () => {
      window.clearInterval(timer);
      v.playbackRate = 1;
    };
  }, [following, status, own, otherTrack, otherId, mode, duration]);
  // the compare ends: a walk that followed stops where it is (the lead plays on)
  const inCompare = role !== undefined;
  useEffect(() => {
    if (!inCompare) return;
    return () => {
      if (!isLead.current) video.current?.pause();
    };
  }, [inCompare]);

  // a walk playing on its own in a detour joins the compare again where the routes meet
  const solo = compare?.solo === true;
  const bands = compare?.bands;
  const soloSide = compare?.side;
  useEffect(() => {
    if (!solo || !bands || !soloSide || inBand(bands, time)) return;
    walkCompare.getState().rejoin(soloSide, playing);
  }, [solo, bands, soloSide, time, playing]);

  // Link look: this pane looks at the world bearing the steering pane does, turned by this walk's
  // own heading and by both dates' line-up turns
  const driverView = useWalkView(compare?.linkLook && !compare.driver ? compare.other.id : null);
  const driverLook = driverView?.lookDeg ?? null;
  useEffect(() => {
    if (driverView === undefined || driverLook === null || headingDeg === null) return;
    const yaw = linkedYawDeg(shiftBearingDeg(driverLook, otherShift), headingDeg, ownShift);
    const cur = look.current;
    const dy = Math.abs(wrapDeg(yaw - cur.yawDeg + 180) - 180);
    if (
      dy < 0.05 &&
      Math.abs(cur.pitchDeg - driverView.pitchDeg) < 0.05 &&
      Math.abs(cur.fovDeg - driverView.fovDeg) < 0.05
    )
      return;
    setLook({ yawDeg: yaw, pitchDeg: driverView.pitchDeg, fovDeg: driverView.fovDeg });
  }, [driverView, driverLook, headingDeg, ownShift, otherShift]);
  const pairDist = following ? dist : null;
  const apart = pairDist !== null && pairDist >= APART_M;
  // a following walk's play button shows (and works) the lead's playback
  const leadPlaying = useStore(
    leadClock,
    (s) => s.now !== null && s.now.walk === otherId && s.now.playing,
  );
  const playShown = following ? leadPlaying : playing;

  // the review's detections, read once per project (the review screen reads them again)
  useEffect(() => {
    void loadDetections(projectId);
  }, [projectId]);

  // a seek asked by Place walk (the start or end of the walk, a pin's moment)
  useEffect(() => {
    const v = video.current;
    if (!seekReq || !v) return;
    const end = Number.isFinite(v.duration) ? v.duration : seekReq.t;
    v.currentTime = Math.max(0, Math.min(end, seekReq.t));
  }, [seekReq]);

  const toggle = (play: boolean) => {
    const v = video.current;
    if (!v) return;
    if (play) {
      if (v.ended) v.currentTime = 0;
      v.play().catch(() => undefined);
      // the lead plays: a walk playing on its own in a detour follows again
      if (compare?.role === 'lead') walkCompare.getState().leadPlays();
    } else v.pause();
  };
  useEffect(() => {
    toggleRef.current = toggle;
  });

  /** Play or pause as asked: a following walk passes it on to the lead. */
  const userToggle = (play: boolean) => {
    if (following) walkCompare.getState().requestLeadPlay(play);
    else toggle(play);
  };

  const seek = (seconds: number) => {
    const v = video.current;
    if (!v) return;
    const end = Number.isFinite(v.duration) ? v.duration : duration;
    v.currentTime = Math.max(0, Math.min(end, seconds));
    setTime(v.currentTime);
    // a following walk seeked into a detour plays on its own there; anywhere else the lead goes
    // to the place nearest the follower's new spot, so scrubbing either pane moves both
    if (compare?.role !== 'follow') return;
    const c = leadClock.getState().now;
    const r = followerSeek({
      followT: v.currentTime,
      bands: compare.bands,
      solo: compare.solo,
      playing: !v.paused && !v.ended,
      leadTrack: compare.otherTrack,
      followTrack: compare.own,
      mode: compare.mode,
      leadT: c?.walk === compare.other.id ? leadTimeAt(c, performance.now()) : null,
    });
    const cmp = walkCompare.getState();
    if (r.kind === 'solo') cmp.goSolo(compare.side);
    else if (r.kind === 'rejoin') cmp.rejoin(compare.side, true);
    else {
      if (compare.solo) cmp.rejoin(compare.side, false);
      moveLeadTo(walkCompare, r.leadT);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // modified keys are app shortcuts, not the player's
    const v = video.current;
    if (!v || e.altKey || e.ctrlKey || e.metaKey) return;
    const a = walkKeyAction(e.key, {
      playing: !v.paused && !v.ended,
      rate: v.playbackRate,
      fps: record?.video.fps ?? DEFAULT_FPS,
    });
    if (!a) return;
    e.preventDefault();
    // a key the player took goes no further: window listeners that do not look at
    // defaultPrevented (K adds a keyframe in the video annotator) must not act on it too
    e.stopPropagation();
    // a following walk's rate is the lead's pace: the rate keys work on the lead
    if (a.rate !== undefined && !following) v.playbackRate = a.rate;
    if (a.play !== undefined) userToggle(a.play);
    if (a.seekBy !== undefined) seek(v.currentTime + a.seekBy);
  };

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY };
    setDragging(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    if (!from) return;
    userLook.current();
    setLook(
      dragLook(look.current, e.clientX - from.x, e.clientY - from.y, e.currentTarget.clientHeight),
    );
    drag.current = { ...from, x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const from = drag.current;
    drag.current = null;
    setDragging(false);
    // Align view: a click (not a drag) on a landmark gives its direction in the camera frame
    if (!from || !aiming || Math.hypot(e.clientX - from.x0, e.clientY - from.y0) > CLICK_PX) return;
    const r = e.currentTarget.getBoundingClientRect();
    placeSession
      .getState()
      .align360(
        viewClickYawRad(look.current, e.clientX - r.left, e.clientY - r.top, r.width, r.height),
      );
  };
  const onCancel = () => {
    drag.current = null;
    setDragging(false);
  };
  const north =
    heading !== null && status === 'ready' && box.w > 0 && box.h > 0
      ? northTick(shown, heading, box.w, box.h, ownShift)
      : null;

  const message =
    status === 'loading'
      ? t('walk.loading')
      : status === 'error'
        ? t('walk.error')
        : status === 'no-graphics'
          ? t('walk.noGraphics')
          : null;

  return (
    <>
      <div
        ref={host}
        className={`fill-col walk-view${dragging ? ' dragging' : ''}${aiming ? ' aiming' : ''}`}
        data-compare-role={role}
        data-compare-solo={solo ? 'true' : undefined}
        data-pair-dist={pairDist === null ? undefined : pairDist.toFixed(1)}
        tabIndex={0}
        role="application"
        aria-label={t('walk.view', { name: walk.name })}
        data-testid="walk-view"
        data-status={status}
        data-src={srcKey}
        // the poster stands in while the first frame loads
        style={
          poster && status === 'loading'
            ? {
                backgroundImage: `url("${poster}")`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }
            : undefined
        }
        data-yaw={shown.yawDeg.toFixed(1)}
        data-pitch={shown.pitchDeg.toFixed(1)}
        data-fov={shown.fovDeg.toFixed(1)}
        onKeyDown={onKey}
        onPointerEnter={() => {
          userLook.current();
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
      >
        {north && (
          <span
            className={north.edge === 'in' ? 'walk-north' : 'walk-north edge'}
            data-testid="walk-north"
            title="North"
            style={{ left: `clamp(8px, ${(north.x * 100).toFixed(2)}%, calc(100% - 8px))` }}
          >
            N
          </span>
        )}
        {walkDets.length > 0 &&
          showDets &&
          status === 'ready' &&
          !onLevelled &&
          box.w > 0 &&
          box.h > 0 && (
            <WalkDetOverlay boxes={overlayBoxes} look={shown} width={box.w} height={box.h} />
          )}
        {walkDets.length > 0 && showDets && status === 'ready' && onLevelled && (
          <div className="walk-det-note" role="note" data-testid="walk-det-level-note">
            {t('walk.det.levelNote')}
          </div>
        )}
        {message && (
          <div className="walk-status" role="status">
            {message}
          </div>
        )}
        {pairDist !== null && status === 'ready' && (
          <div
            className={apart ? 'walk-dist-chip apart' : 'walk-dist-chip'}
            role="status"
            data-testid="walk-compare-dist"
            data-apart={apart ? 'true' : undefined}
          >
            {apart && <span className="walk-dist-dot" aria-hidden="true" />}
            {apart
              ? t('walk.compare.apart', { m: pairDist.toFixed(0) })
              : t('walk.compare.near', { m: pairDist.toFixed(1) })}
          </div>
        )}
        {compare && role === 'lead' && status === 'ready' && (
          <CompareInset
            a={walk}
            b={compare.other}
            aTrack={compare.own}
            bTrack={compare.otherTrack}
          />
        )}
      </div>
      <div className="pane-bar walk-bar" data-testid="walk-bar" data-time={time.toFixed(2)}>
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="walk-play"
          aria-label={t(playShown ? 'walk.pause' : 'walk.play')}
          title={`${t(playShown ? 'walk.pause' : 'walk.play')} (Space)`}
          disabled={status !== 'ready'}
          onClick={() => {
            userToggle(!playShown);
          }}
        >
          <Icon name={playShown ? 'pause' : 'play'} size={14} />
        </button>
        <span className="mono" data-testid="walk-time">
          {t('walk.time', { now: formatWalkTime(time), total: formatWalkTime(duration) })}
        </span>
        <span className="walk-scrub">
          {compare && compare.bands.length > 0 && duration > 0 && (
            <span className="walk-detours" aria-hidden="true" data-testid="walk-compare-detours">
              {compare.bands.map((b) => (
                <span
                  key={b.fromT}
                  className="walk-detour"
                  style={{
                    left: `${String(Math.min(100, (b.fromT / duration) * 100))}%`,
                    width: `${String(Math.max(0.6, ((b.toT - b.fromT) / duration) * 100))}%`,
                  }}
                />
              ))}
            </span>
          )}
          <input
            type="range"
            min={0}
            max={Math.max(0.01, duration)}
            step={0.01}
            value={Math.min(time, duration)}
            aria-label={t('walk.scrub')}
            aria-valuetext={t('walk.time.spoken', {
              now: formatWalkTime(time),
              total: formatWalkTime(duration),
            })}
            aria-description={
              compare && compare.bands.length > 0
                ? t('walk.compare.detours', { date: compare.otherDate })
                : undefined
            }
            data-testid="walk-scrub"
            disabled={status !== 'ready'}
            onChange={(e) => {
              seek(Number(e.target.value));
            }}
          />
        </span>
        {rate !== 1 && !following && (
          <span className="mono faint" data-testid="walk-rate">
            {String(rate)}x
          </span>
        )}
        <span className="grow" />
        {walkDets.length > 0 && (
          <button
            type="button"
            className="btn sm ghost"
            data-testid="walk-det-toggle"
            aria-pressed={showDets}
            onClick={() => {
              setShowDets(!showDets);
            }}
          >
            {t('walk.det.show')}
          </button>
        )}
        {levelled && (
          <button
            type="button"
            className="btn sm ghost"
            data-testid="walk-level"
            aria-pressed={level}
            title={t('walk.level.tip')}
            onClick={() => {
              walks.getState().setLevel(walk.id, !level);
            }}
          >
            {t('walk.level')}
          </button>
        )}
        <button
          type="button"
          className="btn sm ghost"
          data-testid="walk-sound"
          aria-pressed={sound}
          disabled={!audio}
          title={audio ? undefined : t('walk.sound.none')}
          onClick={() => {
            const v = video.current;
            if (!v) return;
            v.muted = sound;
            setSound(!sound);
          }}
        >
          {t('walk.sound')}
        </button>
        <SpotHistoryButton
          open={{
            item: { kind: 'walk', layer: walk.id, t: time },
            // the compass bearing of the look, as the lined-up date draws it; none while the walk
            // is not placed
            ...(worldLookDeg !== null ? { lookDeg: worldLookDeg } : {}),
          }}
        />
        <button
          type="button"
          className="btn icon sm ghost"
          data-testid="walk-reset"
          aria-label={t('walk.resetView')}
          title={t('walk.resetView')}
          onClick={() => {
            setLook(START);
          }}
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
    </>
  );
}

/** The walks the two 360 panes show while both sides of the split show 360 video. */
function compareWalks(
  list: readonly WalkLayer[],
  selected: string | null,
  cmp: { left: string | null; right: string | null },
): { left: WalkLayer | undefined; right: WalkLayer | undefined } {
  const byId = (id: string | null) => (id === null ? undefined : list.find((w) => w.id === id));
  const left = byId(cmp.left) ?? pickWalk(list, selected);
  // never one walk on both sides while there is another
  const right =
    (cmp.right !== left?.id ? byId(cmp.right) : undefined) ??
    list.find((w) => w.id !== left?.id) ??
    left;
  return { left, right };
}

/** The line-up shift of walk `layerId`'s survey date (null without one, or with no walk). */
function useDateShift(layerId: string | null): DateShift | null {
  const manifest = useWorkspace((s) => s.project?.manifest);
  return useMemo(
    () => (manifest && layerId !== null ? dateShiftOf(manifest, layerId) : null),
    [manifest, layerId],
  );
}

const NO_TRACK: readonly TrackPt[] = [];

/** The detours of track `own` from `other` (none while either is not placed), made once per pair. */
function useDetours(own: readonly TrackPt[], other: readonly TrackPt[]): readonly Band[] {
  return useMemo(
    () => (own.length === 0 || other.length === 0 ? NO_BANDS : detourBands(own, other)),
    [own, other],
  );
}

/**
 * A placed walk's track in the scene (empty while it is not placed), one sample every 0.25 s: the
 * same track while its fit is (an edit elsewhere in the project does not jolt the follower).
 */
function useTrack(layerId: string | null): readonly TrackPt[] {
  const placed = usePlacedWalk(layerId);
  const fit = placed?.fit;
  const durationS = placed?.layer.durationS;
  const shift = placed?.shift ?? null;
  return useMemo(
    () => (fit && durationS !== undefined ? trackOf(fit, durationS, shift) : NO_TRACK),
    [fit, durationS, shift],
  );
}

/**
 * A corner map in the lead pane: both walks' tracks in their date colours, each with its spot and
 * view cone, north up.
 */
function CompareInset({
  a,
  b,
  aTrack,
  bTrack,
}: {
  a: WalkLayer;
  b: WalkLayer;
  aTrack: readonly TrackPt[];
  bTrack: readonly TrackPt[];
}) {
  const manifest = useWorkspace((s) => s.project?.manifest);
  const pa = usePlacedWalk(a.id);
  const pb = usePlacedWalk(b.id);
  const va = useWalkView(a.id);
  const vb = useWalkView(b.id);
  const frame = useMemo(() => {
    const tracks = [aTrack, bTrack];
    const all = [...aTrack, ...bTrack];
    if (all.length < 2) return null;
    let [x0, x1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const p of all) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      z0 = Math.min(z0, p.z);
      z1 = Math.max(z1, p.z);
    }
    const span = Math.max(x1 - x0, z1 - z0, 10);
    const pad = span * 0.18;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const lines = tracks.map((tr) =>
      tr
        .filter((_, i) => i % 2 === 0)
        .map((p) => `${p.x.toFixed(2)},${p.z.toFixed(2)}`)
        .join(' '),
    );
    return {
      box: `${String(cx - span / 2 - pad)} ${String(cz - span / 2 - pad)} ${String(span + 2 * pad)} ${String(span + 2 * pad)}`,
      span,
      lines,
    };
  }, [aTrack, bTrack]);
  if (!manifest || !frame) return null;
  const { span, box, lines } = frame;
  const px = span / 120; // about one screen pixel in metres at the inset's size
  const items = [
    { w: pa, v: va, line: lines[0] ?? '' },
    { w: pb, v: vb, line: lines[1] ?? '' },
  ];
  return (
    <svg className="walk-inset" viewBox={box} aria-hidden="true" data-testid="walk-compare-inset">
      {items.map(({ w, line }) =>
        w ? (
          <polyline
            key={`t-${w.layer.id}`}
            points={line}
            fill="none"
            stroke={walkColour(manifest, w.layer)}
            strokeWidth={px * 2}
            strokeLinejoin="round"
          />
        ) : null,
      )}
      {items.map(({ w, v }) => {
        if (!w || !v) return null;
        const at = w.fit.at(v.t);
        if (!at) return null;
        const p = shiftLocal([at.xz[0], 0, at.xz[1]], w.shift ?? null);
        const c = walkColour(manifest, w.layer);
        const fan =
          v.lookDeg === null
            ? null
            : fanPoints(
                [p[0], p[2]],
                shiftHeadingRad(headingFromBearingDeg(v.lookDeg), w.shift),
                beamHalfRad(v.hfovDeg),
                span * 0.16,
              );
        return (
          <g key={`m-${w.layer.id}`}>
            {fan && (
              <polygon
                points={fan.map((q) => `${q[0].toFixed(2)},${q[1].toFixed(2)}`).join(' ')}
                fill={c}
                fillOpacity={0.35}
              />
            )}
            <circle
              cx={p[0]}
              cy={p[2]}
              r={px * 4}
              fill={c}
              stroke="var(--fg-0)"
              strokeWidth={px * 1.5}
            />
          </g>
        );
      })}
    </svg>
  );
}

/** The compare row under a 360 pane's header: its role, and the lead's controls. */
function CompareBar({
  side,
  walk,
  date,
  otherDate,
  ghost,
}: {
  side: Side;
  walk: WalkLayer;
  date: string;
  otherDate: string;
  /** Only this pane shows a walk of the pair: the other one follows on the map and in 3D. */
  ghost?: boolean;
}) {
  const t = useT();
  const manifest = useWorkspace((s) => s.project?.manifest);
  const lead = useWalkCompare((s) => s.lead === side) || ghost === true;
  const solo = useWalkCompare((s) => s.solo === side) && !lead;
  const mode = useWalkCompare((s) => s.mode);
  const linkLook = useWalkCompare((s) => s.linkLook);
  return (
    <div className="pane-bar walk-compare-bar" data-testid={`walk-compare-bar-${side}`}>
      <span className="walk-compare-date">
        <span
          className="dtag"
          style={{ background: manifest ? walkColour(manifest, walk) : undefined }}
          aria-hidden="true"
        />
        {date}
      </span>
      {solo ? (
        <Tip content={t('walk.compare.soloTip', { date: otherDate })}>
          <span className="walk-role" data-testid="walk-compare-role" tabIndex={0}>
            {t('walk.compare.solo')}
          </span>
        </Tip>
      ) : (
        <span className={lead ? 'walk-role lead' : 'walk-role'} data-testid="walk-compare-role">
          {lead
            ? t('walk.compare.lead')
            : t(mode === 'place' ? 'walk.compare.followsPlace' : 'walk.compare.followsTime')}
        </span>
      )}
      {ghost && (
        <span className="walk-role" data-testid="walk-compare-solo">
          {t('walk.compare.onMap', { date: otherDate })}
        </span>
      )}
      <span className="grow" />
      {lead && (
        <>
          <span className="walk-seg" role="group" aria-label={t('walk.compare.follow')}>
            {(['place', 'time'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className="btn sm ghost"
                aria-pressed={mode === m}
                data-testid={`walk-compare-${m}`}
                onClick={() => {
                  walkCompare.setState({ mode: m });
                }}
              >
                {t(m === 'place' ? 'walk.compare.byPlace' : 'walk.compare.byTime')}
              </button>
            ))}
          </span>
          <Tip content={t('walk.compare.linkTip')}>
            <button
              type="button"
              className="btn sm ghost"
              aria-pressed={linkLook}
              data-testid="walk-compare-link"
              onClick={() => {
                walkCompare.setState({ linkLook: !linkLook, driver: side });
              }}
            >
              <Icon name="link" size={14} />
              {t('walk.compare.link')}
            </button>
          </Tip>
          {!ghost && (
            <Tip content={t('walk.compare.swapTip')}>
              <button
                type="button"
                className="btn sm ghost"
                data-testid="walk-compare-swap"
                onClick={() => {
                  walkCompare.getState().swapLead();
                }}
              >
                <Icon name="loop" size={14} />
                {t('walk.compare.swap')}
              </button>
            </Tip>
          )}
          <Tip content={t('walk.compare.end')} repeatsName>
            <button
              type="button"
              className="btn icon sm ghost"
              data-testid="walk-compare-end"
              aria-label={t('walk.compare.end')}
              onClick={endWalkCompare}
            >
              <Icon name="x" size={14} />
            </button>
          </Tip>
        </>
      )}
    </div>
  );
}

/**
 * The walk of the pair no pane shows still follows the one that plays, unseen, so the map and the
 * 3D view show both spots and both cones (the split shows the map beside one 360 pane).
 */
function GhostFollower({ lead, follow }: { lead: WalkLayer; follow: WalkLayer }) {
  const leadView = useWalkView(lead.id);
  const leadTrack = useTrack(lead.id);
  const followTrack = useTrack(follow.id);
  const mode = useWalkCompare((s) => s.mode);
  const linkLook = useWalkCompare((s) => s.linkLook);
  const headingAt = useWalkViewHeadingAt(follow);
  const leadShift = useDateShift(lead.id);
  const followShift = useDateShift(follow.id);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    if (!leadView) return;
    const p = pairFollower(leadTrack, followTrack, leadView.t, mode, prev.current);
    prev.current = p.t;
    const h = headingAt(p.t);
    // linked, it looks at the lead's world bearing (each date's line-up turn undone)
    const linked =
      leadView.lookDeg === null ? null : relookDeg(leadView.lookDeg, leadShift, followShift);
    setWalkView(follow.id, {
      t: p.t,
      lookDeg: linkLook ? linked : h === null ? null : bearingFromHeadingRad(h),
      pitchDeg: leadView.pitchDeg,
      fovDeg: leadView.fovDeg,
      hfovDeg: leadView.hfovDeg,
    });
  }, [
    leadView,
    leadTrack,
    followTrack,
    mode,
    linkLook,
    headingAt,
    follow.id,
    leadShift,
    followShift,
  ]);
  useEffect(
    () => () => {
      clearWalkView(follow.id);
    },
    [follow.id],
  );
  return null;
}

/** The split pane: the chosen walk (or the first), with a chooser when there are several. */
export function Walk360Pane({ side, split }: { side?: Side; split?: SplitModel } = {}) {
  const t = useT();
  const projectId = useWorkspace((s) => s.project?.id);
  const list = useWalks((s) => s.walks);
  const selected = useWalks((s) => s.selected);
  const records = useWalks((s) => s.records);
  // both sides on 360 video compare two walks
  const comparing =
    side !== undefined && split?.sides.left === 'walk360' && split.sides.right === 'walk360';
  const cmpLeft = useWalkCompare((s) => s.left);
  const cmpRight = useWalkCompare((s) => s.right);
  const lead = useWalkCompare((s) => s.lead);
  const mode = useWalkCompare((s) => s.mode);
  const linkLook = useWalkCompare((s) => s.linkLook);
  const driver = useWalkCompare((s) => s.driver);
  const solo = useWalkCompare((s) => s.solo);
  const active = useWalkCompare((s) => s.active);
  const index = useCaptureIndex();
  const pair = comparing ? compareWalks(list, selected, { left: cmpLeft, right: cmpRight }) : null;
  const walk = pair && side ? pair[side] : pickWalk(list, selected);
  const other = pair && side ? pair[otherSide(side)] : undefined;
  const otherId = other && other.id !== walk?.id ? other.id : null;
  // the two panes show two walks: that is a compare (both show on the map and in 3D)
  const leftId = pair?.left?.id;
  const rightId = pair?.right?.id;
  useEffect(() => {
    if (side === 'left' && leftId && rightId && leftId !== rightId)
      ensureWalkCompare(leftId, rightId);
  }, [side, leftId, rightId]);
  const own = useTrack(otherId === null ? null : (walk?.id ?? null));
  const otherTrack = useTrack(otherId);
  const bands = useDetours(own, otherTrack);
  const processed = useWalks((s) => (walk ? s.processed[walkFolderId(walk)] : undefined));
  const level = useWalks((s) => (walk ? levelOn(s.level, walk.id) : true));
  if (!projectId || !walk) return <p className="pane-empty">{t('walk.none')}</p>;
  const record = records[walkRecordKey(walk)];
  const levelled = processed?.stabilized !== undefined;
  const dateOf = (w: WalkLayer) => (index ? captureLabel(index, index.of[w.id]) || w.name : w.name);
  const compare: CompareRole | undefined =
    comparing && other && otherId !== null
      ? {
          side,
          role: lead === side ? 'lead' : 'follow',
          other,
          otherDate: dateOf(other),
          mode,
          linkLook,
          driver: driver === side,
          solo: solo === side && lead !== side,
          own,
          otherTrack,
          bands,
        }
      : undefined;
  // one pane shows a walk of a running compare: the other follows it unseen (map, 3D)
  const ghostId =
    !comparing && active && (cmpLeft === walk.id || cmpRight === walk.id)
      ? cmpLeft === walk.id
        ? cmpRight
        : cmpLeft
      : null;
  const ghost =
    ghostId === null ? undefined : list.find((w) => w.id === ghostId && w.id !== walk.id);
  return (
    <div
      className="pane-col"
      data-testid="walk-360"
      data-walk={walkFolderId(walk)}
      data-side={comparing ? side : undefined}
    >
      <div className="pane-bar">
        <Icon name="pano" size={14} className="muted" />
        {list.length > 1 ? (
          <select
            className="input"
            aria-label={t('walk.which')}
            data-testid="walk-which"
            value={walk.id}
            onChange={(e) => {
              const id = e.target.value;
              if (!comparing) {
                walks.getState().select(id);
                return;
              }
              // the walk the other pane shows: the two swap sides (one walk never shows twice)
              const swap = other?.id === id && other.id !== walk.id;
              walkCompare.setState({
                [side]: id,
                ...(swap ? { [otherSide(side)]: walk.id } : {}),
                solo: null,
              });
            }}
          >
            {list.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="walk-name">{walk.name}</span>
        )}
        {record?.source.lowRes && <span className="faint">{t('walk.lowRes')}</span>}
        {record && walkUnstabilised(record) && !(level && levelled) && (
          <span className="faint" title={t('walk.rawHint')} data-testid="walk-unstabilised">
            {t('walk.unstabilised')}
          </span>
        )}
      </div>
      {compare && side && (
        <CompareBar side={side} walk={walk} date={dateOf(walk)} otherDate={compare.otherDate} />
      )}
      {ghost && (
        <>
          <CompareBar
            side={side ?? 'right'}
            walk={walk}
            date={dateOf(walk)}
            otherDate={dateOf(ghost)}
            ghost
          />
          <GhostFollower lead={walk} follow={ghost} />
        </>
      )}
      <PlaceWalkHere at="walk" />
      <WalkPlayer
        key={walk.id}
        projectId={projectId}
        walk={walk}
        record={record}
        src={playbackRef(walk, processed, level)}
        levelled={levelled}
        level={level}
        compare={compare}
      />
    </div>
  );
}
