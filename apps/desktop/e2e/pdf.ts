/** Read what a generated PDF shows, for the e2e tests (pdfjs in Node, no rendering). */
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFile } from 'node:fs/promises';

export interface PdfPage {
  text: string;
  /** Images drawn on the page (logos, photos, 3D views). */
  images: number;
}

/** Text and drawn images of the first `count` pages. */
export async function pdfPages(file: string, count = 1): Promise<PdfPage[]> {
  const data = new Uint8Array(await readFile(file));
  const task = getDocument({ data, useSystemFonts: false });
  const doc = await task.promise;
  try {
    const out: PdfPage[] = [];
    for (let i = 1; i <= Math.min(count, doc.numPages); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((it) => ('str' in it ? it.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ');
      const ops = await page.getOperatorList();
      const images = ops.fnArray.filter(
        (f) => f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject,
      ).length;
      out.push({ text, images });
    }
    return out;
  } finally {
    await task.destroy();
  }
}

/** Number of pages of a PDF and the text of the pages asked for (1-based), whitespace collapsed. */
export async function pdfText(
  file: string,
  pages: readonly number[],
): Promise<{ count: number; text: Map<number, string> }> {
  const data = new Uint8Array(await readFile(file));
  const task = getDocument({ data, useSystemFonts: false });
  const doc = await task.promise;
  try {
    const text = new Map<number, string>();
    for (const n of pages) {
      if (n < 1 || n > doc.numPages) continue;
      const content = await (await doc.getPage(n)).getTextContent();
      text.set(
        n,
        content.items
          .map((it) => ('str' in it ? it.str : ''))
          .join(' ')
          .replace(/\s+/g, ' '),
      );
    }
    return { count: doc.numPages, text };
  } finally {
    await task.destroy();
  }
}
