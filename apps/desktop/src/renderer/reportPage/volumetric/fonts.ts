// The offline volumetric HTML file's fonts: the app's IBM Plex files (SIL OFL, @fontsource, the
// latin subset) as `data:` URIs inside `@font-face` rules, so the file loads no font from anywhere.
// The report window itself gets the same faces from @aio/ui fonts.css.
import mono400 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?datauri';
import mono600 from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2?datauri';
import sans400 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2?datauri';
import sans500 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2?datauri';
import sans600 from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2?datauri';

const FACES: { family: string; weight: number; src: string }[] = [
  { family: 'IBM Plex Sans', weight: 400, src: sans400 },
  { family: 'IBM Plex Sans', weight: 500, src: sans500 },
  { family: 'IBM Plex Sans', weight: 600, src: sans600 },
  { family: 'IBM Plex Mono', weight: 400, src: mono400 },
  { family: 'IBM Plex Mono', weight: 600, src: mono600 },
];

/** `@font-face` rules for the embedded faces (the latin subset; other characters fall back). */
export function embeddedFontCss(): string {
  return FACES.map(
    (f) =>
      `@font-face{font-family:'${f.family}';font-style:normal;font-display:block;font-weight:${String(f.weight)};src:url(${f.src}) format('woff2')}`,
  ).join('\n');
}
