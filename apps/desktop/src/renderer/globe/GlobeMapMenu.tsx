import { GLOBE_STYLES, type GlobeStyle, type GlobeTierName } from '@aio/globe';
import type { GlobeSettings, RasterPackInfo } from '@aio/schema';
import { Icon, t, useFocusTrap, useT, type MessageKey } from '@aio/ui';
import { useEffect, useId, useRef, useState } from 'react';
import './globe-map-menu.css';

const LOOK_LABEL: Record<GlobeStyle, MessageKey> = {
  street: 'globe.lookStreet',
  satellite: 'globe.lookSatellite',
  'natural-earth': 'globe.lookNaturalEarth',
};

export interface GlobeMapMenuProps {
  prefs: GlobeSettings;
  look: GlobeStyle;
  tier: GlobeTierName;
  imagery: readonly RasterPackInfo[];
  terrain: readonly RasterPackInfo[];
  /** How many street map packs are installed. */
  streetPacks: number;
  online: boolean;
  onSave: (next: GlobeSettings) => void;
}

/**
 * The Globe's Map button and the small dialog under it: the map type, imagery and terrain
 * choices, the issue pins switch, and the key to the pins' colours. The dialog stays open while
 * a setting changes, so a look can be tried and changed again; a press away or Esc closes it.
 */
export function GlobeMapMenu({
  prefs,
  look,
  tier,
  imagery,
  terrain,
  streetPacks,
  online,
  onSave,
}: GlobeMapMenuProps) {
  useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const lookLabel = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('pointerdown', away);
    };
  }, [open]);
  // focus moves into the dialog, Tab stays inside, Esc closes and focus returns to the button
  useFocusTrap(pop, open, {
    onEscape: () => {
      setOpen(false);
    },
    returnTo: () => opener.current,
  });

  return (
    <div className="globe-map" ref={root}>
      <button
        ref={opener}
        type="button"
        className="btn globe-map-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="globe-map-button"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="layers" size={14} />
        {t('globe.mapMenu')}
      </button>
      {open && (
        <div
          ref={pop}
          className="globe-map-pop"
          role="dialog"
          aria-label={t('globe.mapMenuTitle')}
          data-testid="globe-map-menu"
        >
          <div className="globe-options">
            <div className="globe-field">
              <span id={lookLabel}>{t('globe.look')}</span>
              <div className="seg globe-looks" role="group" aria-labelledby={lookLabel}>
                {GLOBE_STYLES.map((style) => (
                  <button
                    key={style}
                    type="button"
                    aria-pressed={look === style}
                    data-testid={`globe-look-${style}`}
                    onClick={() => {
                      onSave({ ...prefs, style });
                    }}
                  >
                    {t(LOOK_LABEL[style])}
                  </button>
                ))}
              </div>
            </div>
            {look === 'street' && streetPacks === 0 && (
              <p className="globe-note">{t('globe.noStreetPacks')}</p>
            )}
            {look === 'satellite' && imagery.length === 0 && !online && (
              <p className="globe-note">{t('globe.satelliteHint')}</p>
            )}
            {look !== 'street' && (
              <label className="globe-field">
                <span>{t('globe.imagery')}</span>
                <select
                  className="input"
                  value={prefs.imagery ?? 'auto'}
                  onChange={(e) => {
                    onSave({ ...prefs, imagery: e.target.value });
                  }}
                >
                  <option value="auto">{t('globe.imageryAuto')}</option>
                  {imagery.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="globe-field">
              <span>{t('globe.terrain')}</span>
              <select
                className="input"
                value={prefs.terrain ?? 'auto'}
                disabled={tier === 'low'}
                onChange={(e) => {
                  onSave({ ...prefs, terrain: e.target.value });
                }}
              >
                <option value="auto">{t('globe.terrainAuto')}</option>
                <option value="off">{t('globe.terrainOff')}</option>
                {terrain.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {tier === 'low' && <p className="globe-note">{t('globe.lowTier')}</p>}
            <label className="globe-check">
              <input
                type="checkbox"
                checked={prefs.showIssues !== false}
                onChange={(e) => {
                  onSave({ ...prefs, showIssues: e.target.checked });
                }}
              />
              <span>{t('globe.showIssues')}</span>
            </label>
          </div>
          <ul className="globe-key" aria-label={t('globe.key')}>
            <li data-tone="clear">
              <span className="globe-dot" aria-hidden="true" />
              {t('globe.keyClear')}
            </li>
            <li data-tone="attention">
              <span className="globe-dot" aria-hidden="true" />
              {t('globe.keyAttention')}
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
