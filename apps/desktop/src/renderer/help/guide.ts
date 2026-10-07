/**
 * The user guide: the Markdown chapters in docs/guide, bundled into the app at build time (Vite
 * `import.meta.glob`), so help works with no network and no files outside the app. The product
 * name in the text is `{product}` and the executable and installer name `{executable}`
 * (`QuadrionAI`, no spaces), both filled from @aio/brand, so a rename needs no guide edit.
 */
import { brand } from '@aio/brand';
import { parseMarkdown, plainText, type Block } from './markdown';

export interface Chapter {
  /** File name without the order prefix and `.md`, e.g. `compare-dates`. */
  slug: string;
  /** The chapter's `# heading`. */
  title: string;
  blocks: Block[];
}

/** `01-install.md` to `install`; null for anything that is not a chapter file. */
export function chapterSlug(path: string): string | null {
  const m = /(?:^|[/\\])(\d+)-([a-z0-9-]+)\.md$/.exec(path);
  return m?.[2] ?? null;
}

/** Fill `{product}` with the product name and `{executable}` with the executable name. */
export function fillProduct(
  text: string,
  product: string = brand.productName,
  executable: string = brand.executableName,
): string {
  return text.replaceAll('{product}', product).replaceAll('{executable}', executable);
}

/** Chapters from `path to Markdown` sources, in file order (the number prefix). */
export function buildChapters(sources: Record<string, string>, product?: string): Chapter[] {
  return Object.keys(sources)
    .filter((p) => chapterSlug(p) !== null)
    .sort((a, b) => (a.split(/[/\\]/).pop() ?? a).localeCompare(b.split(/[/\\]/).pop() ?? b))
    .map((path) => {
      const blocks = parseMarkdown(fillProduct(sources[path] ?? '', product));
      const h1 = blocks.find((b) => b.kind === 'heading' && b.level === 1);
      const slug = chapterSlug(path) ?? path;
      return {
        slug,
        title: h1?.kind === 'heading' ? plainText(h1.children) : slug,
        blocks,
      };
    });
}

/** Image file name (`images/x.png` in the Markdown) to a URL the app can load. */
export function imageUrls(urls: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(urls)) {
    const name = path.split(/[/\\]/).pop();
    if (name) out[name] = url;
  }
  return out;
}

let chapters: Chapter[] | null = null;
let images: Record<string, string> | null = null;

/** The bundled chapters (parsed once). */
export function guideChapters(): Chapter[] {
  chapters ??= buildChapters(
    import.meta.glob<string>('../../../../../docs/guide/*.md', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  );
  return chapters;
}

/** The bundled screenshots by file name. */
export function guideImages(): Record<string, string> {
  images ??= imageUrls(
    import.meta.glob<string>('../../../../../docs/guide/images/*.{png,jpg}', {
      query: '?url',
      import: 'default',
      eager: true,
    }),
  );
  return images;
}

/** The URL of an image the Markdown names (`images/x.png`), or null when it is not bundled. */
export function resolveImage(
  src: string,
  table: Record<string, string> = guideImages(),
): string | null {
  if (/^[a-z]+:/i.test(src) || src.startsWith('/') || src.includes('..')) return null;
  const name = src.replace(/^\.?\/?images\//, '');
  return table[name] ?? null;
}
