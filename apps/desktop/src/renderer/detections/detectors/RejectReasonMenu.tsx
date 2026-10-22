import type { RejectReason } from '@aio/schema';
import { Popover, useT, type MessageKey } from '@aio/ui';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from 'react';

export interface RejectReasonMenuProps {
  open: boolean;
  /** The reject button the menu hangs from. */
  opener: RefObject<HTMLElement | null>;
  /** `null` is "Reject without a reason"; `note` comes with "Looks like it but is not". */
  onPick: (reason: RejectReason | null, note?: string) => void;
  onClose: () => void;
}

const ITEMS: { reason: RejectReason; label: MessageKey }[] = [
  { reason: 'looks-like-but-is-not', label: 'detect.preset.reject.looksLike' },
  { reason: 'not-a-defect', label: 'detect.preset.reject.notDefect' },
  { reason: 'wrong-class', label: 'detect.preset.reject.wrongClass' },
  { reason: 'box-wrong', label: 'detect.preset.reject.boxWrong' },
  { reason: 'other', label: 'detect.preset.reject.other' },
];

/** Why a detector's draft is rejected: the reasons the ledger learns from, or none. */
export function RejectReasonMenu({
  open,
  opener,
  onPick,
  onClose,
}: RejectReasonMenuProps): ReactElement {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState('');
  const noteRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (asking) noteRef.current?.focus();
  }, [asking]);
  const reset = () => {
    setAsking(false);
    setText('');
  };
  const done = (reason: RejectReason | null, note?: string) => {
    reset();
    onClose();
    if (note) onPick(reason, note);
    else onPick(reason);
  };
  // keys typed here are the menu's, not the review's shortcuts
  const stop = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') e.stopPropagation();
  };
  return (
    <Popover
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      opener={opener}
      anchor="below"
      className="det-vlm-menu"
    >
      <div role="menu" aria-label={t('detect.preset.reject.title')} onKeyDown={stop}>
        {ITEMS.map((it) => (
          <button
            key={it.reason}
            type="button"
            role="menuitem"
            className="row"
            data-kind="menu"
            onClick={() => {
              if (it.reason === 'looks-like-but-is-not') setAsking(true);
              else done(it.reason);
            }}
          >
            <span className="row-label">{t(it.label)}</span>
          </button>
        ))}
        {asking && (
          <input
            className="ann-input det-vlm-note"
            ref={noteRef}
            value={text}
            placeholder={t('detect.preset.reject.notePlaceholder')}
            aria-label={t('detect.preset.reject.notePlaceholder')}
            onChange={(e) => {
              setText(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              done('looks-like-but-is-not', text.trim());
            }}
          />
        )}
        <div className="menu-sep" role="separator" />
        <button
          type="button"
          role="menuitem"
          className="row"
          data-kind="menu"
          onClick={() => {
            done(null);
          }}
        >
          <span className="row-label">{t('detect.preset.reject.none')}</span>
        </button>
      </div>
    </Popover>
  );
}
