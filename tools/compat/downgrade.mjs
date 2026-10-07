// "What would this older build have written for this content?": parse a current record with an
// older schema, removing only what that schema cannot hold. Unknown keys of strict objects go;
// an array element the older schema refuses (a layer kind, a sighting type it did not have) goes;
// anything else is an error, so the corpus never invents data. Returns the old schema's output
// (its defaults applied, unknown keys of plain objects stripped), as that build would save it.

const isObj = (v) => typeof v === 'object' && v !== null;

function at(value, path) {
  let v = value;
  for (const k of path) v = isObj(v) ? v[k] : undefined;
  return v;
}

/** Repeated notes once, with a count. */
function collapse(notes) {
  const counts = new Map();
  for (const n of notes) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].map(([n, c]) => (c > 1 ? `${n} x${String(c)}` : n));
}

/**
 * @param {{ safeParse(v: unknown): any }} schema
 * @param {unknown} input
 * @returns {{ value: unknown, removed: string[] }}
 */
export function downgrade(schema, input, maxSteps = 500) {
  const value = structuredClone(input);
  const removed = [];
  for (let step = 0; step < maxSteps; step++) {
    const r = schema.safeParse(value);
    if (r.success) return { value: r.data, removed: collapse(removed) };
    const issue = r.error.issues[0];
    const path = issue.path ?? [];
    const where = (p) => p.map(String).join('.') || '(root)';
    if (issue.code === 'unrecognized_keys') {
      const target = at(value, path);
      for (const k of issue.keys) {
        if (isObj(target)) Reflect.deleteProperty(target, k);
        removed.push(`${where([...path, k])} (key)`);
      }
      continue;
    }
    // The deepest array that holds the failing value: drop that element.
    let cut = -1;
    for (let i = path.length - 1; i >= 0; i--) {
      if (Array.isArray(at(value, path.slice(0, i))) && typeof path[i] === 'number') {
        cut = i;
        break;
      }
    }
    if (cut < 0) {
      throw new Error(
        `Cannot downgrade: ${where(path)}: ${issue.message} (${issue.code}); no array element to drop.`,
      );
    }
    const arr = at(value, path.slice(0, cut));
    arr.splice(path[cut], 1);
    removed.push(`${where(path.slice(0, cut + 1))} (${issue.message})`);
  }
  throw new Error(`Cannot downgrade within ${String(maxSteps)} steps.`);
}
