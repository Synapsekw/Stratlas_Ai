/**
 * Keyboard-first review (BLD-5). One table from keys to commands, so the help, the handler and the
 * tests agree. Keys are ignored while typing in a field.
 */
export type ReviewCommand =
  | { kind: 'next' }
  | { kind: 'prev' }
  | { kind: 'nextSource' }
  | { kind: 'prevSource' }
  | { kind: 'accept' }
  | { kind: 'link' }
  | { kind: 'reject' }
  | { kind: 'reopen' }
  | { kind: 'delete' }
  | { kind: 'uncertain' }
  | { kind: 'severity'; value: number }
  | { kind: 'class'; step: 1 | -1 }
  | { kind: 'note' }
  | { kind: 'tool'; tool: 'select' | 'box' | 'polygon' | 'rotbox' | 'point' }
  | { kind: 'mask' }
  | { kind: 'fit' }
  | { kind: 'undo' }
  | { kind: 'redo' };

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** The command for a key press, or null. */
export function reviewCommand(e: KeyLike): ReviewCommand | null {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod) {
    if (k === 'z' && !e.shiftKey) return { kind: 'undo' };
    if (k === 'y' || (k === 'z' && e.shiftKey)) return { kind: 'redo' };
    return null;
  }
  if (e.altKey) return null;
  switch (k) {
    case 'j':
    case 'ArrowRight':
    case 'ArrowDown':
      return e.shiftKey ? { kind: 'nextSource' } : { kind: 'next' };
    case 'k':
    case 'ArrowLeft':
    case 'ArrowUp':
      return e.shiftKey ? { kind: 'prevSource' } : { kind: 'prev' };
    case 'PageDown':
      return { kind: 'nextSource' };
    case 'PageUp':
      return { kind: 'prevSource' };
    case 'a':
    case 'Enter':
      return { kind: 'accept' };
    case 'l':
      return { kind: 'link' };
    case 'x':
      return { kind: 'reject' };
    case 'r':
      return e.shiftKey ? { kind: 'reopen' } : { kind: 'tool', tool: 'rotbox' };
    case 'Delete':
      return { kind: 'delete' };
    case 'u':
      return { kind: 'uncertain' };
    case 'c':
      return { kind: 'class', step: e.shiftKey ? -1 : 1 };
    case 'n':
      return { kind: 'note' };
    case 'v':
      return { kind: 'tool', tool: 'select' };
    case 'b':
      return { kind: 'tool', tool: 'box' };
    case 'p':
      return { kind: 'tool', tool: 'polygon' };
    case 'o':
      return { kind: 'tool', tool: 'point' };
    case 'm':
      return { kind: 'mask' };
    case 'f':
      return { kind: 'fit' };
    default:
      if (/^[0-9]$/.test(k)) return { kind: 'severity', value: Number(k) };
      return null;
  }
}

/** True when a key press goes to a text field, not to the review. */
export function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['checkbox', 'radio', 'range', 'button'].includes(type);
}
