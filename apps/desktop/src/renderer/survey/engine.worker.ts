/** Survey engine worker (M11 G4): comparisons, fingerprints and whole-site differences. */
import type { EnginePort } from './engineProtocol';
import { serveEngine } from './engineServe';

serveEngine(self as unknown as EnginePort);
