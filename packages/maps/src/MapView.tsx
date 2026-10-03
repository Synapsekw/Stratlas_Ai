export interface MapViewProps {
  className?: string;
  /** Show the project's flight paths and video footprint (default true). */
  showFlights?: boolean;
}

/**
 * Offline 2D map (MapLibre + PMTiles packs over aio://) with project rasters, flight paths and the
 * live video footprint, sharing selection and playhead through @aio/workspace. Owner: stream S5.
 *
 * Phase 0 stub.
 */
export function MapView({ className }: MapViewProps) {
  return (
    <div className={className} data-stub="map-view" role="img" aria-label="Map">
      Map
    </div>
  );
}
