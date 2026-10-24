/**
 * Find an existing issue to add a detection to as a sighting: a search over code and title, the
 * issues on the same photo or video first, arrow keys to move, Enter to pick, Esc to cancel.
 */
import { linkCandidates, type Detection } from '@aio/annotate/detections';
import type { Issue } from '@aio/schema';
import { useFocusTrap, useT } from '@aio/ui';
import { useMemo, useRef, useState } from 'react';

export function LinkPicker({
  detection,
  issues,
  onPick,
  onCancel,
}: {
  detection: Detection;
  issues: readonly Issue[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const dlg = useRef<HTMLDivElement>(null);
  useFocusTrap(dlg, true, { initial: () => input.current });
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = linkCandidates(detection, issues);
    const hits = needle
      ? all.filter((i) => `${i.code} ${i.title}`.toLowerCase().includes(needle))
      : all;
    return hits.slice(0, 50);
  }, [detection, issues, q]);
  const pick = list[Math.min(at, list.length - 1)];
  return (
    <div ref={dlg} className="det-link" role="dialog" aria-label={t('det.link.title')}>
      <input
        ref={input}
        className="ann-input"
        placeholder={t('det.link.search')}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setAt((n) => Math.min(n + 1, list.length - 1));
          else if (e.key === 'ArrowUp') setAt((n) => Math.max(0, n - 1));
          else if (e.key === 'Enter' && pick) onPick(pick.id);
          else if (e.key === 'Escape') onCancel();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      {list.length === 0 ? (
        <p className="ann-faint">{t('det.link.none')}</p>
      ) : (
        <ul className="det-link-list" role="listbox">
          {list.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                role="option"
                aria-selected={pick?.id === i.id}
                onClick={() => {
                  onPick(i.id);
                }}
              >
                <b className="mono">{i.code}</b>
                <span>{i.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="ann-btn ghost" onClick={onCancel}>
        {t('det.cancel')}
      </button>
    </div>
  );
}
