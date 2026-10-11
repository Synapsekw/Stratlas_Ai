import '@cesium/engine/Source/Widget/CesiumWidget.css';
import './globe-view.css';
import type { GlobeSite, RasterPackInfo, TilesetEntry } from '@aio/schema';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { GlobeCamera } from '../camera';
import type { Insets } from '../chips';
import type { SiteGeoref } from '../geodesy';
import type { GlobeTileSource } from '../layers';
import { sitesBounds, type IssuePin } from '../sites';
import type { GlobePalette, GlobeStyle } from '../style';
import { GlobeController, type GlobeHover, type GlobePick } from './controller';
import type { GlobeTier } from './setup';

export interface GlobeIssuePins {
  projectId: string;
  georef: SiteGeoref;
  pins: readonly IssuePin[];
}

export interface GlobeTilesets {
  projectId: string;
  georef: SiteGeoref;
  entries: readonly TilesetEntry[];
}

/** The words of a floating label: a name, and a quieter note beside it. */
export interface GlobeTagText {
  title: string;
  note?: string;
}

export interface GlobeViewProps {
  /** Where the app serves its copy of Cesium's workers and assets (`<renderer>/cesium/`). */
  baseUrl: string;
  tier: GlobeTier;
  /** The look: the street map unless told otherwise. */
  style?: GlobeStyle;
  /** The app's street tiles; null or absent without street packs. */
  street?: GlobeTileSource | null;
  /** The street style's colours (the built-in copy of them when left out). */
  palette?: GlobePalette;
  /** Online satellite may be drawn (Satellite look only): the person switched it on. */
  onlineSatellite?: boolean;
  sites: readonly GlobeSite[];
  imagery: readonly RasterPackInfo[];
  terrain: readonly RasterPackInfo[];
  exaggeration: number;
  issuePins: GlobeIssuePins | null;
  /** The open project's 3D Tiles (`tilesets.json`). */
  tilesets: GlobeTilesets | null;
  /** Where to start: a remembered camera, a site to fly to, or every site. */
  start: { camera: GlobeCamera } | { site: readonly [number, number] } | null;
  reducedMotion: () => boolean;
  onPick: (pick: GlobePick | null) => void;
  /**
   * A gathered chip was clicked and its sites (project ids) cannot part: they still stand as
   * one chip where the flight to them ended. The host has another way to tell them apart.
   */
  onGroup?: (projectIds: string[]) => void;
  /** The selected site: its chip wears the outline, and rings leave it once. */
  selected?: string | null;
  /** A site hovered or focused elsewhere (the list): its chip lights as under the pointer. */
  highlighted?: string | null;
  /** The words of the label under the pointer for a site or an issue; null for none. */
  describe?: (what: GlobeHover) => GlobeTagText | null;
  /** The card of a pin: the Globe keeps it by that pin, inside the view. */
  card?: ReactNode;
  /** The pin the card tells of, a site's or an issue's. */
  cardPick?: GlobePick | null;
  /**
   * The room the screen's own controls take at each edge: the card stays clear of it, and so do
   * the chips of the sites a flight frames (the opening view, every site, a gathered chip's).
   */
  cardInsets?: Insets;
  /** The words on the chip of sites that gathered, in the app's language. */
  clusterLabel?: (count: number) => string;
  /** The geodesic read-out is on: clicks put points instead of picking. */
  measuring: boolean;
  onMeasure?: (points: [number, number][]) => void;
  /** The credit lines of what is drawn, whenever they change. */
  onCredits?: (lines: string[]) => void;
  onReady?: (c: GlobeController) => void;
  /** The camera when the Globe closes, to come back to the same view. */
  onClose?: (camera: GlobeCamera) => void;
}

const NOWHERE: SiteGeoref = { crs: { epsg: 4326 }, origin: [0, 0, 0], heightOffset: 0 };

function Chip({ text }: { text: GlobeTagText | null }) {
  if (!text) return null;
  return (
    <span className="aio-globe-chip">
      <span className="aio-globe-chip-title">{text.title}</span>
      {text.note && <span className="aio-globe-chip-note">{text.note}</span>}
    </span>
  );
}

/**
 * The Globe in a React element. The CesiumWidget is built once per mount and destroyed with its
 * WebGL context on unmount; props update the scene in place.
 */
export function GlobeView(props: GlobeViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const selectedTag = useRef<HTMLDivElement>(null);
  const hoverTag = useRef<HTMLDivElement>(null);
  const cardSlot = useRef<HTMLDivElement>(null);
  const [ctl, setCtl] = useState<GlobeController | null>(null);
  const [hover, setHover] = useState<GlobeHover | null>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    let made: GlobeController | undefined;
    const p = latest.current;
    void GlobeController.create({
      container: el,
      baseUrl: p.baseUrl,
      tier: p.tier,
      ...(p.style ? { style: p.style } : {}),
      ...(p.palette ? { palette: p.palette } : {}),
      font: getComputedStyle(el).fontFamily,
      clusterLabel: (count) => latest.current.clusterLabel?.(count) ?? String(count),
      reducedMotion: () => latest.current.reducedMotion(),
      onPick: (pick) => {
        latest.current.onPick(pick);
      },
      onGroup: (projectIds) => {
        latest.current.onGroup?.(projectIds);
      },
      onHover: (h) => {
        if (live) setHover(h);
      },
      onCredits: (lines) => {
        latest.current.onCredits?.(lines);
      },
      onMeasure: (points) => {
        latest.current.onMeasure?.(points);
      },
    }).then((c) => {
      if (!live) {
        c.destroy();
        return;
      }
      made = c;
      Object.assign(el, { __aioGlobe: c });
      c.bindTag('selected', selectedTag.current);
      c.bindTag('hover', hoverTag.current);
      c.bindTag('card', cardSlot.current);
      setCtl(c);
      const start = latest.current.start;
      if (start && 'camera' in start) c.setCamera(start.camera);
      else if (start && 'site' in start) void c.flyToSite(start.site);
      else {
        // the opening view frames the sites' chips, clear of the screen's controls: the Globe
        // has to know both before it flies (the effects below hand them over again, to no effect)
        c.setCardInsets(latest.current.cardInsets ?? null);
        c.setSites(latest.current.sites);
        c.flyHome(sitesBounds(latest.current.sites));
      }
      latest.current.onReady?.(c);
    });
    return () => {
      live = false;
      Reflect.deleteProperty(el, '__aioGlobe');
      if (made) {
        latest.current.onClose?.(made.camera());
        made.destroy();
      }
    };
    // the widget is built once per mount; the tier and base URL are read at creation
  }, []);

  useEffect(() => {
    ctl?.setSites(props.sites);
  }, [ctl, props.sites]);
  useEffect(() => {
    if (props.style) ctl?.setStyle(props.style);
  }, [ctl, props.style]);
  useEffect(() => {
    ctl?.setStreet(props.street ?? null);
  }, [ctl, props.street]);
  useEffect(() => {
    ctl?.setOnlineSatellite(props.onlineSatellite === true);
  }, [ctl, props.onlineSatellite]);
  useEffect(() => {
    ctl?.setPacks(props.imagery, props.terrain);
  }, [ctl, props.imagery, props.terrain]);
  useEffect(() => {
    ctl?.setExaggeration(props.exaggeration);
  }, [ctl, props.exaggeration]);
  useEffect(() => {
    const ip = props.issuePins;
    if (!ctl) return;
    if (ip) ctl.setIssuePins(ip.projectId, ip.georef, ip.pins);
    else ctl.setIssuePins('', NOWHERE, []);
  }, [ctl, props.issuePins]);
  useEffect(() => {
    ctl?.setSelected(props.selected ?? null);
  }, [ctl, props.selected]);
  useEffect(() => {
    ctl?.setHighlighted(props.highlighted ?? null);
  }, [ctl, props.highlighted]);
  // before the paint: a card never shows by the pin of the one before it
  useLayoutEffect(() => {
    ctl?.setCard(props.cardPick ?? null);
  }, [ctl, props.cardPick]);
  useLayoutEffect(() => {
    ctl?.setCardInsets(props.cardInsets ?? null);
  }, [ctl, props.cardInsets]);
  // the card's size is its content's, which any render may have changed
  useLayoutEffect(() => {
    if (props.card) ctl?.layoutCard();
  });
  // and which may change with no render here and the Globe at rest (a list that opens in it)
  useEffect(() => {
    const slot = cardSlot.current;
    if (!ctl || !slot) return;
    const sized = new ResizeObserver(() => {
      ctl.layoutCard();
    });
    sized.observe(slot);
    return () => {
      sized.disconnect();
    };
  }, [ctl]);

  useEffect(() => {
    ctl?.setMeasuring(props.measuring);
  }, [ctl, props.measuring]);
  useEffect(() => {
    const ts = props.tilesets;
    if (!ctl) return;
    void ctl.setTilesets(ts?.projectId ?? '', ts?.georef ?? NOWHERE, ts?.entries ?? []);
  }, [ctl, props.tilesets]);

  const selected = props.selected ?? null;
  const lit: GlobeHover | null =
    hover ?? (props.highlighted ? { kind: 'site', projectId: props.highlighted } : null);
  const toneOf = (projectId: string | null) =>
    props.sites.find((s) => s.projectId === projectId)?.issues.open ? 'attention' : 'clear';
  // a cluster's chip says what it is, and the selected site has its card
  const hoverText =
    lit && lit.kind !== 'cluster' && !(lit.kind === 'site' && lit.projectId === selected)
      ? (props.describe?.(lit) ?? null)
      : null;

  return (
    <div ref={ref} className="aio-globe" data-testid="globe-canvas">
      {/* what the label says is on the chips and the card: these only point at the pins */}
      <div className="aio-globe-tags" aria-hidden="true">
        <div
          ref={selectedTag}
          className="aio-globe-tag"
          data-tone={toneOf(selected)}
          data-testid="globe-tag-selected"
        >
          {selected !== null && <span key={selected} className="aio-globe-pulse" />}
        </div>
        <div ref={hoverTag} className="aio-globe-tag" data-testid="globe-tag-hover">
          <Chip text={hoverText} />
        </div>
      </div>
      {/* the card is read aloud and takes the pointer, unlike the labels */}
      <div ref={cardSlot} className="aio-globe-card-slot">
        {props.card}
      </div>
    </div>
  );
}
