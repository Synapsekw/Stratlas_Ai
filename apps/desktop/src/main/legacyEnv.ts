// Imported first by index.ts, so it runs before any module reads the environment: the app's
// variables are QUADRION_* since the rename (7 Oct 2026), and a STRATLAS_* variable still set in
// a shell, script or CI job counts as its QUADRION_* twin unless that is set too. Child processes
// (pipelines, utility processes) inherit the copied names.
import { aliasLegacyEnv } from '@aio/brand/env';

aliasLegacyEnv(process.env);
