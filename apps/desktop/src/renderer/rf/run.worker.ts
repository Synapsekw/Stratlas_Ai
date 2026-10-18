/**
 * The RF run reader Worker (integration review I1): it fetches a run's three GeoTIFFs, decodes
 * them and hands back the grids as drawn (`readRunGrids`: whole, or reduced to at most 2048 cells
 * on the long side with the class areas of the full grid), so a large run is never decoded on the
 * main thread. Bundled by Vite as its own chunk (`runClient.ts`).
 */
import { serveRunReader, type RunReaderPort } from './runClient';

serveRunReader(self as unknown as RunReaderPort, (url) => fetch(url));
