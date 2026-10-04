// pdf.js, bundled with the app: the worker and its data (fonts, CMaps, decoders) load from the
// app's own files, never from a CDN.
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let configured = false;

function assetDir(name: string): string {
  return new URL(`./pdfjs/${name}/`, document.baseURI).href;
}

/** Open a PDF from an aio:// URL with range requests. */
export function openPdf(url: string): { promise: Promise<PDFDocumentProxy>; cancel: () => void } {
  if (!configured) {
    GlobalWorkerOptions.workerSrc = workerUrl;
    configured = true;
  }
  const task = getDocument({
    url,
    cMapUrl: assetDir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetDir('standard_fonts'),
    wasmUrl: assetDir('wasm'),
    iccUrl: assetDir('iccs'),
    enableXfa: false,
    rangeChunkSize: 1 << 20,
  });
  return {
    promise: task.promise,
    cancel: () => {
      void task.destroy();
    },
  };
}
