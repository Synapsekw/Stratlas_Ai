import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, type IconName } from '../icons/Icon';
import { rankCommands, type Command } from './rank';

export interface PaletteCommand extends Command {
  icon?: IconName;
}

export interface CommandPaletteProps {
  commands: readonly PaletteCommand[];
  onClose: () => void;
  placeholder?: string;
}

/** Ctrl+K palette over projects, layers, issues and actions. Mount it only while open. */
export function CommandPalette({ commands, onClose, placeholder }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const results = useMemo(
    () => rankCommands(commands, query) as PaletteCommand[],
    [commands, query],
  );
  const index = Math.min(active, Math.max(results.length - 1, 0));

  useEffect(() => {
    inputRef.current?.focus();
    const prev = document.activeElement as HTMLElement | null;
    return () => {
      prev?.focus();
    };
  }, []);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const run = (c: PaletteCommand | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((index + 1) % Math.max(results.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((index - 1 + results.length) % Math.max(results.length, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  // Group headings only for an empty query; a ranked list reads better flat with hints.
  const grouped = !query.trim();
  const headings = results.map((c, i) =>
    grouped && (i === 0 || results[i - 1]?.group !== c.group) ? c.group : null,
  );

  return (
    <div
      className="cmdk-scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command search">
        <div className="cmdk-in">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            placeholder={placeholder ?? 'Search projects, layers, issues and actions'}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[index] ? `${listId}-${index}` : undefined}
            spellCheck={false}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="cmdk-list" id={listId} role="listbox" ref={listRef}>
          {results.length === 0 && <div className="cmdk-empty">Nothing matches “{query}”.</div>}
          {results.map((c, i) => {
            const heading = headings[i];
            return (
              <div key={c.id} role="presentation">
                {heading && (
                  <div className="cmdk-grp caps" role="presentation">
                    {heading}
                  </div>
                )}
                <button
                  type="button"
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === index}
                  className="cmdk-item"
                  onPointerMove={() => {
                    if (i !== index) setActive(i);
                  }}
                  onClick={() => {
                    run(c);
                  }}
                >
                  <Icon name={c.icon ?? 'chev-r'} />
                  <span className="ct">{c.title}</span>
                  <span className="ch">{grouped ? c.hint : (c.hint ?? c.group)}</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="cmdk-foot">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span>
            Move
          </span>
          <span>
            <span className="kbd">Enter</span>
            Run
          </span>
          <span>
            <span className="kbd">Esc</span>
            Close
          </span>
        </div>
      </div>
    </div>
  );
}
