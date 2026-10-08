/**
 * The terrain overlays panel (M11 G5, SRV-8): make **Contours** (0.5 m minor and 2.5 m major by
 * default), **Gradient** (in degrees, percent or 1:n), an **Elevation** ramp (smooth or stepped,
 * with a range) or **Shaded relief** (sun azimuth, altitude, intensity) of a prepared surface or of
 * the difference between two; list them, show or hide them on the map, remove them. Overlays are
 * made by the `survey.overlay` job and listed in `survey/overlays.json`, never in the manifest.
 */
import type { HeightTiles, OverlayKind, SurveyOverlay } from '@aio/schema';
import { Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useRef, useState } from 'react';
import { bridge } from '../shell';
import {
  createOverlay,
  loadOverlays,
  removeOverlay,
  setOverlaysOpen,
  setVisible,
  useOverlays,
} from './overlaysStore';
import './section.css';

const KINDS: { kind: OverlayKind; label: string }[] = [
  { kind: 'contours', label: 'Contours' },
  { kind: 'slope', label: 'Gradient' },
  { kind: 'elevation', label: 'Elevation' },
  { kind: 'relief', label: 'Shaded relief' },
];

function Legend({ o }: { o: SurveyOverlay }) {
  const stops = (o as { legend?: { stops?: [number, string][] } }).legend?.stops;
  if (!stops?.length) return null;
  return (
    <span className="ov-legend" aria-hidden>
      {stops.map(([v, c]) => (
        <span key={`${String(v)}${c}`} style={{ background: c }} />
      ))}
    </span>
  );
}

function num(v: string): number | undefined {
  const n = Number(v);
  return v.trim() !== '' && Number.isFinite(n) ? n : undefined;
}

/** Load the overlays with the project (mounted with the measurements). */
export function useOverlaysLoad(): void {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  useEffect(() => {
    if (projectId) void loadOverlays(projectId);
  }, [projectId]);
}

export function OverlaysPanel() {
  const file = useOverlays((s) => s.file);
  const readOnly = useOverlays((s) => s.readOnly);
  const error = useOverlays((s) => s.error);
  const making = useOverlays((s) => s.making);
  const note = useOverlays((s) => s.note);
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const [surfaces, setSurfaces] = useState<HeightTiles[]>([]);
  const [kind, setKind] = useState<OverlayKind>('contours');
  const [source, setSource] = useState('');
  const [diffFrom, setDiffFrom] = useState('');
  const [minor, setMinor] = useState('0.5');
  const [major, setMajor] = useState('2.5');
  const [style, setStyle] = useState<'degrees' | 'percent' | 'ratio'>('degrees');
  const [stepped, setStepped] = useState(false);
  const [low, setLow] = useState('');
  const [high, setHigh] = useState('');
  const [azimuth, setAzimuth] = useState('315');
  const [altitude, setAltitude] = useState('45');
  const [intensity, setIntensity] = useState('1');
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!projectId) return;
    void bridge.call('survey:surfaces', { projectId }).then((r) => {
      if (r.ok && r.value.ok) {
        setSurfaces(r.value.surfaces);
        setSource((s) => s || (r.value.ok ? (r.value.surfaces[0]?.id ?? '') : ''));
      }
    });
  }, [projectId, file]);

  const options = (): Record<string, unknown> => {
    if (kind === 'contours') return { minorM: num(minor) ?? 0.5, majorM: num(major) ?? 2.5 };
    if (kind === 'slope') return { style };
    if (kind === 'elevation') {
      const lo = num(low);
      const hi = num(high);
      return { stepped, ...(lo !== undefined && hi !== undefined ? { range: [lo, hi] } : {}) };
    }
    return {
      azimuth: num(azimuth) ?? 315,
      altitude: num(altitude) ?? 45,
      intensity: num(intensity) ?? 1,
    };
  };
  const make = () => {
    if (!source) return;
    void createOverlay(
      diffFrom
        ? {
            kind,
            comparison: {
              from: { kind: 'survey', surface: diffFrom },
              to: { kind: 'survey', surface: source },
            },
            options: options(),
          }
        : { kind, surface: source, options: options() },
    );
  };

  return (
    <section
      ref={ref}
      className="sv-card ov-panel"
      aria-label="Terrain overlays"
      data-testid="overlays-panel"
    >
      <header className="sv-head">
        <h2>
          <Icon name="layers" size={14} /> Terrain overlays
        </h2>
        <button
          type="button"
          className="btn ghost sm"
          aria-label="Close the overlays"
          onClick={() => {
            setOverlaysOpen(false);
          }}
        >
          <Icon name="x" size={14} />
        </button>
      </header>
      {error && (
        <p className="notice danger small" role="alert">
          <Icon name="warn" size={14} /> {error}
        </p>
      )}
      {!readOnly && (
        <div className="pop-form" role="group" aria-label="New overlay">
          <div className="seg pop-seg" role="group" aria-label="Overlay kind">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                aria-pressed={kind === k.kind}
                data-testid={`overlay-kind-${k.kind}`}
                onClick={() => {
                  setKind(k.kind);
                }}
              >
                {k.label}
              </button>
            ))}
          </div>
          {!surfaces.length && (
            <p className="small faint">No prepared surfaces yet: prepare the surveys first.</p>
          )}
          <label className="sv-field">
            <span>Surface</span>
            <select
              className="sv-input"
              data-testid="overlay-surface"
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
              }}
            >
              {surfaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="sv-field">
            <span>Difference from</span>
            <select
              className="sv-input"
              data-testid="overlay-diff-from"
              value={diffFrom}
              onChange={(e) => {
                setDiffFrom(e.target.value);
              }}
            >
              <option value="">None: the surface itself</option>
              {surfaces
                .filter((s) => s.id !== source)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
          {kind === 'contours' && (
            <div className="sv-row">
              <label className="sv-field">
                <span>Minor (m)</span>
                <input
                  className="sv-input"
                  data-testid="overlay-minor"
                  value={minor}
                  onChange={(e) => {
                    setMinor(e.target.value);
                  }}
                />
              </label>
              <label className="sv-field">
                <span>Major (m)</span>
                <input
                  className="sv-input"
                  data-testid="overlay-major"
                  value={major}
                  onChange={(e) => {
                    setMajor(e.target.value);
                  }}
                />
              </label>
            </div>
          )}
          {kind === 'slope' && (
            <label className="sv-field">
              <span>Show as</span>
              <select
                className="sv-input"
                data-testid="overlay-style"
                value={style}
                onChange={(e) => {
                  setStyle(e.target.value as 'degrees' | 'percent' | 'ratio');
                }}
              >
                <option value="degrees">Degrees (0, 30, 45, 60)</option>
                <option value="percent">Percent</option>
                <option value="ratio">Ratio 1:n</option>
              </select>
            </label>
          )}
          {kind === 'elevation' && (
            <>
              <label className="pop-row">
                <span className="pop-grow">Stepped colours</span>
                <input
                  type="checkbox"
                  checked={stepped}
                  onChange={(e) => {
                    setStepped(e.target.checked);
                  }}
                />
              </label>
              <div className="sv-row">
                <label className="sv-field">
                  <span>From (m)</span>
                  <input
                    className="sv-input"
                    value={low}
                    placeholder="lowest"
                    onChange={(e) => {
                      setLow(e.target.value);
                    }}
                  />
                </label>
                <label className="sv-field">
                  <span>To (m)</span>
                  <input
                    className="sv-input"
                    value={high}
                    placeholder="highest"
                    onChange={(e) => {
                      setHigh(e.target.value);
                    }}
                  />
                </label>
              </div>
            </>
          )}
          {kind === 'relief' && (
            <div className="sv-row">
              <label className="sv-field">
                <span>Sun azimuth</span>
                <input
                  className="sv-input"
                  value={azimuth}
                  onChange={(e) => {
                    setAzimuth(e.target.value);
                  }}
                />
              </label>
              <label className="sv-field">
                <span>Altitude</span>
                <input
                  className="sv-input"
                  value={altitude}
                  onChange={(e) => {
                    setAltitude(e.target.value);
                  }}
                />
              </label>
              <label className="sv-field">
                <span>Intensity</span>
                <input
                  className="sv-input"
                  value={intensity}
                  onChange={(e) => {
                    setIntensity(e.target.value);
                  }}
                />
              </label>
            </div>
          )}
          <button
            type="button"
            className="btn sm primary"
            data-testid="overlay-create"
            disabled={!source || making !== null}
            onClick={make}
          >
            {making ? 'Making the overlay…' : 'Make overlay'}
          </button>
          {note && (
            <p className="small faint" role="status">
              {note}
            </p>
          )}
        </div>
      )}
      <span className="pop-title">On this site</span>
      {!file?.overlays.length && <p className="small faint">No overlays yet.</p>}
      <ul className="ov-list">
        {file?.overlays.map((o) => (
          <li key={o.id} data-testid="overlay-item" data-kind={o.kind}>
            <label className="pop-row">
              <input
                type="checkbox"
                checked={o.visible}
                disabled={readOnly}
                aria-label={`Show ${o.name}`}
                onChange={(e) => {
                  void setVisible(o.id, e.target.checked);
                }}
              />
              <span className="pop-grow small">{o.name}</span>
              {!readOnly && (
                <button
                  type="button"
                  className="btn ghost sm"
                  aria-label={`Remove ${o.name}`}
                  onClick={() => {
                    void removeOverlay(o.id);
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </label>
            <Legend o={o} />
          </li>
        ))}
      </ul>
    </section>
  );
}
