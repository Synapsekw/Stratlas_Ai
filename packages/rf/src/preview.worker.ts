/** RF preview worker (spec D16): the entry point only; the work is `servePreview` in preview.ts. */
import { servePreview, type PreviewPort } from './preview';

servePreview(globalThis as unknown as PreviewPort);
