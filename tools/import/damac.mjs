// Convert the staged DAMAC Hills tower facade kit offline build (Dubai) into a native project.
// Only reviewed photos (a finding or an uncertain area) and the report cover are imported; the
// legacy viewer under legacy/ keeps all 4,538.
// Usage (from packages/project): pnpm import:damac [--src <folder>] [--out <folder>]
import { runAik } from './aik-run.mjs';

await runAik('damac', { epsg: 32640, utcOffset: '+04:00', photos: 'reviewed' });
