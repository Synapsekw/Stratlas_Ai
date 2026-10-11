import { openPdf } from '../report/pdf';
import { MAX_DRAWING_PX, fitWithin, pageSizePx, svgSize } from './model';

/**
 * Drawing the pages of a staged drawing in the app window: main has no canvas, so a PDF (pdf.js,
 * bundled), a WebP and an SVG (the browser's own decoders) are drawn here from their copy in the
 * project and handed back as PNG (`builder:addDrawingPage`).
 */

/** An opened drawing: how many pages it has and one PNG per page asked for. */
export interface OpenDrawing {
  pages: number;
  /** The PNG of a page (1-based), drawn at `shrink` of its full size (1: full). */
  png(page: number, shrink?: number): Promise<Uint8Array<ArrayBuffer>>;
  close(): void;
}

/** A canvas of that size, never above the size a drawing may have on a side. */
function canvasOf(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.min(MAX_DRAWING_PX, Math.round(width)));
  c.height = Math.max(1, Math.min(MAX_DRAWING_PX, Math.round(height)));
  return c;
}

async function pngOf(canvas: HTMLCanvasElement): Promise<Uint8Array<ArrayBuffer>> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
  // release the pixels now: a sheet is tens of megabytes
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error('The page could not be drawn as a picture.');
  return new Uint8Array(await blob.arrayBuffer());
}

async function openPdfDrawing(url: string): Promise<OpenDrawing> {
  const task = openPdf(url);
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (e) {
    task.cancel();
    const text = e instanceof Error ? e.message : String(e);
    throw new Error(
      /password/i.test(text)
        ? 'This PDF is locked with a password. Save a copy without one, then import it.'
        : `This PDF could not be opened (${text}).`,
      { cause: e },
    );
  }
  return {
    pages: doc.numPages,
    png: async (n, shrink = 1) => {
      const page = await doc.getPage(n);
      try {
        const base = page.getViewport({ scale: 1 });
        const size = pageSizePx(base.width, base.height);
        const viewport = page.getViewport({ scale: size.scale * shrink });
        const canvas = canvasOf(viewport.width, viewport.height);
        // the paper stays white: a sheet reads as a sheet side by side
        await page.render({ canvas, viewport }).promise;
        return await pngOf(canvas);
      } finally {
        page.cleanup();
      }
    },
    close: () => {
      task.cancel();
    },
  };
}

async function openPicture(url: string, svg: boolean): Promise<OpenDrawing> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The picture could not be read (${String(res.status)}).`);
  const data = await res.blob();
  return {
    pages: 1,
    png: async (_page, shrink = 1) => {
      if (!svg) {
        const bmp = await createImageBitmap(data).catch(() => null);
        if (!bmp) throw new Error('The picture could not be decoded.');
        const size = fitWithin(bmp.width, bmp.height, MAX_DRAWING_PX * shrink);
        const canvas = canvasOf(size.width, size.height);
        canvas.getContext('2d')?.drawImage(bmp, 0, 0, size.width, size.height);
        bmp.close();
        return pngOf(canvas);
      }
      // line art has no pixels of its own: draw it large, as a PDF page is
      const asked = svgSize(await data.text()) ?? { width: 1600, height: 1200 };
      const size = pageSizePx(asked.width * 0.75, asked.height * 0.75);
      const src = URL.createObjectURL(new Blob([data], { type: 'image/svg+xml' }));
      try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => {
            resolve();
          };
          img.onerror = () => {
            reject(
              new Error('The SVG could not be drawn. Save it as PDF or PNG, then import that.'),
            );
          };
          img.src = src;
        });
        const canvas = canvasOf(size.width * shrink, size.height * shrink);
        canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
        return await pngOf(canvas);
      } finally {
        URL.revokeObjectURL(src);
      }
    },
    close: () => undefined,
  };
}

/** Open the copy of a staged drawing (`src` ends in .pdf, .webp or .svg) at its aio:// URL. */
export function openDrawing(url: string, src: string): Promise<OpenDrawing> {
  const ext = src.slice(src.lastIndexOf('.')).toLowerCase();
  if (ext === '.pdf') return openPdfDrawing(url);
  return openPicture(url, ext === '.svg');
}
