/**
 * Keyboard-first review (BLD-5). The keys live in the shortcut registry (@aio/ui, scope `review`),
 * so the keyboard map in Settings, the handler and the tests agree. Keys are ignored while typing
 * in a field.
 */
import { matchShortcut, type KeyLike, type ShortcutId } from '@aio/ui';

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

export type { KeyLike };

/** Registry shortcut (Settings, Keyboard) to review command. */
const COMMANDS: Partial<Record<ShortcutId, ReviewCommand>> = {
  'review.next': { kind: 'next' },
  'review.prev': { kind: 'prev' },
  'review.nextSource': { kind: 'nextSource' },
  'review.prevSource': { kind: 'prevSource' },
  'review.accept': { kind: 'accept' },
  'review.link': { kind: 'link' },
  'review.reject': { kind: 'reject' },
  'review.reopen': { kind: 'reopen' },
  'review.delete': { kind: 'delete' },
  'review.uncertain': { kind: 'uncertain' },
  'review.classNext': { kind: 'class', step: 1 },
  'review.classPrev': { kind: 'class', step: -1 },
  'review.note': { kind: 'note' },
  'review.select': { kind: 'tool', tool: 'select' },
  'review.box': { kind: 'tool', tool: 'box' },
  'review.rotbox': { kind: 'tool', tool: 'rotbox' },
  'review.polygon': { kind: 'tool', tool: 'polygon' },
  'review.point': { kind: 'tool', tool: 'point' },
  'review.mask': { kind: 'mask' },
  'review.fit': { kind: 'fit' },
  'review.undo': { kind: 'undo' },
  'review.redo': { kind: 'redo' },
};

/** The command for a key press, or null (keys from the shortcut registry, scope `review`). */
export function reviewCommand(e: KeyLike): ReviewCommand | null {
  const id = matchShortcut('review', e);
  if (id === null) return null;
  if (id === 'review.severity') return { kind: 'severity', value: Number(e.key) };
  return COMMANDS[id] ?? null;
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
