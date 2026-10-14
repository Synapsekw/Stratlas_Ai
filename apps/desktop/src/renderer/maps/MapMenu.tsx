/**
 * The Map menu (plan 2026-10-14-satellite-providers; the founder's Gallery layout, 14 Oct 2026):
 * a chip with the current map's picture and name, and a pop with the base maps as small pictures
 * grouped by source (Offline, Online satellite, Mapbox styles), the On top switches and a footer
 * with the credit line and a way to Settings, Map sources. One component for the Map view, the
 * Globe and the 3D scene; each view hands it the model (`mapMenuModel`) and what a pick does.
 *
 * When a Mapbox map is drawn the footer carries the Mapbox wordmark (in text) and, when the view
 * hands `onImproveMap`, an "Improve this map" link; main opens the address, so the renderer names
 * no provider host.
 *
 * Keyboard: the tiles are one radio group (arrows and Home/End move to the next tile that can be
 * picked and pick it), Tab moves between the group, the switches and the footer, Esc closes and
 * focus returns to the chip.
 */
import { isOnlineBase, onlineSource, type BaseMapId } from '@aio/schema';
import { Icon, Switch, useFocusTrap, useT } from '@aio/ui';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { usePopPlacement } from '../workspace/popPlacement';
import { MapSwatch } from './MapSwatch';
import type { MapMenuModel, MenuTile, OnTopKey } from './mapMenuModel';
import './mapMenu.css';

export interface MapMenuProps {
  model: MapMenuModel;
  testIds: { chip: string; pop: string };
  /** The anchor's class: the view places the chip with it. */
  className: string;
  /** More classes on the chip (the Globe keeps the surface of its buttons). */
  chipClassName?: string;
  /** `stage`: the pop stays on the stage (`usePopPlacement`); `free`: the view's CSS places it. */
  place: 'stage' | 'free';
  /** Over the map or the 3D view: dark in every theme. */
  dark?: boolean;
  onPick: (id: BaseMapId) => void;
  onToggle: (key: OnTopKey, on: boolean) => void;
  onPack: (id: string | null) => void;
  onOpenSources: () => void;
  /** The provider's notice while a first pick waits for the person's answer. */
  notice?: ReactNode;
  /** The view's own block under On top (the Globe's key to its pin colours). */
  extra?: ReactNode;
  /** Opens the provider's feedback page through main; the link shows only for a drawn Mapbox map. */
  onImproveMap?: () => void;
}

export function MapMenu(p: MapMenuProps) {
  const t = useT();
  const { model } = p;
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLDivElement>(null);
  const ids = useId();
  usePopPlacement(open && p.place === 'stage', anchor, pop);
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
  useFocusTrap(pop, open, {
    onEscape: () => {
      // back to the chip at once, not after the trap's release (a microtask after unmount)
      chip.current?.focus();
      setOpen(false);
    },
    initial: () => pop.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') ?? null,
    returnTo: () => chip.current,
  });

  const pickable = model.sections.flatMap((s) => s.tiles).filter((x) => x.state === 'available');
  const roving = (pickable.find((x) => x.selected) ?? pickable[0])?.id;
  const leave = () => {
    setOpen(false);
    p.onOpenSources();
  };

  const onKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    const current = (e.target as HTMLElement).dataset.base;
    const at = pickable.findIndex((x) => x.id === current);
    const next =
      e.key === 'Home'
        ? pickable[0]
        : e.key === 'End'
          ? pickable.at(-1)
          : step
            ? pickable[(at + step + pickable.length) % pickable.length]
            : undefined;
    if (!next) return;
    e.preventDefault();
    p.onPick(next.id);
    group.current?.querySelector<HTMLElement>(`[data-base="${next.id}"]`)?.focus();
  };

  const mapbox = isOnlineBase(model.drawn) && onlineSource(model.drawn)?.provider === 'mapbox';
  const name = t(model.chip);
  return (
    <div
      ref={anchor}
      className={`mm-anchor ${p.className}`}
      data-open={open || undefined}
      data-surface={p.dark ? 'dark' : undefined}
    >
      <button
        ref={chip}
        type="button"
        className={`mm-chip ${p.chipClassName ?? ''}`.trim()}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('mapMenu.button', { name })}
        title={open ? undefined : t('mapMenu.title')}
        data-base={model.chosen}
        data-testid={p.testIds.chip}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <MapSwatch kind={model.chipSwatch} className="mm-chip-pic" />
        <span className="mm-chip-l">{name}</span>
        {model.fallback && (
          <span
            className="mm-chip-note"
            title={t('mapMenu.fallback.tip')}
            data-testid="map-chip-fallback"
          >
            {t('mapMenu.fallback')}
          </span>
        )}
        <Icon name="chevdown" size={12} className="muted" />
      </button>
      {open && (
        <div
          ref={pop}
          className="mm-pop"
          role="dialog"
          aria-label={t('mapMenu.title')}
          data-testid={p.testIds.pop}
        >
          <div
            ref={group}
            className="mm-tiles"
            role="radiogroup"
            aria-label={t('mapMenu.title')}
            onKeyDown={onKeys}
          >
            {model.sections.map((s) => {
              const noteId = s.note ? `${ids}-${s.id}-note` : undefined;
              return (
                <section key={s.id} className="mm-sec" aria-labelledby={`${ids}-${s.id}`}>
                  <h3 className="mm-sec-t" id={`${ids}-${s.id}`}>
                    {t(s.title)}
                  </h3>
                  <div className="mm-grid">
                    {s.tiles.map((tile) => (
                      <Tile
                        key={tile.id}
                        tile={tile}
                        roving={tile.id === roving}
                        noteId={noteId}
                        onPick={p.onPick}
                      />
                    ))}
                  </div>
                  {s.note && (
                    <p className="mm-note" id={noteId} data-testid={`map-menu-note-${s.id}`}>
                      {t(s.note)}
                      {s.note === 'mapMenu.reason.needsKey' && (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="mm-link"
                            data-testid={`map-menu-add-key-${s.id}`}
                            onClick={leave}
                          >
                            {t('mapMenu.sources')}
                          </button>
                        </>
                      )}
                    </p>
                  )}
                </section>
              );
            })}
          </div>
          {p.notice}
          <section className="mm-sec mm-ontop" aria-labelledby={`${ids}-ontop`}>
            <h3 className="mm-sec-t" id={`${ids}-ontop`}>
              {t('mapMenu.section.onTop')}
            </h3>
            {model.onTop.map((r) => (
              <div
                key={r.key}
                className="mm-row"
                data-testid={`map-ontop-${r.key}`}
                data-disabled={r.disabled || undefined}
              >
                <Switch
                  label={t(r.label)}
                  checked={r.on}
                  disabled={r.disabled}
                  onChange={(on) => {
                    p.onToggle(r.key, on);
                  }}
                />
                <span className="mm-row-l">
                  <span>{t(r.label)}</span>
                  {r.reason && <span className="mm-row-why">{t(r.reason)}</span>}
                </span>
              </div>
            ))}
            {model.showPackPicker && (
              <label className="mm-row mm-pack">
                <span className="mm-row-l">{t('mapMenu.pack')}</span>
                <select
                  className="input"
                  data-testid="map-pack"
                  value={model.pack ?? ''}
                  onChange={(e) => {
                    p.onPack(e.target.value || null);
                  }}
                >
                  <option value="">{t('mapMenu.pack.best')}</option>
                  {model.packs.map((pk) => (
                    <option key={pk.id} value={pk.id}>
                      {pk.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>
          {p.extra}
          <footer className="mm-foot">
            <span className="mm-foot-l">
              <span className="mm-credit-line">
                {mapbox && (
                  <span className="mm-wordmark" data-testid="map-menu-wordmark">
                    Mapbox
                  </span>
                )}
                <span
                  className="mm-credit"
                  dir="ltr"
                  title={model.credit}
                  data-testid="map-menu-credit"
                >
                  {model.credit}
                </span>
              </span>
              {mapbox && p.onImproveMap && (
                <button
                  type="button"
                  className="mm-link"
                  data-testid="map-menu-improve"
                  onClick={p.onImproveMap}
                >
                  {t('mapMenu.improve')}
                </button>
              )}
            </span>
            <button
              type="button"
              className="mm-link mm-sources"
              title={t('mapMenu.sources.tip')}
              data-testid="map-sources-link"
              onClick={leave}
            >
              {t('mapMenu.sources')}
              <span className="mm-sources-go" aria-hidden>
                ›
              </span>
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

function Tile({
  tile,
  roving,
  noteId,
  onPick,
}: {
  tile: MenuTile;
  roving: boolean;
  noteId: string | undefined;
  onPick: (id: BaseMapId) => void;
}) {
  const t = useT();
  const off = tile.state !== 'available';
  return (
    <button
      type="button"
      role="radio"
      className="mm-tile"
      aria-checked={tile.selected}
      disabled={off}
      tabIndex={roving ? 0 : -1}
      title={tile.reason ? t(tile.reason) : t(tile.label)}
      aria-describedby={off ? noteId : undefined}
      data-base={tile.id}
      data-state={tile.state}
      data-testid={`map-tile-${tile.id}`}
      onClick={() => {
        onPick(tile.id);
      }}
    >
      <span className="mm-pic">
        <MapSwatch kind={tile.swatch} />
        {tile.badge && <span className="mm-badge">{t(tile.badge)}</span>}
      </span>
      <span className="mm-tile-l">{t(tile.label)}</span>
    </button>
  );
}
