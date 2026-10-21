// Imported first by index.ts, so it runs before any module reads the environment: the app's
// variables are QUADRION_* since the rename (7 Oct 2026), and a STRATLAS_* variable still set in
// a shell, script or CI job counts as its QUADRION_* twin unless that is set too. Child processes
// (pipelines, utility processes) inherit the copied names.
// A packaged build then drops every development and test switch (packagedEnv.ts), so an installed
// app never loads another renderer URL, Python, ffmpeg, ODM or fake service from the environment.
import { aliasLegacyEnv } from '@aio/brand/env';
import { app } from 'electron';
import { scrubPackagedEnv } from './packagedEnv';

aliasLegacyEnv(process.env);
const dropped = scrubPackagedEnv(process.env, app.isPackaged);
if (dropped.length)
  console.warn(`Development switches ignored in an installed app: ${dropped.join(', ')}.`);
