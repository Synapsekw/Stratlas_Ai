/**
 * The issue card: what a picked issue is and the evidence it is seen on. Code, title, severity,
 * status and class up top; the best photo with the issue's box, outline or mask drawn on it (a
 * click opens it full size), the other photos and video frames below; then zone, recommended
 * action, position and note; the edit form folded at the bottom (never in a package).
 * Previous and next walk the issues in code order (or the order the host passes, such as the
 * filtered road defects).
 */
import {
  IssueDetail,
  focusIssue,
  openSighting,
  severityColor,
  useAnnotateReadOnly,
} from '@aio/annotate';
import { issueLocation } from '@aio/project/export';
import type { Issue } from '@aio/schema';
import {
  crsLabel,
  formatDate,
  formatEastNorth,
  Icon,
  SevChip,
  Switch,
  useT,
  type MessageKey,
} from '@aio/ui';
import { assetUrl, useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { frameImage, type FrameImage } from '../detections/prepare';
import { shell } from '../shell';
import { setEvidenceEnabled, useEvidence } from './evidence';
import { Mark } from './Marks';
import {
  issueEvidence,
  issueFacts,
  issueOrder,
  photoEvidence,
  previewCrop,
  stepIssue,
  type Box4,
  type PhotoEvidence,
  type VideoEvidence,
} from './model';
import { openLightbox } from './state';

export type CardPlace = 'scene' | 'issues' | 'media' | 'road';

const safeUrl = (projectId: string, ref: Parameters<typeof assetUrl>[1] | null) => {
  if (!ref) return null;
  try {
    return assetUrl(projectId, ref);
  } catch {
    return null;
  }
};

/** m:ss.s of a clip. */
export function clipTime(tS: number): string {
  const m = Math.floor(tS / 60);
  const s = tS - m * 60;
  return `${String(m)}:${s.toFixed(1).padStart(4, '0')}`;
}

type Loaded = { url: string; w: number; h: number } | { url: string; failed: true };

/** Natural size of an image (decoded off the main thread), or failed. */
function useImageSize(url: string | null): Loaded | null {
  const [state, setState] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    img.decode().then(
      () => {
        if (live) setState({ url, w: img.naturalWidth, h: img.naturalHeight });
      },
      () => {
        if (live) setState({ url, failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, [url]);
  return state?.url === url ? state : null;
}

/**
 * One photo of the issue with its marks: cropped around the marked region (`crop`) or whole.
 * Masks draw as the kit's coloured overlay.
 */
export function PhotoPreview({
  projectId,
  ev,
  color,
  crop = true,
}: {
  projectId: string;
  ev: PhotoEvidence;
  color: string;
  crop?: boolean;
}) {
  const t = useT();
  const url = safeUrl(projectId, ev.src);
  const size = useImageSize(url);
  const [badMasks, setBadMasks] = useState<ReadonlySet<string>>(new Set());
  if (!url) return <div className="ic-ph empty">{t('card.photoMissing', { photo: ev.photo })}</div>;
  if (!size) return <div className="ic-ph loading" aria-busy="true" />;
  if ('failed' in size) return <div className="ic-ph empty">{t('card.photoFailed')}</div>;
  const box: Box4 = crop ? previewCrop(ev.box, size.w, size.h) : [0, 0, size.w, size.h];
  const pointR = Math.max(box[2], box[3]) / 28;
  return (
    <svg
      className="ic-svg"
      viewBox={box.join(' ')}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <image href={url} x={0} y={0} width={size.w} height={size.h} preserveAspectRatio="none" />
      {ev.masks
        .filter((m) => !badMasks.has(m))
        .map((m) => {
          const mu = safeUrl(projectId, { path: m });
          return mu ? (
            <image
              key={m}
              href={mu}
              x={0}
              y={0}
              width={size.w}
              height={size.h}
              preserveAspectRatio="none"
              opacity={0.5}
              onError={() => {
                setBadMasks((cur) => new Set([...cur, m]));
              }}
            />
          ) : null;
        })}
      {ev.shapes.map((g, i) => (
        <Mark key={i} geom={g} color={color} pointR={pointR} />
      ))}
    </svg>
  );
}

/** The frame of a video sighting at its first keyframe, with the box drawn on it. */
function FramePreview({
  projectId,
  ev,
  color,
}: {
  projectId: string;
  ev: VideoEvidence;
  color: string;
}) {
  const url = safeUrl(projectId, ev.src);
  const poster = safeUrl(projectId, ev.poster);
  const [frame, setFrame] = useState<FrameImage | 'failed' | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    frameImage(url, ev.tS).then(
      (f) => {
        if (live) setFrame(f);
      },
      () => {
        if (live) setFrame('failed');
      },
    );
    return () => {
      live = false;
    };
  }, [url, ev.tS]);
  if (frame && frame !== 'failed') {
    return (
      <svg
        className="ic-svg"
        viewBox={`0 0 ${String(frame.width)} ${String(frame.height)}`}
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        <image href={frame.dataUrl} width={frame.width} height={frame.height} />
        {ev.geom && (
          <Mark geom={ev.geom} color={color} pointR={Math.max(frame.width, frame.height) / 40} />
        )}
      </svg>
    );
  }
  if (frame === 'failed' && poster) return <img className="ic-img" src={poster} alt="" />;
  return (
    <div className={`ic-ph${frame === 'failed' ? ' empty' : ' loading'}`}>
      {frame === 'failed' && <Icon name="video" size={20} />}
    </div>
  );
}

function Evidence({ issue, color }: { issue: Issue; color: string }) {
  const t = useT();
  const project = useWorkspace((s) => s.project);
  const evidence = useMemo(
    () => (project ? issueEvidence(project.manifest, issue) : []),
    [project, issue],
  );
  if (!project) return null;
  const photos = photoEvidence(evidence);
  const videos = evidence.filter((e): e is VideoEvidence => e.kind === 'video');
  const [first, ...rest] = photos;
  if (!first && videos.length === 0) {
    return <p className="ic-none faint small">{t('card.noPhoto')}</p>;
  }
  return (
    <section className="ic-ev" aria-label={t('card.evidence')}>
      {first && (
        <button
          type="button"
          className="ic-photo lead"
          data-testid="issue-card-photo"
          aria-label={t('card.openPhoto', { photo: first.photo })}
          title={t('card.openPhoto', { photo: first.photo })}
          onClick={() => {
            openLightbox(issue.id, 0);
          }}
        >
          <PhotoPreview projectId={project.id} ev={first} color={color} />
          <span className="ic-cap mono">
            {first.photo}
            {photos.length > 1 ? ` · 1/${String(photos.length)}` : ''}
          </span>
          <span className="ic-zoom" aria-hidden="true">
            <Icon name="maximize" size={14} />
          </span>
        </button>
      )}
      {rest.length > 0 && (
        <div className="ic-strip">
          {rest.map((ev, i) => (
            <button
              key={ev.key}
              type="button"
              className="ic-photo"
              aria-label={t('card.openPhoto', { photo: ev.photo })}
              title={t('card.openPhoto', { photo: ev.photo })}
              onClick={() => {
                openLightbox(issue.id, i + 1);
              }}
            >
              <PhotoPreview projectId={project.id} ev={ev} color={color} />
              <span className="ic-cap mono">{ev.photo}</span>
            </button>
          ))}
        </div>
      )}
      {videos.map((ev) => (
        <div key={ev.key} className="ic-video">
          <div className="ic-photo frame">
            <FramePreview projectId={project.id} ev={ev} color={color} />
            <span className="ic-cap mono">{t('card.frameAt', { time: clipTime(ev.tS) })}</span>
          </div>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              const s = issue.sightings.find(
                (x) => x.on === 'video' && x.layer === ev.layer && (x.track[0]?.t ?? 0) === ev.tS,
              );
              if (s) openSighting(issue, s, project.manifest.layers);
              shell.getState().go('scene');
            }}
          >
            <Icon name="play" size={12} />
            {t('card.jumpTo', { time: clipTime(ev.tS) })}
            <span className="faint">{ev.name}</span>
          </button>
        </div>
      ))}
    </section>
  );
}

const STATUS_KEYS: Record<Issue['status'], MessageKey> = {
  draft: 'card.status.draft',
  reviewed: 'card.status.reviewed',
  approved: 'card.status.approved',
  closed: 'card.status.closed',
};
const KIND_KEYS = {
  mesh: 'card.kind.mesh',
  pointcloud: 'card.kind.pointcloud',
  map: 'card.kind.map',
  pano: 'card.kind.pano',
} as const satisfies Record<string, MessageKey>;

/** On: an issue picked in 3D opens its photo beside the 3D view (remembered on this machine). */
function SplitSwitch() {
  const t = useT();
  const on = useEvidence((s) => s.enabled);
  return (
    <label className="ic-switch" title={t('evidence.toggleTip')}>
      <Switch
        checked={on}
        label={t('evidence.toggle')}
        onChange={(v) => {
          setEvidenceEnabled(v);
        }}
      />
      <span>{t('evidence.toggle')}</span>
    </label>
  );
}

/** Remembered for the session: is the edit form unfolded. */
let editOpen = false;

export function IssueCard({
  issueId,
  place,
  order,
  onStep,
  className,
}: {
  issueId: string;
  place: CardPlace;
  /** Issue ids in the order previous and next walk (default: code order). */
  order?: readonly string[];
  /** Go to another issue (default: select it and fly the 3D view to it). */
  onStep?: (id: string) => void;
  className?: string;
}) {
  const t = useT();
  const issue = useWorkspace((s) => s.issues.find((i) => i.id === issueId));
  const issues = useWorkspace((s) => s.issues);
  const project = useWorkspace((s) => s.project);
  const readOnly = useAnnotateReadOnly();
  const [edit, setEdit] = useState(editOpen);
  const ownOrder = useMemo(() => order ?? issueOrder(issues), [order, issues]);
  const body = useRef<HTMLDivElement>(null);
  // a new issue starts at the top of the card
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [issueId]);

  if (!project) return null;
  if (!issue) {
    return (
      <section className={`ic ${className ?? ''}`} data-testid="issue-card">
        <p className="ic-none faint small">{t('card.missing', { id: issueId })}</p>
      </section>
    );
  }
  const m = project.manifest;
  const facts = issueFacts(m, issue);
  const model = m.severityModels.find((s) => s.id === issue.severityModelId);
  const color = severityColor(model, issue.severity);
  const at = ownOrder.indexOf(issue.id);
  const step = (dir: 1 | -1) => {
    const id = stepIssue(ownOrder, issue.id, dir);
    if (!id || id === issue.id) return;
    if (onStep) onStep(id);
    else {
      const next = workspace.getState().issues.find((i) => i.id === id);
      if (next) focusIssue(next);
    }
  };
  const loc = issueLocation(m, issue);
  const sevText =
    issue.severity === 'uncertain'
      ? facts.severityLabel
      : `${String(issue.severity)} ${facts.severityLabel}`;

  return (
    <section
      className={`ic ${className ?? ''}`}
      data-testid="issue-card"
      data-issue={issue.id}
      aria-label={t('card.label', { code: issue.code })}
    >
      <div className="panel-h ic-h">
        <h2>{t('card.title')}</h2>
        <span className="sub mono" data-testid="issue-card-pos">
          {at >= 0 ? t('card.position', { index: at + 1, total: ownOrder.length }) : ''}
        </span>
        <div className="acts">
          <button
            type="button"
            className="btn icon sm ghost"
            aria-label={t('card.prev')}
            title={t('card.prev')}
            disabled={ownOrder.length < 2}
            onClick={() => {
              step(-1);
            }}
          >
            <Icon name="back" size={14} />
          </button>
          <button
            type="button"
            className="btn icon sm ghost"
            aria-label={t('card.next')}
            title={t('card.next')}
            disabled={ownOrder.length < 2}
            onClick={() => {
              step(1);
            }}
          >
            <Icon name="fwd" size={14} />
          </button>
          <button
            type="button"
            className="btn icon sm ghost"
            aria-label={place === 'scene' ? t('card.flyTo') : t('card.showInScene')}
            title={place === 'scene' ? t('card.flyTo') : t('card.showInScene')}
            onClick={() => {
              focusIssue(issue);
              if (place !== 'scene' && place !== 'road') shell.getState().go('scene');
            }}
          >
            <Icon name="target" size={14} />
          </button>
          <button
            type="button"
            className="btn icon sm ghost"
            aria-label={t('card.close')}
            title={t('card.close')}
            onClick={() => {
              workspace.getState().select(null);
            }}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>
      <div className="ic-body" ref={body}>
        <div className="ic-id" style={{ ['--sev' as string]: color }}>
          <i className="ic-bar" aria-hidden="true" />
          <div className="ic-t">
            <b className="mono">{issue.code}</b>
            <h3>{issue.title}</h3>
          </div>
        </div>
        <div className="ic-chips">
          <SevChip color={color}>{sevText}</SevChip>
          <span className={`ic-tag${issue.status === 'draft' ? ' acc' : ''}`}>
            {t(STATUS_KEYS[issue.status])}
          </span>
          <span className="ic-tag">
            <i className="ic-dot" style={{ background: facts.classColor }} />
            {facts.classLabel}
          </span>
        </div>

        <Evidence issue={issue} color={color} />
        {place === 'scene' && <SplitSwitch />}

        <dl className="kv ic-kv">
          {facts.zone && (
            <div className="kv-row">
              <dt>{t('card.zone')}</dt>
              <dd>{facts.zone}</dd>
            </div>
          )}
          {loc && (
            <div className="kv-row">
              <dt>{crsLabel(m.crs).split(' · ')[0]}</dt>
              <dd className="mono">
                {formatEastNorth(loc.project[0], loc.project[1])}
                {loc.project[2] !== null && (
                  <>
                    <br />
                    EL {loc.project[2].toFixed(2)} m
                  </>
                )}
              </dd>
            </div>
          )}
          {facts.elsewhere.length > 0 && (
            <div className="kv-row">
              <dt>{t('card.seenOn')}</dt>
              <dd>
                {facts.elsewhere
                  .map(
                    (e) => `${t(KIND_KEYS[e.kind])}${e.count > 1 ? ` (${String(e.count)})` : ''}`,
                  )
                  .join(', ')}
              </dd>
            </div>
          )}
          <div className="kv-row">
            <dt>{t('card.author')}</dt>
            <dd>
              {issue.author} · {formatDate(issue.updatedAt)}
            </dd>
          </div>
        </dl>
        {facts.action && (
          <div className="ic-block">
            <h4>{t('card.action')}</h4>
            <p>{facts.action}</p>
          </div>
        )}
        {issue.note && (
          <div className="ic-block">
            <h4>{t('card.note')}</h4>
            <p className="ic-note">{issue.note}</p>
          </div>
        )}
        {!readOnly && (
          <details
            className="ic-edit"
            open={edit}
            onToggle={(e) => {
              editOpen = e.currentTarget.open;
              setEdit(editOpen);
            }}
          >
            <summary>{t('card.edit')}</summary>
            {edit && <IssueDetail issueId={issue.id} embedded />}
          </details>
        )}
      </div>
    </section>
  );
}
