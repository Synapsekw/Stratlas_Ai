import type { ImportItem, ProjectManifest } from '@aio/schema';
import { assetUrl, workspace, type OpenProject } from '@aio/workspace';
import { bridge } from '../shell';
import { openDrawing, type OpenDrawing } from './rasterise';
import { drawings, type DrawingPlaced } from './store';

/** What the import list says about a drawing that came in (the builder says the same for PNG). */
export const DRAWING_ADDED =
  'Added to Drawings, not placed yet. Open it side by side, or place it on the site to lay it over the model.';

/** The import list the staged drawings report into (the builder's import panel). */
export interface StagedIo {
  items(): readonly ImportItem[];
  setItem(index: number, patch: Partial<ImportItem>): void;
  progress(p: { done: number; total: number; file: string } | null): void;
}

function askPages(name: string, pages: number): Promise<number[] | null> {
  return new Promise((resolve) => {
    drawings.setState({
      pagePrompt: {
        name,
        pages,
        answer: (chosen) => {
          drawings.setState({ pagePrompt: null });
          resolve(chosen);
        },
      },
    });
  });
}

/**
 * Finish the drawings main only copied in (`ImportItem.drawing`: PDF, WebP, SVG): draw their pages
 * here and hand each to `builder:addDrawingPage`. A PDF of several pages asks which pages first.
 * Each drawing reports on its own row; one that fails never stops the next.
 */
export async function finishStagedDrawings(projectId: string, io: StagedIo): Promise<void> {
  const staged = io
    .items()
    .map((it, index) => ({ d: it.drawing, index, status: it.status }))
    .filter((x) => x.d !== undefined && x.status === 'queued');
  for (const { d, index } of staged) {
    if (!d) continue;
    let open: OpenDrawing | null = null;
    try {
      open = await openDrawing(assetUrl(projectId, { path: d.src }), d.src);
      const many = open.pages > 1;
      let pages = [1];
      if (many) {
        io.setItem(index, { message: 'Waiting for the pages to import.' });
        const chosen = await askPages(d.name, open.pages);
        if (!chosen) {
          io.setItem(index, {
            status: 'skipped',
            message: 'No pages were imported. Import the file again to choose pages.',
          });
          continue;
        }
        pages = chosen;
      }
      let layerId = '';
      for (const [i, n] of pages.entries()) {
        io.progress({
          done: i,
          total: pages.length,
          file: many ? `${d.name}, page ${String(n)}` : d.name,
        });
        const png = await open.png(n);
        const r = await bridge.call('builder:addDrawingPage', {
          projectId,
          stem: d.stem,
          name: d.name,
          ...(many ? { page: n, pages: open.pages } : {}),
          png,
        });
        if (!r.ok) throw new Error(r.error);
        if (!r.value.ok) throw new Error(r.value.error);
        // the row points at the first page that came in
        layerId ||= r.value.layerId;
        if (workspace.getState().project?.id === projectId)
          workspace.getState().replaceManifest(r.value.manifest);
      }
      io.setItem(index, {
        status: 'imported',
        layerId,
        message:
          pages.length > 1
            ? `${String(pages.length)} pages added to Drawings, not placed yet. Open one side by side, or place it on the site to lay it over the model.`
            : DRAWING_ADDED,
      });
    } catch (e) {
      io.setItem(index, { status: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      open?.close();
      io.progress(null);
    }
  }
}

/** The plan layers of picture drawings (`sheet-<stem>`) with their folders. */
export function pictureDrawings(manifest: ProjectManifest): { id: string; stem: string }[] {
  const out: { id: string; stem: string }[] = [];
  for (const l of manifest.layers) {
    if (l.kind !== 'raster' || l.role !== 'plan' || !('path' in l.src)) continue;
    if (!l.id.startsWith('sheet-')) continue;
    const stem = /^drawings\/([^/]+)\/plan\.png$/.exec(l.src.path.replace(/\\/g, '/'))?.[1];
    if (stem) out.push({ id: l.id, stem });
  }
  return out;
}

/**
 * Read which picture drawings are placed, from their placement files. A drawing whose file cannot
 * be read is left out: it then shows no "not placed" mark and cannot be placed.
 */
export async function loadPlaced(project: OpenProject): Promise<Record<string, DrawingPlaced>> {
  const out: Record<string, DrawingPlaced> = {};
  await Promise.all(
    pictureDrawings(project.manifest).map(async ({ id, stem }) => {
      try {
        const res = await fetch(
          assetUrl(project.id, { path: `drawings/${stem}/placement.json` }),
          // the file changes when the drawing is placed
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const p = (await res.json()) as { provisional?: unknown; sizePx?: unknown };
        const size = p.sizePx;
        if (!Array.isArray(size) || typeof size[0] !== 'number' || typeof size[1] !== 'number')
          return;
        out[id] = {
          provisional: p.provisional === true,
          size: { width: size[0], height: size[1] },
        };
      } catch {
        // unreadable: not listed
      }
    }),
  );
  return out;
}
