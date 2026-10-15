import { Icon, useT } from '@aio/ui';
import { useEffect, useId, useRef, useState } from 'react';
import {
  BUILTIN_COVERS,
  drawBuiltinCover,
  imageToCoverJpeg,
  type BuiltinCoverId,
  type CoverChoice,
  type CoverPalette,
} from './cover';
import './cover.css';

/** A built-in cover drawn live at a fixed resolution; CSS scales it into its 16:9 box. */
function CoverCanvas({
  id,
  palette,
  width,
}: {
  id: BuiltinCoverId;
  palette: CoverPalette;
  width: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const height = Math.round((width * 9) / 16);
  // the palette is often a fresh object each render; draw again only when a colour changes
  const { bg, line, accent } = palette;
  useEffect(() => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    drawBuiltinCover(g, id, { bg, line, accent }, c.width, c.height);
  }, [id, bg, line, accent]);
  return <canvas ref={ref} width={width} height={height} className="cover-canvas" />;
}

export interface CoverPickerProps {
  palette: CoverPalette;
  value: CoverChoice;
  onChange: (c: CoverChoice) => void;
  /** The wizard: offer "No cover". */
  allowNone?: boolean;
  /** The dialog, when a cover of this computer is set: offer the project's own picture. */
  allowReset?: boolean;
  /** A picture of this project's 3D view taken as its scene was last left, if there is one. */
  lastView?: Uint8Array<ArrayBuffer> | null;
}

/** A small picture of the last 3D view, with an object URL of its own while it shows. */
function LastViewThumb({ data }: { data: Uint8Array<ArrayBuffer> }) {
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const el = img.current;
    if (!el) return;
    const u = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
    el.src = u;
    return () => {
      el.removeAttribute('src');
      URL.revokeObjectURL(u);
    };
  }, [data]);
  return <img ref={img} className="cover-last-thumb" alt="" draggable={false} />;
}

export function CoverPicker({
  palette,
  value,
  onChange,
  allowNone,
  allowReset,
  lastView,
}: CoverPickerProps) {
  const t = useT();
  const file = useRef<HTMLInputElement>(null);
  const whyId = useId();
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState(false);
  // the object URL this picker made last: freed when replaced and when the picker goes away
  const made = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (made.current) URL.revokeObjectURL(made.current);
      made.current = null;
    },
    [],
  );
  const viewOk = lastView != null && lastView.byteLength > 0;

  const takeImage = (data: Uint8Array<ArrayBuffer>) => {
    const url = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
    if (made.current) URL.revokeObjectURL(made.current);
    made.current = url;
    onChange({ kind: 'image', data, url });
  };

  const upload = (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setBad(false);
    imageToCoverJpeg(f)
      .then(takeImage)
      .catch(() => {
        setBad(true);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const fromView = () => {
    if (!lastView || !viewOk || busy) return;
    setBad(false);
    takeImage(lastView);
  };

  const pick = (c: CoverChoice) => {
    setBad(false);
    onChange(c);
  };

  return (
    <div className="cover-picker">
      <div className="cover-preview" data-kind={value.kind} data-testid="cover-preview">
        {value.kind === 'builtin' && <CoverCanvas id={value.id} palette={palette} width={640} />}
        {value.kind === 'image' && <img src={value.url} alt="" draggable={false} />}
        {(value.kind === 'none' || value.kind === 'reset') && (
          <div className="cover-empty" style={{ background: palette.bg }}>
            <Icon name={value.kind === 'none' ? 'x' : 'photo'} size={20} />
            <span>{t(value.kind === 'none' ? 'library.cover.none' : 'library.cover.reset')}</span>
          </div>
        )}
      </div>

      <div className="cover-side">
        <span className="cover-label" id={`${whyId}-b`}>
          {t('library.cover.builtin')}
        </span>
        <div className="cover-swatches" role="group" aria-labelledby={`${whyId}-b`}>
          {BUILTIN_COVERS.map((id) => {
            const on = value.kind === 'builtin' && value.id === id;
            return (
              <button
                key={id}
                type="button"
                className="cover-swatch"
                aria-pressed={on}
                aria-label={t(`library.cover.builtin.${id}`)}
                title={t(`library.cover.builtin.${id}`)}
                data-testid={`cover-builtin-${id}`}
                onClick={() => {
                  pick({ kind: 'builtin', id });
                }}
              >
                <CoverCanvas id={id} palette={palette} width={160} />
              </button>
            );
          })}
        </div>

        <div className="cover-actions">
          <button
            type="button"
            className="btn sm"
            aria-pressed={value.kind === 'image' && value.data !== lastView}
            disabled={busy}
            data-testid="cover-upload-button"
            onClick={() => file.current?.click()}
          >
            <Icon name="import" size={12} />
            {t('library.cover.upload')}
          </button>
          <input
            ref={file}
            type="file"
            accept="image/*"
            hidden
            tabIndex={-1}
            data-testid="cover-upload"
            onChange={(e) => {
              upload(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="btn sm"
            disabled={!viewOk || busy}
            aria-describedby={viewOk ? undefined : whyId}
            aria-pressed={value.kind === 'image' && value.data === lastView}
            data-testid="cover-last-view"
            onClick={fromView}
          >
            {lastView ? <LastViewThumb data={lastView} /> : <Icon name="camera" size={12} />}
            {t('library.cover.lastView')}
          </button>
          {allowNone && (
            <button
              type="button"
              className="btn sm ghost"
              aria-pressed={value.kind === 'none'}
              data-testid="cover-none"
              onClick={() => {
                pick({ kind: 'none' });
              }}
            >
              {t('library.cover.none')}
            </button>
          )}
          {allowReset && (
            <button
              type="button"
              className="btn sm ghost"
              aria-pressed={value.kind === 'reset'}
              data-testid="cover-reset"
              onClick={() => {
                pick({ kind: 'reset' });
              }}
            >
              <Icon name="undo" size={12} />
              {t('library.cover.reset')}
            </button>
          )}
        </div>
        {!viewOk && (
          <p className="cover-why" id={whyId}>
            {t('library.cover.lastView.why')}
          </p>
        )}
      </div>

      {bad && (
        <p className="notice danger cover-bad" role="alert" data-testid="cover-bad-image">
          <Icon name="warn" size={14} />
          <span>{t('library.cover.badImage')}</span>
        </p>
      )}
    </div>
  );
}
