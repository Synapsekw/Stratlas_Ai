import { fromWgs84, toWgs84 } from '@aio/geo';
import { LocationPicker } from '@aio/maps';
import type { Layer, Vec3 } from '@aio/schema';
import { Icon, isDrawingPlanLayer, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseCoordinate } from '../builder/model';
import { useStagePick, usePickMarkers, type Marker } from '../builder/pick';
import { builder } from '../builder/state';
import { RasterView, type RasterPick } from '../workspace/RasterPane';
import { PlaceWalkHere, useWalkPlacingOn } from '../walks/PlaceWalkStrip';
import { cornersFromPairs } from './model';
import { drawings, useDrawings, type PlaceSession } from './store';

type RasterLayer = Extract<Layer, { kind: 'raster' }>;
type SiteSource = 'scene' | 'map' | 'typed';

const SOURCES: { id: SiteSource; label: string }[] = [
  { id: 'scene', label: '3D view' },
  { id: 'map', label: 'Map' },
  { id: 'typed', label: 'Typed' },
];

/** The choices of the raster pane: drawings first, under their own heading. */
export function RasterOptions({ rasters }: { rasters: readonly RasterLayer[] }) {
  const t = useT();
  const sheets = rasters.filter(isDrawingPlanLayer);
  const others = rasters.filter((r) => !isDrawingPlanLayer(r));
  const option = (r: RasterLayer) => (
    <option key={r.id} value={r.id}>
      {r.name}
    </option>
  );
  if (sheets.length === 0 || others.length === 0) return <>{rasters.map(option)}</>;
  return (
    <>
      <optgroup label={t('stage.pane.drawings')}>{sheets.map(option)}</optgroup>
      <optgroup label={t('stage.pane.orthos')}>{others.map(option)}</optgroup>
    </>
  );
}

const f2 = (v: number) => v.toFixed(2);

/**
 * Place a drawing by point pairs, in the strip above its pane: click a point on the drawing, then
 * give the same spot on the site (a click in the 3D view, on the small map, or a typed
 * coordinate). Two or more pairs give its corners (`cornersFromPairs`); Place saves them.
 */
function PlaceStrip({
  layer,
  place,
  size,
}: {
  layer: RasterLayer;
  place: PlaceSession;
  size: { width: number; height: number };
}) {
  const project = useWorkspace((s) => s.project);
  const [source, setSource] = useState<SiteSource>('scene');
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = useRef(false);
  const { pairs, pending } = place;
  const origin = project?.manifest.origin;
  const epsg = project && 'epsg' in project.manifest.crs ? project.manifest.crs.epsg : null;

  // the sheet lies over the site on its old placement: out of the way while the site is clicked
  useEffect(() => {
    const was = workspace.getState().isLayerVisible(layer.id);
    workspace.getState().setLayerVisible(layer.id, false);
    return () => {
      // a drawing that was just placed shows; a cancelled one goes back to what it was
      if (!saved.current) workspace.getState().setLayerVisible(layer.id, was);
    };
  }, [layer.id]);

  useStagePick(pending !== null && source === 'scene', (hit) => {
    if (!hit) {
      setNote({
        text: 'Nothing under the cursor. Click the model, the ortho or the ground.',
        bad: true,
      });
      return;
    }
    setNote(null);
    drawings.getState().addSite([hit.point.x, hit.point.y, hit.point.z], false);
  });

  const fit = useMemo(
    () => (pairs.length >= 2 ? cornersFromPairs(pairs, size) : null),
    [pairs, size],
  );
  const markers = useMemo<Marker[]>(
    () => pairs.map((p) => ({ pos: p.local, color: 0xf4b740 })),
    [pairs],
  );
  usePickMarkers(markers);

  const lonLat = (p: Vec3): [number, number] | null => {
    if (!origin || epsg === null) return null;
    const ll = toWgs84([origin[0] + p[0], origin[1] - p[2], 0], epsg);
    return [ll[0], ll[1]];
  };
  const centre = lonLat([0, 0, 0]) ?? undefined;
  const mapPoints = pairs
    .filter((p) => p.horizontalOnly)
    .map((p) => lonLat(p.local))
    .filter((p): p is [number, number] => p !== null);

  const addTyped = () => {
    if (!origin || epsg === null) {
      setNote({
        text: 'This project has no coordinate system: click the 3D view instead.',
        bad: true,
      });
      return;
    }
    const p = parseCoordinate(typed, epsg);
    if (!p) {
      setNote({
        text: 'Type easting northing, or latitude, longitude. A height is optional.',
        bad: true,
      });
      return;
    }
    // without a height the point fixes the plan only (the base comes from the other pairs)
    const withHeight =
      typed
        .trim()
        .split(/[\s,;]+/)
        .filter(Boolean).length === 3;
    drawings
      .getState()
      .addSite(
        [p[0] - origin[0], withHeight ? p[2] - origin[2] : 0, origin[1] - p[1]],
        !withHeight,
      );
    setTyped('');
    setNote(null);
  };

  const save = async () => {
    if (!fit || 'error' in fit) return;
    setSaving(true);
    const error = await builder.getState().saveLayers([layer.id], { corners: fit.corners });
    setSaving(false);
    if (error) {
      setNote({ text: error, bad: true });
      return;
    }
    saved.current = true;
    workspace.getState().setLayerVisible(layer.id, true);
    drawings.setState((s) => ({
      place: null,
      placed: { ...s.placed, [layer.id]: { provisional: false, size } },
    }));
  };

  const step = pending
    ? source === 'scene'
      ? 'Now click the same spot in the 3D view.'
      : source === 'map'
        ? 'Now click the same spot on the small map.'
        : 'Now type where that spot is.'
    : pairs.length === 0
      ? 'Click a point on the drawing that you can find on the site.'
      : pairs.length === 1
        ? 'One pair. Click a second point on the drawing, far from the first.'
        : 'Click another point to add a pair, or place the drawing.';
  const fitted = fit && !('error' in fit) ? fit : null;
  return (
    <div
      className="dplace"
      role="group"
      aria-label={`Place ${layer.name}`}
      data-testid="place-strip"
    >
      <p className={note?.bad ? 'dplace-say bad' : 'dplace-say'} role="status">
        {note?.text ?? step}
      </p>
      <div className="dplace-row">
        <span className="faint">Site point from</span>
        <div className="seg" role="group" aria-label="Site point from">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={source === s.id}
              onClick={() => {
                setSource(s.id);
                setNote(null);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        {source === 'typed' && (
          <form
            className="dplace-typed"
            onSubmit={(e) => {
              e.preventDefault();
              addTyped();
            }}
          >
            <input
              className="input mono"
              value={typed}
              disabled={!pending}
              placeholder="E N, or lat, lon"
              aria-label="Site coordinate"
              onChange={(e) => {
                setTyped(e.target.value);
              }}
            />
            <button type="submit" className="btn sm" disabled={!pending}>
              Add
            </button>
          </form>
        )}
      </div>
      {source === 'map' && pending && origin && epsg !== null && (
        <LocationPicker
          className="b-mini-map dplace-map"
          {...(centre ? { center: centre, zoom: 16 } : {})}
          points={mapPoints}
          onPick={([lon, lat]) => {
            const p = fromWgs84([lon, lat, 0], epsg);
            drawings.getState().addSite([p[0] - origin[0], 0, origin[1] - p[1]], true);
            setNote(null);
          }}
        />
      )}
      <div className="dplace-row">
        {pairs.map((_pair, i) => (
          <span key={i} className="dplace-pair" data-testid="place-pair">
            <b>{i + 1}</b>
            {fitted ? `${f2(fitted.residuals[i] ?? 0)} m` : 'set'}
            <button
              type="button"
              aria-label={`Remove pair ${String(i + 1)}`}
              title="Remove this pair"
              onClick={() => {
                drawings.getState().removePair(i);
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        {fitted && (
          <span className="faint mono" data-testid="place-fit">
            {(fitted.metresPerPx * 1000).toFixed(1)} mm per pixel, off by {f2(fitted.rms)} m
          </span>
        )}
        {fit && 'error' in fit && <span className="dplace-say bad">{fit.error}</span>}
        <span className="dplace-end">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              drawings.getState().stopPlace();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={!fitted || saving}
            data-testid="place-save"
            onClick={() => void save()}
          >
            <Icon name="check" size={14} />
            Place
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * A raster in the split view. While the place tool works on it, the strip above it collects the
 * point pairs and clicks on the picture pick drawing points. While a walk is placed on it, the
 * Place walk strip sits above it and the walk is drawn on the picture.
 */
export function DrawingPane({
  projectId,
  layer,
  link,
}: {
  projectId: string;
  layer: RasterLayer;
  link: string | null;
}) {
  const place = useDrawings((s) => (s.place?.layerId === layer.id ? s.place : null));
  const size = useDrawings((s) => s.placed[layer.id]?.size);
  const pick = useMemo<RasterPick | undefined>(() => {
    if (!place) return undefined;
    return {
      onPick: (px) => {
        drawings.getState().pickDrawing(px);
      },
      marks: [
        ...place.pairs.map((p, i) => ({ x: p.px[0], y: p.px[1], label: String(i + 1) })),
        ...(place.pending
          ? [
              {
                x: place.pending[0],
                y: place.pending[1],
                label: String(place.pairs.length + 1),
                pending: true,
              },
            ]
          : []),
      ],
    };
  }, [place]);
  const walk = useWalkPlacingOn(layer.id, size);
  return (
    <>
      {place && size && <PlaceStrip layer={layer} place={place} size={size} />}
      {!place && (
        <PlaceWalkHere at={{ kind: 'drawing', id: layer.id, name: layer.name, dated: false }} />
      )}
      <RasterView
        projectId={projectId}
        layer={layer}
        link={link}
        pick={size ? (pick ?? walk.pick) : undefined}
        overlay={place ? undefined : walk.overlay}
      />
    </>
  );
}
