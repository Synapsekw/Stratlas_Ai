// Convert the staged EBSM flare stack kit offline build (EQUATE, Kuwait) into a native project.
// Usage (from packages/project): pnpm import:ebsm [--src <folder>] [--out <folder>]
import { runAik } from './aik-run.mjs';

await runAik('ebsm', { epsg: 32639, utcOffset: '+03:00', photos: 'all' });
