/**
 * The map type picker on the Map view: a chip in the map's corner that opens the choices as
 * cards (Streets, Satellite, Satellite only), which imagery pack to draw when several cover the
 * site, and terrain shading. It reads and writes the same choices as Settings, Offline maps
 * (`rasterPacks` in `siteTiles.ts`), so the two always agree; `basemap.ts` says what can be
 * chosen for the open site. A choice with no pack to draw from is greyed out with the reason and
 * a way to Settings, where packs are imported. `GroundRows` puts the 3D view's part of it (imagery
 * and terrain around the site) in the Layers popover.
 */
import { Icon, useFocusTrap, useT, type MessageKey } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { shell } from '../shell';
import { BASEMAPS, basemapPatch, siteLonLat, type Basemap } from './basemap';
import { usePopPlacement } from './popPlacement';
import { rasterPacks, useBasemap, useGround, useRasterPacks } from './siteTiles';
import './basemapPicker.css';

const LABEL: Record<Basemap, MessageKey> = {
  streets: 'basemap.streets',
  satellite: 'basemap.satellite',
  imagery: 'basemap.imagery',
};

const TIP: Record<Basemap, MessageKey> = {
  streets: 'basemap.streets.tip',
  satellite: 'basemap.satellite.tip',
  imagery: 'basemap.imagery.tip',
};

/**
 * A small picture of a map type. Drawn here, not rendered from the packs: it has to show before
 * any tile loads and for a type that has no pack yet. The colours are the map's own (the dark
 * street palette, imagery tones), the same in both app themes.
 */
export function BasemapSwatch({ kind }: { kind: Basemap }) {
  const imagery = kind !== 'streets';
  return (
    <svg
      className="bm-swatch"
      viewBox="0 0 88 56"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      focusable="false"
    >
      {imagery ? (
        <>
          <rect width="88" height="56" fill="#46563a" />
          <path d="M0 0H31L25 23H0Z" fill="#5d6b40" />
          <path d="M31 0H62L57 21L25 23Z" fill="#8a7a58" />
          <path d="M62 0H88V19L57 21Z" fill="#4c5f3d" />
          <path d="M0 23H25L21 41H0Z" fill="#9a8a63" />
          <path d="M25 23L57 21L53 43L21 41Z" fill="#53663c" />
          <path d="M57 21L88 19V41L53 43Z" fill="#746f47" />
          <path d="M0 45C18 39 30 55 52 48S80 42 88 50V56H0Z" fill="#20424c" />
          <g fill="#2f4029">
            <circle cx="9" cy="9" r="3.2" />
            <circle cx="14.5" cy="12.5" r="2.6" />
            <circle cx="71" cy="31" r="3.2" />
            <circle cx="76" cy="27.5" r="2.4" />
            <circle cx="40" cy="34" r="2.6" />
          </g>
        </>
      ) : (
        <>
          <rect width="88" height="56" fill="#16191d" />
          <path d="M57 0H78V13H57Z" fill="#18241f" />
          <path d="M0 45C18 39 30 55 52 48S80 42 88 50V56H0Z" fill="#0e1d28" />
        </>
      )}
      {kind !== 'imagery' && (
        <>
          <path
            d="M0 13H88M0 28H88M15 0V42M35 0V46M53 0V46M73 0V42"
            fill="none"
            stroke={imagery ? '#23272c' : '#343a40'}
            strokeWidth={imagery ? 1.4 : 1.2}
            strokeOpacity={imagery ? 0.85 : 1}
          />
          <path
            d="M-2 37L31 20L90 9"
            fill="none"
            stroke={imagery ? '#2b3036' : '#59616a'}
            strokeWidth="3"
          />
          <g fill={imagery ? '#eef1f4' : '#8d949c'}>
            <rect x="39" y="6" width="11" height="2.2" rx="1.1" />
            <rect x="19" y="32" width="9" height="2.2" rx="1.1" />
            <rect x="58" y="24" width="12" height="2.2" rx="1.1" />
          </g>
        </>
      )}
    </svg>
  );
}

/** Open Settings, Offline maps at Imagery and terrain, where packs are imported. */
function openPacks(): void {
  shell.getState().openSettings('raster-packs');
}

function PacksLink() {
  const t = useT();
  return (
    <button
      type="button"
      className="bm-link"
      title={t('basemap.openPacks.tip')}
      data-testid="basemap-open-packs"
      onClick={openPacks}
    >
      {t('basemap.openPacks')}
    </button>
  );
}

/** The choices themselves: the cards, the pack and terrain shading. */
export function BasemapChoices() {
  const t = useT();
  const model = useBasemap();
  const cards = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const choose = (b: Basemap) => {
    rasterPacks.getState().set(basemapPatch(b));
  };
  const offered = BASEMAPS.filter((b) => b === 'streets' || model.satellite);

  // arrows move through the map types that can be chosen and choose, as in a radio group
  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    const at = offered.indexOf(model.choice);
    const next =
      e.key === 'Home'
        ? offered[0]
        : e.key === 'End'
          ? offered[offered.length - 1]
          : step
            ? offered[(at + step + offered.length) % offered.length]
            : undefined;
    if (!next) return;
    e.preventDefault();
    choose(next);
    cards.current?.querySelector<HTMLElement>(`[data-basemap="${next}"]`)?.focus();
  };

  const missing: MessageKey | null =
    !model.satellite && !model.hillshade
      ? 'basemap.noPacks'
      : !model.satellite
        ? 'basemap.noImagery'
        : !model.hillshade
          ? 'basemap.noTerrain'
          : null;

  return (
    <div className="pop-form bm-form">
      <span className="pop-title" id={titleId}>
        {t('basemap.title')}
      </span>
      <div
        ref={cards}
        className="bm-cards"
        role="radiogroup"
        aria-labelledby={titleId}
        onKeyDown={onKeys}
      >
        {BASEMAPS.map((b) => (
          <button
            key={b}
            type="button"
            role="radio"
            className="bm-card"
            aria-checked={model.choice === b}
            disabled={!offered.includes(b)}
            title={t(TIP[b])}
            data-basemap={b}
            data-testid={`basemap-${b}`}
            onClick={() => {
              choose(b);
            }}
          >
            <span className="bm-pic">
              <BasemapSwatch kind={b} />
              {model.choice === b && (
                <span className="bm-tick" aria-hidden>
                  <Icon name="check" size={12} />
                </span>
              )}
            </span>
            <span className="bm-card-l">{t(LABEL[b])}</span>
          </button>
        ))}
      </div>
      {model.packs.length > 1 && (
        <label className="pop-row bm-pack" title={t('basemap.pack.tip')}>
          <span>{t('basemap.pack')}</span>
          <select
            className="input"
            data-testid="basemap-pack"
            value={model.pack ?? ''}
            disabled={model.choice === 'streets'}
            onChange={(e) => {
              rasterPacks.getState().set({ imageryPack: e.target.value || null });
            }}
          >
            <option value="">{t('basemap.pack.best')}</option>
            {model.packs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="pop-row bm-toggle" title={t('basemap.hillshade.tip')}>
        <span className="pop-grow">{t('basemap.hillshade')}</span>
        <input
          type="checkbox"
          data-testid="basemap-hillshade"
          disabled={!model.hillshade}
          checked={model.hillshadeOn}
          onChange={() => {
            rasterPacks.getState().set({ hillshade: !model.hillshadeOn });
          }}
        />
      </label>
      {missing && (
        <p className="pop-note bm-note" data-testid="basemap-note">
          {t(missing)} <PacksLink />
        </p>
      )}
    </div>
  );
}

/** The chip on the map and its popover. */
export function BasemapPicker() {
  const t = useT();
  const model = useBasemap();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // on the stage, never under the timeline or a side panel; it scrolls when the stage is short
  usePopPlacement(open, anchor, pop);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('pointerdown', away);
    };
  }, [open]);
  // focus goes to the map type in use, Tab stays inside, Esc closes and focus returns to the chip
  useFocusTrap(pop, open, {
    onEscape: () => {
      setOpen(false);
    },
    initial: () => pop.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? null,
    returnTo: () => button.current,
  });
  const name = t(LABEL[model.choice]);
  return (
    // over the stage (street map, imagery), like the stage toolbar: dark in every theme
    <div
      className="bm-anchor"
      ref={anchor}
      data-surface="dark"
      data-open={open || undefined}
      data-testid="basemap-picker"
    >
      <button
        ref={button}
        type="button"
        className="bm-chip overlay-box"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('basemap.button', { name })}
        title={open ? undefined : t('basemap.title')}
        data-basemap={model.choice}
        data-testid="basemap-button"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <BasemapSwatch kind={model.choice} />
        <span className="bm-chip-l">{name}</span>
        <Icon name="chevdown" size={12} className="muted" />
      </button>
      {open && (
        <div
          ref={pop}
          className="stage-pop overlay-box bm-pop"
          role="dialog"
          aria-label={t('basemap.title')}
          data-testid="basemap-pop"
        >
          <BasemapChoices />
        </div>
      )}
    </div>
  );
}

/**
 * The 3D view's ground from packs, in the Layers popover under the street map: imagery and
 * terrain around the site. The same choices as Settings, Offline maps. Nothing for a project
 * that is not placed on the Earth.
 */
export function GroundRows() {
  const t = useT();
  const ground = useGround();
  const prefs = useRasterPacks((s) => s.prefs);
  const placed = useWorkspace((s) => siteLonLat(s.project?.manifest ?? null) !== null);
  if (!placed) return null;
  const rows = [
    {
      key: 'aroundImagery',
      label: 'ground.imagery',
      tip: 'ground.imagery.tip',
      icon: 'raster',
      has: ground.imagery,
    },
    {
      key: 'aroundTerrain',
      label: 'ground.terrain',
      tip: 'ground.terrain.tip',
      icon: 'globe',
      has: ground.terrain,
    },
  ] as const;
  const missing: MessageKey | null = !ground.offered
    ? 'ground.tier'
    : !ground.imagery && !ground.terrain
      ? 'basemap.noPacks'
      : !ground.imagery
        ? 'basemap.noImagery'
        : !ground.terrain
          ? 'basemap.noTerrain'
          : null;
  return (
    <>
      {rows.map((r) => {
        const can = ground.offered && r.has;
        return (
          <label key={r.key} className="pop-row" title={t(r.tip)}>
            <Icon name={r.icon} size={14} className="muted" />
            <span className="pop-grow">{t(r.label)}</span>
            <input
              type="checkbox"
              data-testid={`ground-${r.key}`}
              disabled={!can}
              checked={can && prefs[r.key]}
              onChange={() => {
                rasterPacks.getState().set({ [r.key]: !prefs[r.key] });
              }}
            />
          </label>
        );
      })}
      {missing && (
        <p className="pop-note bm-note" data-testid="ground-note">
          {t(missing)} {ground.offered && <PacksLink />}
        </p>
      )}
    </>
  );
}
