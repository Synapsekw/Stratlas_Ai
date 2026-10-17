import type { LineUpMeasure } from '@aio/schema';
import { Icon, useFocusTrap, useT } from '@aio/ui';
import { dateTags, workspace as appWorkspace, type Workspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import './lineup.css';
import { lineUpApp, type LineUpImage, type LineUpPreview, type LineUpStore } from './lineUpStore';
import { formatMetres, shiftWords } from './planLineUp';

export type { LineUpImage, LineUpPreview } from './lineUpStore';

/** Drawing size of the preview canvas; CSS scales it to the dialog. */
const W = 720;
const H = 300;

/** How the date that moves goes, in metres east and north, once the chosen date is kept. */
function moveOf(m: LineUpMeasure, keep: string | null): { eastM: number; northM: number } {
  const sign = keep === m.move ? -1 : 1;
  return { eastM: sign * m.eastM, northM: sign * m.northM };
}

type Box = LineUpImage['box'];

function overlapBox(a: Box, b: Box): Box {
  const box = {
    minX: Math.max(a.minX, b.minX),
    maxX: Math.min(a.maxX, b.maxX),
    minZ: Math.max(a.minZ, b.minZ),
    maxZ: Math.min(a.maxZ, b.maxZ),
  };
  // the dates hardly overlap: show both whole
  if (box.maxX - box.minX <= 0 || box.maxZ - box.minZ <= 0)
    return {
      minX: Math.min(a.minX, b.minX),
      maxX: Math.max(a.maxX, b.maxX),
      minZ: Math.min(a.minZ, b.minZ),
      maxZ: Math.max(a.maxZ, b.maxZ),
    };
  return box;
}

/**
 * The swipe preview: the kept date left of the divider, the moving date right of it, drawn where
 * it is now (Before) or with the correction (After), over the two orthos' common ground.
 */
function draw(
  canvas: HTMLCanvasElement,
  kept: LineUpImage,
  moved: LineUpImage,
  shift: { eastM: number; northM: number } | null,
  divider: number,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const view = overlapBox(kept.box, moved.box);
  const vw = view.maxX - view.minX;
  const vh = view.maxZ - view.minZ;
  const s = Math.min(W / vw, H / vh);
  const ox = (W - vw * s) / 2;
  const oy = (H - vh * s) / 2;
  const rectOf = (b: Box, dx = 0, dz = 0) =>
    [
      ox + (b.minX + dx - view.minX) * s,
      oy + (b.minZ + dz - view.minZ) * s,
      (b.maxX - b.minX) * s,
      (b.maxZ - b.minZ) * s,
    ] as const;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, vw * s, vh * s);
  ctx.clip();
  ctx.drawImage(kept.image, ...rectOf(kept.box));
  const x = ox + vw * s * divider;
  ctx.beginPath();
  ctx.rect(x, oy, W - x, vh * s);
  ctx.clip();
  // local frame: east is +x, north is -z
  ctx.drawImage(moved.image, ...rectOf(moved.box, shift?.eastM ?? 0, -(shift?.northM ?? 0)));
  ctx.restore();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, oy);
  ctx.lineTo(x, oy + vh * s);
  ctx.stroke();
}

function Preview({
  measure,
  keep,
  keptLabel,
  movedLabel,
  preview,
}: {
  measure: LineUpMeasure;
  keep: string | null;
  keptLabel: string;
  movedLabel: string;
  preview: LineUpPreview | null;
}) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [after, setAfter] = useState(false);
  const [divider, setDivider] = useState(0.5);
  const [images, setImages] = useState<Record<string, LineUpImage | null>>({});
  const { layerKeep, layerMove } = measure;
  useEffect(() => {
    if (!preview) return;
    let live = true;
    void Promise.all([layerKeep, layerMove].map((id) => preview(id).catch(() => null))).then(
      ([k, m]) => {
        if (live) setImages({ [layerKeep]: k ?? null, [layerMove]: m ?? null });
      },
    );
    return () => {
      live = false;
    };
  }, [preview, layerKeep, layerMove]);
  const keptLayer = keep === measure.move ? layerMove : layerKeep;
  const movedLayer = keptLayer === layerKeep ? layerMove : layerKeep;
  const kept = images[keptLayer];
  const moved = images[movedLayer];
  const shift = moveOf(measure, keep);
  useEffect(() => {
    if (canvas.current && kept && moved)
      draw(canvas.current, kept, moved, after ? shift : null, divider);
  });
  return (
    <div className="lu-preview" data-testid="lineup-preview">
      <div className="lu-preview-h">
        <h3>{t('lineUp.preview')}</h3>
        <div className="seg" role="group" aria-label={t('lineUp.preview')}>
          <button
            type="button"
            aria-pressed={!after}
            data-testid="lineup-before"
            onClick={() => {
              setAfter(false);
            }}
          >
            {t('lineUp.before')}
          </button>
          <button
            type="button"
            aria-pressed={after}
            data-testid="lineup-after"
            onClick={() => {
              setAfter(true);
            }}
          >
            {t('lineUp.after')}
          </button>
        </div>
      </div>
      <div className="lu-stage">
        <canvas
          ref={canvas}
          width={W}
          height={H}
          role="img"
          aria-label={`${t(after ? 'lineUp.after' : 'lineUp.before')}: ${keptLabel}, ${movedLabel}`}
        />
        <span className="lu-side lu-side-l" dir="auto">
          {keptLabel}
        </span>
        <span className="lu-side lu-side-r" dir="auto">
          {movedLabel}
        </span>
      </div>
      <input
        type="range"
        className="lu-divider"
        min={0}
        max={100}
        value={Math.round(divider * 100)}
        aria-label={t('lineUp.divider')}
        onChange={(e) => {
          setDivider(Number(e.target.value) / 100);
        }}
      />
    </div>
  );
}

function Dialog({
  store,
  preview,
  workspace,
}: {
  store: StoreApi<LineUpStore>;
  preview: LineUpPreview | null;
  workspace: StoreApi<Workspace>;
}) {
  const t = useT();
  const d = useStore(store, (s) => s.dialog);
  const captures = useStore(workspace, (s) => s.project?.manifest.captures);
  const ref = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const close = () => {
    store.getState().close();
  };
  useFocusTrap(ref, d !== null, { onEscape: close });
  if (!d) return null;
  const labelOf = (id: string) => captures?.find((c) => c.id === id)?.label ?? id;
  const tags = dateTags(captures ?? []);
  const m = d.measure;
  const movedId = d.keep === null ? (m?.move ?? d.b) : d.keep === d.a ? d.b : d.a;
  const keptId = movedId === d.a ? d.b : d.a;
  const ok = m !== null && m.verdict === 'ok';
  const shift = m ? moveOf(m, d.keep) : null;
  const canSave = ok && d.keep !== null && !saving && !d.measuring;
  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        className="dlg wide lu-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lineup-title"
        data-testid="lineup-dialog"
      >
        <div className="dlg-h">
          <Icon name="crosshair" size={16} />
          <h2 id="lineup-title">{t('lineUp.title')}</h2>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('lineUp.cancel')}
            onClick={close}
          >
            <Icon name="x" size={12} />
          </button>
        </div>
        <div className="dlg-b">
          <section className="dlg-sec lu-keep">
            <h3 id="lineup-keep">{t('lineUp.keep')}</h3>
            <p>{t('lineUp.keepHint')}</p>
            <div className="lu-dates" role="radiogroup" aria-labelledby="lineup-keep">
              {[d.a, d.b].map((id) => {
                const on = d.keep === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className="lu-date"
                    data-testid={`lineup-keep-${id}`}
                    onClick={() => {
                      store.getState().choose(id);
                    }}
                  >
                    <i className="lu-swatch" style={{ background: tags[id]?.colour }} />
                    <span className="lu-date-name" dir="auto">
                      {labelOf(id)}
                    </span>
                    {on && <Icon name="pin" size={12} />}
                  </button>
                );
              })}
            </div>
          </section>
          {d.measuring && (
            <p className="lu-busy" role="status">
              <span className="lu-busy-bar" aria-hidden="true" />
              {t('lineUp.measuring')}
            </p>
          )}
          {d.error && (
            <p className="notice danger lu-flush" role="alert" data-testid="lineup-refusal">
              <Icon name="warn" size={14} />
              <span>{d.error}</span>
            </p>
          )}
          {m && ok && shift && (
            <>
              <dl className="lu-facts">
                <dt>
                  <Icon name="target" size={12} />
                </dt>
                <dd data-testid="lineup-shift">{shiftWords(shift.eastM, shift.northM, t)}</dd>
                <dt>
                  <Icon name="check" size={12} />
                </dt>
                <dd data-testid="lineup-confidence">
                  {t('lineUp.confident', {
                    tiles: m.tiles,
                    spread: formatMetres(m.spreadPx * m.cellM),
                  })}
                </dd>
                {d.moves && (
                  <>
                    <dt>
                      <Icon name="layers" size={12} />
                    </dt>
                    <dd data-testid="lineup-moves">
                      {t('lineUp.moves', {
                        date: labelOf(movedId),
                        layers: t('lineUp.layers', { count: d.moves.layers }),
                        items: t('lineUp.items', { count: d.moves.items }),
                      })}
                    </dd>
                  </>
                )}
              </dl>
              <Preview
                measure={m}
                keep={d.keep}
                keptLabel={labelOf(keptId)}
                movedLabel={labelOf(movedId)}
                preview={preview}
              />
            </>
          )}
        </div>
        <div className="dlg-f">
          <span className="grow" />
          <button type="button" className="btn ghost" data-testid="lineup-cancel" onClick={close}>
            {t('lineUp.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            data-testid="lineup-confirm"
            disabled={!canSave}
            onClick={() => {
              setSaving(true);
              void store
                .getState()
                .confirm()
                .finally(() => {
                  setSaving(false);
                });
            }}
          >
            {t('lineUp.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The line-up step (Decision 11): which date stays, the measured shift, how sure it is, what
 * moves, and a Before and After swipe. Line up stays off until a date is chosen. Without a
 * `store` it shows the app's (`lineUpApp`), once the session has made it.
 */
export function LineUpDialog(props: {
  store?: StoreApi<LineUpStore>;
  preview?: LineUpPreview | null;
  /** The workspace the store writes into (the app's by default). */
  workspace?: StoreApi<Workspace>;
}) {
  const app = useStore(lineUpApp);
  const store = props.store ?? app.store;
  if (!store) return null;
  return (
    <Dialog
      store={store}
      preview={props.preview ?? app.preview}
      workspace={props.workspace ?? appWorkspace}
    />
  );
}
