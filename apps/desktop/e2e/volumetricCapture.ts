/**
 * Helpers for the volumetric report specs (layout plan 2026-11-20, T9): a log of what the export's
 * progress card showed, read from the page so nothing is missed between two polls; the saved
 * pictures' frame; and what a saved JPEG shows (colours at points, shares of black, paper and the
 * pile box's red), decoded in the app's own window so the specs need no image library.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One state of the progress card (`volumetric-picture-progress`), in the order shown. */
export interface CardState {
  /** `data-phase`: `pictures`, `stopping` or `writing`. */
  phase: string;
  /** What is pictured ("Site, 31 March 2026", "Pile 2 of 4: ..."), or the writing line. */
  what: string;
  /** "Picture 3 of 22", or empty while there is no count. */
  count: string;
  /** Whether Stop is inert (`aria-disabled`). */
  stopInert: boolean;
  /** Milliseconds since the log began. */
  at: number;
}

interface CardLogWindow {
  __vrCard?: { log: CardState[]; stop: () => void };
}

/** Start logging the progress card; call before the click that starts the export. */
export async function watchCard(win: Page): Promise<void> {
  await win.evaluate(() => {
    const w = window as CardLogWindow;
    w.__vrCard?.stop();
    const log: CardState[] = [];
    const t0 = performance.now();
    const read = () => {
      const card = document.querySelector('[data-testid="volumetric-picture-progress"]');
      if (!card) return;
      const stop = [...card.querySelectorAll('button')].find((b) =>
        b.textContent.includes('Stop taking pictures'),
      );
      const now: CardState = {
        phase: card.getAttribute('data-phase') ?? '',
        what: card.querySelector('.vre-progress-what')?.textContent ?? '',
        count: card.querySelector('.vre-progress-count')?.textContent ?? '',
        stopInert: stop?.getAttribute('aria-disabled') === 'true' || stop?.disabled === true,
        at: Math.round(performance.now() - t0),
      };
      const last = log.at(-1);
      if (
        last?.phase !== now.phase ||
        last.what !== now.what ||
        last.count !== now.count ||
        last.stopInert !== now.stopInert
      )
        log.push(now);
    };
    const seen = new MutationObserver(read);
    seen.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    w.__vrCard = {
      log,
      stop: () => {
        seen.disconnect();
      },
    };
  });
}

/** What the progress card showed since `watchCard`. */
export async function cardLog(win: Page): Promise<CardState[]> {
  return win.evaluate(() => (window as CardLogWindow).__vrCard?.log ?? []);
}

/**
 * Seconds per picture from a card log: the time from one "Picture k of n" to the next, averaged
 * for the site's pictures and for the piles' own (by the card's label).
 */
export function secondsPerPicture(log: readonly CardState[]): {
  site: number | null;
  pile: number | null;
  all: number | null;
  pictures: number;
} {
  const counted = log.filter((s) => s.phase === 'pictures' && /^Picture \d+ of \d+$/.test(s.count));
  // the first state of each picture
  const firsts = counted.filter((s, i) => i === 0 || counted[i - 1]?.count !== s.count);
  const end = log.find((s) => s.phase === 'writing')?.at ?? log.at(-1)?.at ?? 0;
  const spans = firsts.map((s, i) => ({
    pile: s.what.startsWith('Pile '),
    ms: (firsts[i + 1]?.at ?? end) - s.at,
  }));
  const mean = (xs: number[]) =>
    xs.length > 0 ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length / 10) / 100 : null;
  return {
    site: mean(spans.filter((s) => !s.pile).map((s) => s.ms)),
    pile: mean(spans.filter((s) => s.pile).map((s) => s.ms)),
    all: mean(spans.map((s) => s.ms)),
    pictures: spans.length,
  };
}

/** A picture in the saved frame (`report/views/volumetric/frame.json`). */
export interface FrameView {
  name: string;
  kind: 'photo' | 'elevation' | 'cutfill' | '3d' | 'pile-photo' | 'pile-3d';
  capture: string;
  file: string;
  pile?: string;
  extent?: [number, number, number, number];
}

export interface Frame {
  extent: [number, number, number, number];
  widthPx: number;
  heightPx: number;
  mPerPx: number;
  views: FrameView[];
  fingerprint: string;
}

export const viewsDir = (projectDir: string) => join(projectDir, 'report', 'views', 'volumetric');

/** The saved frame, or null when the report has no pictures. */
export async function readFrame(projectDir: string): Promise<Frame | null> {
  try {
    return JSON.parse(await readFile(join(viewsDir(projectDir), 'frame.json'), 'utf8')) as Frame;
  } catch {
    return null;
  }
}

export type Rgb = [number, number, number];

export interface JpegProbe {
  width: number;
  height: number;
  /** The colour at each asked point. */
  points: Rgb[];
  /** Shares of all pixels, 0 to 1. */
  black: number;
  paper: number;
  /** The red of the pile box's lifted surface (the pile look, Solid). */
  red: number;
}

/** The report's picture paper (`PICTURE_PAPER` in liveStage.ts), within JPEG noise. */
export const PAPER: Rgb = [241, 243, 245];
export const isPaper = ([r, g, b]: Rgb) =>
  Math.abs(r - PAPER[0]) <= 8 && Math.abs(g - PAPER[1]) <= 8 && Math.abs(b - PAPER[2]) <= 8;
export const isBlack = ([r, g, b]: Rgb) => r < 40 && g < 40 && b < 40;

/**
 * Decode a JPEG in the app's window and read it: the colour at `points` (x, y as fractions of the
 * width and height, from the top left) and the share of black, paper-coloured and clearly red
 * pixels (the pile look's box lifts the pile's surface in red; the synthetic ground is sand).
 */
export async function probeJpeg(
  win: Page,
  file: string,
  points: readonly (readonly [number, number])[] = [],
): Promise<JpegProbe> {
  const b64 = (await readFile(file)).toString('base64');
  return win.evaluate(
    async ({ b64, points }) => {
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2D canvas');
      g.drawImage(bmp, 0, 0);
      const { data, width, height } = g.getImageData(0, 0, bmp.width, bmp.height);
      let black = 0;
      let paper = 0;
      let red = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] ?? 0;
        const gr = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        if (r < 40 && gr < 40 && b < 40) black++;
        if (Math.abs(r - 241) <= 8 && Math.abs(gr - 243) <= 8 && Math.abs(b - 245) <= 8) paper++;
        if (r > 150 && r - gr > 70 && r - b > 70) red++;
      }
      const n = width * height;
      return {
        width,
        height,
        points: points.map(([fx, fy]) => {
          const x = Math.min(width - 1, Math.max(0, Math.round(fx * (width - 1))));
          const y = Math.min(height - 1, Math.max(0, Math.round(fy * (height - 1))));
          const i = (y * width + x) * 4;
          return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0] as [number, number, number];
        }),
        black: black / n,
        paper: paper / n,
        red: red / n,
      };
    },
    { b64, points: points.map(([x, y]) => [x, y] as [number, number]) },
  );
}

/**
 * Answer every save dialog with `<dir>/<n>-<default name>`; the main process counts the dialogs
 * and remembers the last path (`saveDialogs`).
 */
export async function answerSaves(app: ElectronApplication, dir: string): Promise<void> {
  await app.evaluate(
    ({ dialog }, folder) => {
      const g = globalThis as unknown as { __vrSaves?: { count: number; last: string } };
      g.__vrSaves = { count: 0, last: '' };
      dialog.showSaveDialog = (...args: unknown[]) => {
        const opts = (args.length > 1 ? args[1] : args[0]) as { defaultPath?: string };
        const name = String(opts.defaultPath).split(/[\\/]/).pop() ?? 'export';
        const s = (g.__vrSaves ??= { count: 0, last: '' });
        s.count += 1;
        s.last = `${folder}/${String(s.count)}-${name}`;
        return Promise.resolve({ canceled: false, filePath: s.last });
      };
    },
    dir.replace(/\\/g, '/'),
  );
}

/** How many save dialogs were shown, and the last path answered. */
export async function saveDialogs(
  app: ElectronApplication,
): Promise<{ count: number; last: string }> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __vrSaves?: { count: number; last: string } }).__vrSaves ?? {
        count: 0,
        last: '',
      },
  );
}
