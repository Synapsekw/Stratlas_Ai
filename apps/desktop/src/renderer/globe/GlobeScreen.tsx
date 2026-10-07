import { GlobeView } from '@aio/globe/view';
import { useGraphics } from '../graphics';

/** Where the renderer build serves its copy of Cesium (electron.vite.config.ts `cesiumAssets`). */
const CESIUM_BASE = new URL('cesium/', document.baseURI).href;

/** The Globe screen (M10 G6): loaded lazily, so CesiumJS costs nothing until it opens. */
export default function GlobeScreen() {
  const tier = useGraphics((s) => s.tier);
  return (
    <section className="globe-screen" aria-label="Globe" data-testid="globe-screen">
      <GlobeView baseUrl={CESIUM_BASE} tier={tier} />
    </section>
  );
}
