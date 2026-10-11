import { Icon } from '@aio/ui';
import { useState } from 'react';
import { PAGE_CAP, defaultPages, parsePages } from './model';
import type { PagePrompt } from './store';

/**
 * Which pages of a PDF become drawings, asked before any page is drawn: every page is its own
 * drawing, so a long document is not brought in by accident. Shown where the import panel is.
 */
export function PagesCard({ p }: { p: PagePrompt }) {
  const [text, setText] = useState(defaultPages);
  const parsed = parsePages(text, p.pages);
  const pages = 'pages' in parsed ? parsed.pages : null;
  return (
    <section className="b-import" aria-label="Pages to import" data-testid="import-pages">
      <header role="none">
        <Icon name="import" size={14} />
        Pages of {p.name}
      </header>
      <form
        className="b-heights"
        onSubmit={(e) => {
          e.preventDefault();
          if (pages) p.answer(pages);
        }}
      >
        <p className="small">
          This PDF has {String(p.pages)} pages. Each page you import becomes one drawing, and a
          drawing cannot be removed again, so type only the pages you need.
          {p.pages > PAGE_CAP &&
            ` One import takes at most ${String(PAGE_CAP)} pages; import the file again for more.`}
        </p>
        <div className="b-heights-field">
          <label>
            Pages
            <input
              type="text"
              value={text}
              aria-label="Pages to import"
              aria-invalid={pages === null}
              placeholder="1-3, 7"
              onChange={(e) => {
                setText(e.target.value);
              }}
            />
          </label>
          {'error' in parsed && (
            <p className="notice warn small" role="alert">
              <Icon name="warn" size={14} />
              {parsed.error}
            </p>
          )}
        </div>
        <div className="b-heights-actions">
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              p.answer(null);
            }}
          >
            Cancel
          </button>
          <button type="submit" className="btn primary sm" disabled={pages === null}>
            Import {pages ? `${String(pages.length)} ${pages.length === 1 ? 'page' : 'pages'}` : ''}
          </button>
        </div>
      </form>
    </section>
  );
}
