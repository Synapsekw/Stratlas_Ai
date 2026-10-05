import {
  keyLabel,
  SHORTCUT_SCOPES,
  SHORTCUTS,
  t,
  type Shortcut,
  type ShortcutScope,
} from '@aio/ui';
import { useId, useState } from 'react';

interface Row {
  id: string;
  scope: ShortcutScope;
  keys: string[];
  action: string;
}

/** Every shortcut as text people search: its keys, its action and where it works. */
function rows(): Row[] {
  return (SHORTCUTS as readonly Shortcut[]).map((s) => ({
    id: s.id,
    scope: s.scope,
    keys: s.keys.map(keyLabel),
    action: t(s.label),
  }));
}

/** Rows whose keys, action or place match every word of the query. */
export function filterShortcuts(all: Row[], query: string): Row[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return all;
  const scopeName = new Map(SHORTCUT_SCOPES.map((s) => [s.scope, t(s.label).toLowerCase()]));
  return all.filter((r) => {
    const keys = r.keys.join(' ').toLowerCase();
    const hay = `${keys} ${r.action.toLowerCase()} ${scopeName.get(r.scope) ?? ''}`;
    return words.every((w) => hay.includes(w) || (w === 'escape' && keys.includes('esc')));
  });
}

/** Settings, Keyboard: the searchable keyboard map, one table per place. */
export function Keyboard() {
  const [query, setQuery] = useState('');
  const searchId = useId();
  const all = rows();
  const shown = filterShortcuts(all, query);
  return (
    <>
      <div className="sblock">
        <label className="sr-only" htmlFor={searchId}>
          {t('settings.keyboard.search')}
        </label>
        <input
          id={searchId}
          className="input"
          type="search"
          value={query}
          placeholder={t('settings.keyboard.searchHint')}
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          data-testid="keymap-search"
        />
        <p className="help" role="status" aria-live="polite" style={{ marginTop: 8 }}>
          {shown.length
            ? t('settings.keyboard.count', { count: shown.length })
            : t('settings.keyboard.none', { query })}
        </p>
      </div>
      {SHORTCUT_SCOPES.map(({ scope, label }) => {
        const mine = shown.filter((r) => r.scope === scope);
        if (!mine.length) return null;
        return (
          <div className="sblock" key={scope}>
            <h2>{t(label)}</h2>
            <table className="tbl keymap" data-testid={`keymap-${scope}`}>
              <thead>
                <tr>
                  <th scope="col">{t('settings.keyboard.key')}</th>
                  <th scope="col">{t('settings.keyboard.action')}</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.keys.map((k, i) => (
                        <span key={k}>
                          {i > 0 && <span className="faint"> {t('keys.or')} </span>}
                          <kbd className="kbd">{k}</kbd>
                        </span>
                      ))}
                    </td>
                    <td>{r.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}
