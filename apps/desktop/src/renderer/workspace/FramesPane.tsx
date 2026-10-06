import type { Layer } from '@aio/schema';
import { Icon, useT } from '@aio/ui';
import {
  FrameImage,
  FramesCompare,
  calibratedVideoPose,
  createViewFollower,
  groundHomography,
  loadFlight,
  matchScore,
  photoPose,
  videoTimeForClock,
  videoTimeS,
  viewSources,
  type Flight,
  type FramesMode,
  type ViewPose,
} from '@aio/video';
import { assetUrl, canCompare, captureIndex, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { ensureFramesProducer } from '../change/producers/frames';
import { dropEvidence } from '../issueCard/evidence';
import { jobs, shell } from '../shell';
import { captureLabel, useCaptureIndex } from './compare';
import {
  frameTime,
  framesState,
  layerCapture,
  otherCapture,
  pickSource,
  splitWithFrames,
  stepPhoto,
  type FramesSource,
} from './framesModel';
import { paneOptions, resolveSplit } from './splitModel';
import { stagePrefs } from './stagePrefs';

/**
 * The Frames pane (M8 C4, FUS-4): the frame of the playing clip, or a photo, of one survey date
 * beside the same view on another date, found by camera pose (`@aio/video` pairing). Side by side,
 * swipe or blend, with the other frame optionally lined up by the ground plane. Scrubbing the clip
 * moves the other date with it. The other date's clip shows a paused frame, never a second
 * playback.
 */

type VideoLayer = Extract<Layer, { kind: 'video' }>;
type PhotoLayer = Extract<Layer, { kind: 'photos' }>;

// "Find changes in matched frames" in the Changes panel (C1 lists registered producers)
ensureFramesProducer({
  root: (id) => {
    const p = workspace.getState().project;
    return p?.id === id ? p.root : undefined;
  },
  start: async (req) => {
    const error = await jobs.getState().start(req);
    if (error) return { ok: false, error };
    const id = jobs.getState().selected;
    return id ? { ok: true, jobId: id } : { ok: true };
  },
});

/** Open the Frames pane on `source` (from the video window or a photo). */
export function openSameView(source: FramesSource): void {
  const ws = workspace.getState();
  const project = ws.project;
  if (!project) return;
  framesState.getState().setSource(source);
  if (source.kind === 'video') {
    const layer = project.manifest.layers.find((l) => l.id === source.layer);
    if (layer?.kind === 'video') {
      ws.setActiveClip(layer.id);
      const start = layer.flight.startUtcMs + layer.offsetMs;
      if (ws.nowMs < start) ws.setTime(start);
    }
  }
  dropEvidence();
  const index = captureIndex(project.manifest);
  const dated = index.captures.filter((c) => (index.layers[c.id]?.length ?? 0) > 0).length;
  const saved = stagePrefs.getState().byProject[project.id]?.split;
  const sides = resolveSplit(saved, paneOptions(project.manifest.layers, 1, dated));
  stagePrefs.getState().update(project.id, { split: splitWithFrames(sides) });
  const sh = shell.getState();
  if (sh.stageMode !== 'split') sh.setStageMode('split');
}

/** "Same view on the other date" for a clip or a photo; shown when the project has two dates. */
export function SameViewButton({ source }: { source: FramesSource }) {
  const t = useT();
  const index = useCaptureIndex();
  if (!index || !canCompare(index)) return null;
  return (
    <button
      type="button"
      className="btn icon sm ghost"
      data-testid="same-view"
      aria-label={t('frames.sameView')}
      title={t('frames.sameView')}
      onClick={() => {
        openSameView(source);
      }}
    >
      <Icon name="history" size={14} />
    </button>
  );
}

/** Parsed flight logs of these clips, once all have loaded (null while reading). */
function useFlights(
  projectId: string | null,
  clips: readonly VideoLayer[],
): ReadonlyMap<string, Flight> | null {
  const key = clips.map((l) => `${l.id}=${JSON.stringify(l.flight.src)}`).join('|');
  const [state, setState] = useState<{ key: string; map: Map<string, Flight> } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    void Promise.allSettled(
      clips.map(async (l) => [l.id, await loadFlight(assetUrl(projectId, l.flight.src))] as const),
    ).then((rs) => {
      if (!live) return;
      const map = new Map<string, Flight>();
      for (const r of rs) if (r.status === 'fulfilled') map.set(r.value[0], r.value[1]);
      setState({ key, map });
    });
    return () => {
      live = false;
    };
  }, [projectId, clips, key]);
  return state?.key === key ? state.map : null;
}

const MODES: {
  mode: FramesMode;
  label: 'frames.mode.side' | 'frames.mode.swipe' | 'frames.mode.blend';
}[] = [
  { mode: 'side', label: 'frames.mode.side' },
  { mode: 'swipe', label: 'frames.mode.swipe' },
  { mode: 'blend', label: 'frames.mode.blend' },
];

function Message({ text }: { text: string }) {
  return (
    <p className="pane-empty" data-testid="frames-message">
      {text}
    </p>
  );
}

export function FramesPane() {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const selection = useWorkspace((s) => s.selection);
  const activeClip = useWorkspace((s) => s.activeClip);
  const nowMs = useWorkspace((s) => s.nowMs);
  const index = useCaptureIndex();
  const prefs = useStore(framesState);
  const layers = useMemo(() => project?.manifest.layers ?? [], [project]);
  const chosen = prefs.source;
  const other = prefs.other;

  // which view of which date, and the other date's clips (memoized on stable inputs only)
  const pick = useMemo(() => {
    const source = pickSource(layers, chosen, selection, activeClip);
    const aLayer = source ? layers.find((l) => l.id === source.layer) : undefined;
    const aCapture = aLayer && index ? layerCapture(aLayer, index) : undefined;
    const bCapture = index && aCapture ? otherCapture(index, aCapture, other) : undefined;
    const of: Record<string, string> = {};
    if (index)
      for (const l of layers) {
        const c = layerCapture(l, index);
        if (c) of[l.id] = c;
      }
    const clips = layers.filter(
      (l): l is VideoLayer => l.kind === 'video' && (l.id === aLayer?.id || of[l.id] === bCapture),
    );
    return { source, aLayer, aCapture, bCapture, of, clips };
  }, [layers, chosen, selection, activeClip, index, other]);
  const { source, aLayer, aCapture, bCapture } = pick;
  const flights = useFlights(project?.id ?? null, pick.clips);

  const follow = useMemo(
    () =>
      createViewFollower(
        pick.bCapture && flights ? viewSources(layers, pick.bCapture, pick.of, flights) : [],
      ),
    [layers, pick, flights],
  );

  if (!project || !index) return null;
  const dated = index.captures.filter((c) => (index.layers[c.id]?.length ?? 0) > 0).length;
  if (dated < 2) return <Message text={t('frames.oneDate')} />;
  if (!source || !aLayer) return <Message text={t('frames.noSource')} />;
  if (!aCapture || !bCapture) return <Message text={t('frames.noDate')} />;

  // the view of date A
  let poseA: ViewPose | null = null;
  let aUrl = '';
  let aTime: number | undefined;
  let aText = '';
  let aSet: PhotoLayer | null = null;
  if (aLayer.kind === 'video') {
    const flight = flights?.get(aLayer.id);
    aUrl = assetUrl(project.id, aLayer.src);
    if (flight) {
      const last = flight.samples.at(-1);
      const vMax = last ? Math.max(0, videoTimeS(aLayer, flight, last.t)) : 0;
      const raw = videoTimeForClock(
        { startUtcMs: aLayer.flight.startUtcMs, offsetMs: aLayer.offsetMs, durationS: NaN },
        nowMs,
      );
      aTime = frameTime(Math.min(vMax, Math.max(0, raw)));
      poseA = calibratedVideoPose(aLayer, flight, aTime);
      aText = t('frames.atTime', { time: aTime.toFixed(1) });
    }
  } else if (aLayer.kind === 'photos' && source.kind === 'photo') {
    aSet = aLayer;
    const item = aLayer.items.find((p) => p.id === source.photo);
    if (item) {
      aUrl = assetUrl(project.id, item.src);
      poseA = photoPose(item);
      aText = item.id;
    }
  }
  const reading = aLayer.kind === 'video' && !flights;
  const match = poseA && flights ? follow(poseA) : null;
  const warp = prefs.warp && match && poseA ? groundHomography(match.pose, poseA) : null;

  // the view of date B
  let bNode = null;
  if (match) {
    const bLayer = layers.find((l) => l.id === match.ref.layer);
    if (bLayer?.kind === 'video')
      bNode = (
        <FrameImage
          key={bLayer.id}
          kind="video"
          src={assetUrl(project.id, bLayer.src)}
          t={match.ref.t ?? 0}
          missing={t('frames.missing')}
        />
      );
    else if (bLayer?.kind === 'photos') {
      const item = bLayer.items.find((p) => p.id === match.ref.photo);
      if (item)
        bNode = (
          <FrameImage
            key={`${bLayer.id}/${item.id}`}
            kind="photo"
            src={assetUrl(project.id, item.src)}
            missing={t('frames.missing')}
            alt={item.id}
          />
        );
    }
  }
  const aNode = aUrl ? (
    <FrameImage
      key={aUrl}
      kind={aLayer.kind === 'video' ? 'video' : 'photo'}
      src={aUrl}
      {...(aTime !== undefined ? { t: aTime } : {})}
      missing={t('frames.missing')}
      alt={aText}
    />
  ) : null;
  const aspect = aLayer.kind === 'video' ? aLayer.lens.aspect : (poseA?.lens.aspect ?? 1.5);
  const bDate = captureLabel(index, bCapture);
  const step = (dir: 1 | -1) => {
    if (!aSet || source.kind !== 'photo') return;
    const next = stepPhoto(aSet, source.photo, dir);
    if (next) framesState.getState().setSource({ kind: 'photo', layer: aSet.id, photo: next });
  };
  const score = match ? matchScore(match) : null;

  return (
    <div className="pane-col" data-testid="frames-pane">
      <div className="pane-bar">
        {aSet && (
          <button
            type="button"
            className="btn icon sm ghost"
            aria-label={t('frames.prevPhoto')}
            title={t('frames.prevPhoto')}
            onClick={() => {
              step(-1);
            }}
          >
            <Icon name="back" size={14} />
          </button>
        )}
        <span className="mono" data-testid="frames-a-label">
          {aText || aLayer.name}
        </span>
        {aSet && (
          <button
            type="button"
            className="btn icon sm ghost"
            aria-label={t('frames.nextPhoto')}
            title={t('frames.nextPhoto')}
            onClick={() => {
              step(1);
            }}
          >
            <Icon name="fwd" size={14} />
          </button>
        )}
        {index.captures.length > 2 && (
          <select
            className="input"
            data-testid="frames-other-date"
            aria-label={t('frames.otherDate')}
            title={t('frames.otherDate')}
            value={bCapture}
            onChange={(e) => {
              framesState.getState().setOther(e.target.value);
            }}
          >
            {index.captures
              .filter((c) => c.id !== aCapture)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {captureLabel(index, c.id)}
                </option>
              ))}
          </select>
        )}
        <span
          className="mono faint"
          data-testid="frames-score"
          data-layer={match?.ref.layer}
          data-t={match?.ref.t}
          data-photo={match?.ref.photo}
        >
          {score
            ? t('frames.score', score)
            : reading
              ? t('frames.reading')
              : t('frames.noMatch', { date: bDate })}
        </span>
        <span className="grow" />
        <div role="group" aria-label={t('frames.modes')} style={{ display: 'flex', gap: 2 }}>
          {MODES.map((m) => (
            <button
              key={m.mode}
              type="button"
              className="btn sm ghost"
              data-testid={`frames-mode-${m.mode}`}
              aria-pressed={prefs.mode === m.mode}
              onClick={() => {
                framesState.getState().setMode(m.mode);
              }}
            >
              {t(m.label)}
            </button>
          ))}
        </div>
        {prefs.mode === 'blend' && (
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(prefs.amount * 100)}
            aria-label={t('frames.blend')}
            data-testid="frames-blend"
            onChange={(e) => {
              framesState.getState().setAmount(Number(e.target.value) / 100);
            }}
          />
        )}
        {prefs.mode !== 'side' && (
          <button
            type="button"
            className="btn icon sm ghost"
            data-testid="frames-warp"
            aria-pressed={prefs.warp}
            aria-label={t('frames.warp')}
            title={t('frames.warpTip')}
            onClick={() => {
              framesState.getState().setWarp(!prefs.warp);
            }}
          >
            <Icon name="target" size={14} />
          </button>
        )}
      </div>
      <div className="fill-col" style={{ position: 'relative', minHeight: 0 }}>
        {source.kind === 'photo' && !poseA ? (
          <Message text={t('frames.noPose')} />
        ) : (
          <FramesCompare
            a={aNode}
            b={bNode}
            mode={prefs.mode}
            amount={prefs.amount}
            onAmount={(v) => {
              framesState.getState().setAmount(v);
            }}
            aspect={aspect}
            warp={warp}
            labels={{
              a: captureLabel(index, aCapture),
              b: bDate,
              handle: t('frames.handle'),
              empty: reading ? t('frames.reading') : t('frames.noMatch', { date: bDate }),
            }}
          />
        )}
      </div>
    </div>
  );
}
