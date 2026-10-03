/**
 * Kit offline builds wrap every data file in a script so it loads from file://:
 * `window.__tankData=window.__tankData||{};window.__tankData["<key>"]=<json>;`
 */
export function parseKitDataJs(text: string): { key: string; value: unknown } {
  const marker = 'window.__tankData["';
  const at = text.lastIndexOf(marker);
  if (at < 0) throw new Error('Not a kit data script (window.__tankData missing)');
  const keyEnd = text.indexOf('"]', at + marker.length);
  const eq = text.indexOf('=', keyEnd);
  if (keyEnd < 0 || eq < 0) throw new Error('Malformed kit data script');
  const key = text.slice(at + marker.length, keyEnd);
  const body = text
    .slice(eq + 1)
    .trim()
    .replace(/;$/, '');
  return { key, value: JSON.parse(body) as unknown };
}

/**
 * Read `window.NAME=<json>;` from an HTML page (e.g. the kit 3D report). The JSON value must be
 * followed by `;` and a closing script tag or the next statement.
 */
export function extractWindowJson(html: string, name: string): unknown {
  const marker = `window.${name}=`;
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`window.${name} not found`);
  const start = at + marker.length;
  // Scan a JSON value with bracket/string awareness.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let i = start;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') {
        inStr = false;
        if (depth === 0) {
          i++;
          break;
        }
      }
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    } else if (depth === 0 && (ch === ';' || ch === '<')) break;
  }
  return JSON.parse(html.slice(start, i)) as unknown;
}
