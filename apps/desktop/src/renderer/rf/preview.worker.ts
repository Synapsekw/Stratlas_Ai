/**
 * The RF live preview Worker (spec D16): the renderer's entry point, bundled by Vite as its own
 * chunk (`new URL('./preview.worker.ts', import.meta.url)` in `previewClient.ts`). The work is
 * `servePreview` in `@aio/rf`.
 */
import { servePreview, type PreviewPort } from '@aio/rf';

servePreview(self as unknown as PreviewPort);
