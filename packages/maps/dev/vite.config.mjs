// Dev harness for the offline map: `pnpm -F @aio/maps dev`, then open http://localhost:5179.
// Serves packs from <dataRoot>/packs and the Al-Zour fixtures through Vite's /@fs/ (with range
// requests), standing in for the aio:// protocol of the desktop app.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const dataRoot = process.env.STRATLAS_DATA ?? 'E:/Stratlas Data';
const fixtures = process.env.STRATLAS_FIXTURES ?? 'E:/Dev/AIO Software/docs/design/assets';

export default defineConfig({
  root: import.meta.dirname,
  define: {
    __PACKS__: JSON.stringify(`/@fs/${resolve(dataRoot, 'packs').replace(/\\/g, '/')}/`),
    __FIXTURES__: JSON.stringify(`/@fs/${resolve(fixtures).replace(/\\/g, '/')}/`),
  },
  server: {
    port: 5179,
    fs: { allow: [resolve(import.meta.dirname, '../../..'), dataRoot, fixtures] },
  },
});
