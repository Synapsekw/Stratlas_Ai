import { REJECT_NOTE_MAX } from '@aio/annotate/detections';
import type { RejectReason } from '@aio/schema';
import { Menu, useT, type MenuEntry, type MessageKey } from '@aio/ui';
import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import './detectors.css';

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
}: RejectReasonMenuProps): ReactElement | null {
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
  const items: MenuEntry[] = [
    ...ITEMS.map((it): MenuEntry =>
      it.reason === 'looks-like-but-is-not'
        ? {
            id: it.reason,
            label: t(it.label),
            // stays open: the field under the list asks what it is
            keepOpen: true,
            onSelect: () => {
              setAsking(true);
            },
          }
        : {
            id: it.reason,
            label: t(it.label),
            onSelect: () => {
              done(it.reason);
            },
          },
    ),
    'separator',
    {
      id: 'none',
      label: t('detect.preset.reject.none'),
      onSelect: () => {
        done(null);
      },
    },
  ];
  return (
    <Menu
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      opener={opener}
      anchor="below"
      label={t('detect.preset.reject.title')}
      items={items}
      after={
        asking && (
          <input
            className="ann-input det-vlm-note"
            ref={noteRef}
            value={text}
            maxLength={REJECT_NOTE_MAX}
            placeholder={t('detect.preset.reject.notePlaceholder')}
            aria-label={t('detect.preset.reject.notePlaceholder')}
            onChange={(e) => {
              setText(e.target.value);
            }}
            onKeyDown={(e) => {
              // keys typed here are the note's, not the review's shortcuts
              if (e.key !== 'Escape') e.stopPropagation();
              if (e.key !== 'Enter') return;
              e.preventDefault();
              done('looks-like-but-is-not', text.trim());
            }}
          />
        )
      }
    />
  );
}
