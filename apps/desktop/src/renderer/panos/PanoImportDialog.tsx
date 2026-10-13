import type { PanoQuality, PanoScan } from '@aio/schema';
import { Icon, t, useFocusTrap } from '@aio/ui';
import { useMemo, useRef, useState } from 'react';
import {
  canUseHigh,
  closePanoImport,
  defaultKeys,
  defaultLayerName,
  importPanos,
  maxTextureSize,
  summaryText,
  usePanoImport,
} from './panos';
import './panos.css';

const MAP_W = 220;
const MAP_H = 120;

/** Where the spheres sit, in metres around their middle, fitted into a small box. */
function SphereMap({ scan, keys }: { scan: PanoScan; keys: ReadonlySet<string> }) {
  const pts = [...scan.spheres, ...scan.ready].map((p) => ({ key: p.key, lat: p.lat, lon: p.lon }));
  if (pts.length === 0) return null;
  const lat0 = pts.reduce((n, p) => n + p.lat, 0) / pts.length;
  const lon0 = pts.reduce((n, p) => n + p.lon, 0) / pts.length;
  const m = pts.map((p) => ({
    key: p.key,
    x: (p.lon - lon0) * 111_320 * Math.cos((lat0 * Math.PI) / 180),
    y: (p.lat - lat0) * 110_540,
  }));
  const span = Math.max(
    50,
    ...m.map((p) => Math.abs(p.x) * 2),
    ...m.map((p) => Math.abs(p.y) * 2 * (MAP_W / MAP_H)),
  );
  const s = (MAP_W - 24) / span;
  return (
    <svg
      className="pano-map"
      data-testid="pano-map"
      viewBox={`0 0 ${String(MAP_W)} ${String(MAP_H)}`}
      role="img"
      aria-label={t('pano.preview.mapLabel')}
    >
      {m.map((p, i) => (
        <g
          key={p.key}
          className={keys.has(p.key) ? 'on' : 'off'}
          transform={`translate(${String(MAP_W / 2 + p.x * s)} ${String(MAP_H / 2 - p.y * s)})`}
        >
          <circle r={7} />
          <text dy="3.5">{i + 1}</text>
        </g>
      ))}
    </svg>
  );
}

function rowText(frames: number, startedAt: string, relAlt: number | undefined): string {
  const time = startedAt.slice(11, 16);
  return relAlt === undefined
    ? t('pano.preview.rowNoHeight', { frames, time })
    : t('pano.preview.row', { frames, time, height: Math.round(relAlt) });
}

/** "Add drone panoramas": the scan's spheres to tick, the layer's name, date and quality. */
export function PanoImportDialog() {
  const open = usePanoImport((s) => s.open);
  const scanId = usePanoImport((s) => s.scan?.scanId ?? '');
  if (!open) return null;
  return <Dialog key={scanId} />;
}

function Dialog() {
  const { scan, busy, error, notStarted } = usePanoImport((s) => s);
  const dlg = useRef<HTMLDivElement>(null);
  useFocusTrap(dlg, true);
  const [keys, setKeys] = useState<Set<string>>(() => new Set(scan ? defaultKeys(scan) : []));
  const [name, setName] = useState(() => defaultLayerName(scan?.day ?? null));
  const [date, setDate] = useState(scan?.day ?? '');
  const [quality, setQuality] = useState<PanoQuality>('standard');
  const high = useMemo(() => canUseHigh(maxTextureSize()), []);
  const toggle = (k: string) => {
    setKeys((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  };
  const copying = busy?.phase === 'copy';
  const found = scan ? scan.spheres.length + scan.ready.length : 0;
  const go = () =>
    void importPanos({
      keys: [...keys],
      layerName: name.trim(),
      ...(date ? { date } : {}),
      quality,
    });

  return (
    <div
      className="dlg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void closePanoImport();
      }}
    >
      <div
        ref={dlg}
        className="dlg wide pano-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pano-import-title"
        data-testid="pano-import"
        onKeyDown={(e) => {
          if (e.key === 'Escape') void closePanoImport();
        }}
      >
        <div className="dlg-h">
          <Icon name="pano" size={16} />
          <h2 id="pano-import-title">{t('pano.preview.title')}</h2>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('pano.preview.cancel')}
            onClick={() => void closePanoImport()}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="dlg-b">
          {busy?.phase === 'scan' && (
            <p className="pano-busy" data-testid="pano-progress" aria-live="polite">
              {t('pano.scanning', { done: busy.done, total: busy.total })}
            </p>
          )}
          {error && (
            <p className="notice danger" role="alert">
              <Icon name="warn" size={14} />
              {error}
            </p>
          )}
          {notStarted && (
            <p className="notice" role="status">
              <Icon name="clock" size={14} />
              {t('pano.preview.importedNote')} {notStarted}
            </p>
          )}
          {scan && !notStarted && (
            <>
              <section className="dlg-sec pano-head">
                <p data-testid="pano-summary">
                  {found ? summaryText(scan, [...keys]) : t('pano.none')}
                </p>
                <SphereMap scan={scan} keys={keys} />
              </section>
              <section className="dlg-sec pano-rows">
                {scan.spheres.map((s, i) => (
                  <label
                    key={s.key}
                    className={`pano-row${keys.has(s.key) ? '' : ' off'}`}
                    data-testid={`pano-row-${s.key}`}
                  >
                    <input
                      type="checkbox"
                      checked={keys.has(s.key)}
                      disabled={copying}
                      onChange={() => {
                        toggle(s.key);
                      }}
                    />
                    {s.thumb ? <img src={s.thumb} alt="" /> : <span className="pano-thumb" />}
                    <span className="pano-row-t">
                      <b>{t('pano.itemName', { n: i + 1 })}</b>
                      <small>{rowText(s.frames, s.startedAt, s.relAlt)}</small>
                    </span>
                    {s.shape === 'wide' && (
                      <span className="tbadge info">{t('pano.preview.wide')}</span>
                    )}
                    {s.incomplete && (
                      <span className="tbadge warn">{t('pano.preview.incomplete')}</span>
                    )}
                    {s.alreadyIn && (
                      <span className="tbadge warn">
                        {t('pano.preview.already', { layer: s.alreadyIn })}
                      </span>
                    )}
                  </label>
                ))}
                {scan.ready.map((r, i) => (
                  <label
                    key={r.key}
                    className={`pano-row${keys.has(r.key) ? '' : ' off'}`}
                    data-testid={`pano-row-${r.key}`}
                  >
                    <input
                      type="checkbox"
                      checked={keys.has(r.key)}
                      disabled={copying}
                      onChange={() => {
                        toggle(r.key);
                      }}
                    />
                    {r.thumb ? <img src={r.thumb} alt="" /> : <span className="pano-thumb" />}
                    <span className="pano-row-t">
                      <b>{t('pano.itemName', { n: scan.spheres.length + i + 1 })}</b>
                      <small>{r.file.split(/[\\/]/).pop()}</small>
                    </span>
                    <span className="tbadge info">{t('pano.preview.ready')}</span>
                  </label>
                ))}
              </section>
              {scan.skipped.length > 0 && (
                <details className="dlg-sec pano-skipped" data-testid="pano-skipped">
                  <summary>
                    {t('pano.preview.notPano')} ({scan.skipped.length})
                  </summary>
                  <ul>
                    {scan.skipped.slice(0, 200).map((s) => (
                      <li key={s.file}>
                        <span className="mono">{s.file.split(/[\\/]/).pop()}</span>{' '}
                        {t(`pano.skip.${s.reason}`)}
                      </li>
                    ))}
                  </ul>
                  <p className="dim">{t('pano.preview.photosHint')}</p>
                </details>
              )}
              <section className="dlg-sec pano-fields">
                <label>
                  <span>{t('pano.preview.name')}</span>
                  <input
                    className="input"
                    data-testid="pano-name"
                    value={name}
                    disabled={copying}
                    onChange={(e) => {
                      setName(e.target.value);
                    }}
                  />
                </label>
                <label>
                  <span>{t('pano.preview.date')}</span>
                  <input
                    className="input"
                    data-testid="pano-date"
                    type="date"
                    value={date}
                    disabled={copying}
                    onChange={(e) => {
                      setDate(e.target.value);
                    }}
                  />
                </label>
                <fieldset>
                  <legend>{t('pano.preview.quality')}</legend>
                  <label>
                    <input
                      type="radio"
                      name="pano-q"
                      checked={quality === 'standard'}
                      onChange={() => {
                        setQuality('standard');
                      }}
                    />
                    {t('pano.preview.standard')}
                  </label>
                  {high && (
                    <label>
                      <input
                        data-testid="pano-quality-high"
                        type="radio"
                        name="pano-q"
                        checked={quality === 'high'}
                        onChange={() => {
                          setQuality('high');
                        }}
                      />
                      {t('pano.preview.high')}
                    </label>
                  )}
                </fieldset>
              </section>
            </>
          )}
          {copying && (
            <p className="pano-busy" data-testid="pano-progress" aria-live="polite">
              {t('pano.preview.copying', { done: busy.done, total: busy.total })}
            </p>
          )}
        </div>
        <div className="dlg-f">
          <button type="button" className="btn ghost" onClick={() => void closePanoImport()}>
            {notStarted ? t('pano.preview.close') : t('pano.preview.cancel')}
          </button>
          {!notStarted && (
            <button
              type="button"
              className="btn primary"
              data-testid="pano-import-go"
              disabled={busy !== null || keys.size === 0 || !name.trim()}
              onClick={go}
            >
              {t('pano.preview.import')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
