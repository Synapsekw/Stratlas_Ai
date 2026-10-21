/**
 * What RFC 8785 (JCS) cannot hash the same way in every reader: a key twice in one object (one
 * parser keeps the first, another the last), a lone surrogate (no UTF-8 form) and a number that is
 * not finite or an integer past 2^53 (rounded on parse, so the hash covers another value). The
 * text must already be valid JSON (`JSON.parse` succeeded). Null when it is fine; else the reason.
 */
export function strictJsonProblem(text: string): string | null {
  // one entry per open container: the keys seen in an object, null for an array
  const stack: (Set<string> | null)[] = [];
  let expectKey = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x7b) {
      stack.push(new Set());
      expectKey = true;
      i += 1;
    } else if (c === 0x5b) {
      stack.push(null);
      expectKey = false;
      i += 1;
    } else if (c === 0x7d || c === 0x5d) {
      stack.pop();
      expectKey = false;
      i += 1;
    } else if (c === 0x2c) {
      expectKey = stack.length > 0 && stack[stack.length - 1] !== null;
      i += 1;
    } else if (c === 0x22) {
      let j = i + 1;
      let escaped = false;
      for (;;) {
        const d = text.charCodeAt(j);
        if (d === 0x22 || Number.isNaN(d)) break;
        if (d === 0x5c) {
          escaped = true;
          j += 2;
        } else j += 1;
      }
      const value = escaped ? (JSON.parse(text.slice(i, j + 1)) as string) : text.slice(i + 1, j);
      if (hasLoneSurrogate(value)) return 'It holds a lone surrogate, which has no UTF-8 form.';
      if (expectKey) {
        const keys = stack[stack.length - 1];
        if (keys?.has(value)) return `It names the key "${value}" twice in one object.`;
        keys?.add(value);
        expectKey = false;
      }
      i = j + 1;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      let j = i + 1;
      while (j < n && isNumberChar(text.charCodeAt(j))) j += 1;
      const token = text.slice(i, j);
      const v = Number(token);
      if (!Number.isFinite(v)) return `The number ${token} is out of range.`;
      if (Number.isInteger(v) && !Number.isSafeInteger(v)) {
        return `The number ${token} is beyond 2^53 and cannot be read exactly.`;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  return null;
}

function isNumberChar(c: number): boolean {
  // digits, '.', 'e', 'E', '+', '-'
  return (
    (c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x65 || c === 0x45 || c === 0x2b || c === 0x2d
  );
}

const SURROGATE = /[\uD800-\uDFFF]/;

function hasLoneSurrogate(s: string): boolean {
  if (!SURROGATE.test(s)) return false;
  for (let k = 0; k < s.length; k += 1) {
    const u = s.charCodeAt(k);
    if (u >= 0xd800 && u <= 0xdbff) {
      const next = s.charCodeAt(k + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      k += 1;
    } else if (u >= 0xdc00 && u <= 0xdfff) return true;
  }
  return false;
}

/** `JSON.parse` that also refuses what `strictJsonProblem` names. */
export function parseStrictJson(text: string): unknown {
  const value = JSON.parse(text) as unknown;
  const problem = strictJsonProblem(text);
  if (problem) throw new Error(problem);
  return value;
}
