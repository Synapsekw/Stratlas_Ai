import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Engine dev harness: `pnpm -F @aio/engine dev`. Serves the design test data
 * (git-ignored, see docs/design/assets/MANIFEST.md) as the public folder.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir:
    process.env.QUADRION_ASSETS ??
    process.env.STRATLAS_ASSETS ??
    'E:/Dev/AIO Software/docs/design/assets',
  plugins: [react()],
  server: { port: 5181, strictPort: true },
});
