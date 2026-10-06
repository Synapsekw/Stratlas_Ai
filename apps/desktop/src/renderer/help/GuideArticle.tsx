/**
 * Renders parsed guide Markdown as React elements (help panel and printed guide). Text is only
 * ever text: no HTML from the source reaches the DOM.
 */
import { Fragment, type ReactNode } from 'react';
import { resolveImage } from './guide';
import type { Block, Inline } from './markdown';
import type { HelpTopic } from './store';

/** DOM id of a heading in the rendered guide (unique across chapters). */
export const anchorId = (chapter: string, anchor: string) => `guide-${chapter}-${anchor}`;

/** Where a link in chapter `from` points: another place in the guide, or nowhere (external). */
export function linkTarget(href: string, from: string): HelpTopic | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const [file = '', anchor = ''] = href.split('#');
  const name = file.split('/').pop() ?? '';
  const m = /^(?:\d+-)?([a-z0-9-]+)\.md$/.exec(name);
  const chapter = file ? (m?.[1] ?? null) : from;
  if (!chapter) return null;
  return anchor ? { chapter, anchor } : { chapter };
}

interface Props {
  chapter: string;
  blocks: Block[];
  onNavigate?: (topic: HelpTopic) => void;
  images?: Record<string, string>;
  /** Leave out the chapter's own # title. */
  skipTitle?: boolean;
  /** Load every image at once (the printed guide), not as it scrolls into view. */
  eager?: boolean;
}

export function GuideArticle({ chapter, blocks, onNavigate, images, skipTitle, eager }: Props) {
  const inline = (nodes: Inline[]): ReactNode =>
    nodes.map((n, i) => {
      switch (n.kind) {
        case 'text':
          return <Fragment key={i}>{n.text}</Fragment>;
        case 'strong':
          return <strong key={i}>{inline(n.children)}</strong>;
        case 'em':
          return <em key={i}>{inline(n.children)}</em>;
        case 'code':
          return <code key={i}>{n.text}</code>;
        case 'link': {
          const target = linkTarget(n.href, chapter);
          if (!target || !onNavigate)
            return (
              <span key={i} className="guide-ext">
                {inline(n.children)}
              </span>
            );
          // A link inside this chapter can point at its heading; one into another chapter has no
          // element on the page to name, so it is a link by role (an in-page href to a missing
          // target is a broken skip link to screen readers, axe skip-link).
          if (target.chapter === chapter && target.anchor)
            return (
              <a
                key={i}
                href={`#${anchorId(target.chapter, target.anchor)}`}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(target);
                }}
              >
                {inline(n.children)}
              </a>
            );
          return (
            <a
              key={i}
              role="link"
              tabIndex={0}
              onClick={() => {
                onNavigate(target);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                onNavigate(target);
              }}
            >
              {inline(n.children)}
            </a>
          );
        }
      }
    });

  const block = (b: Block, i: number): ReactNode => {
    switch (b.kind) {
      case 'heading': {
        if (b.level === 1 && skipTitle) return null;
        const H = `h${String(b.level)}` as 'h1' | 'h2' | 'h3' | 'h4';
        return (
          <H key={i} id={anchorId(chapter, b.id)}>
            {inline(b.children)}
          </H>
        );
      }
      case 'paragraph':
        return <p key={i}>{inline(b.children)}</p>;
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={j}>
            {inline(it.children)}
            {it.sub && block(it.sub, 0)}
          </li>
        ));
        return b.ordered ? (
          <ol key={i} start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      }
      case 'quote':
        return (
          <aside key={i} className="guide-tip">
            {b.blocks.map(block)}
          </aside>
        );
      case 'code':
        return (
          <pre key={i}>
            <code>{b.text}</code>
          </pre>
        );
      case 'table':
        return (
          <table key={i}>
            <thead>
              <tr>
                {b.head.map((c, j) => (
                  <th key={j}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        );
      case 'image': {
        const src = resolveImage(b.src, images);
        if (!src) return null;
        return (
          <figure key={i}>
            <img src={src} alt={b.alt} loading={eager ? 'eager' : 'lazy'} />
            {b.alt && <figcaption>{b.alt}</figcaption>}
          </figure>
        );
      }
      case 'rule':
        return <hr key={i} />;
    }
  };

  return <>{blocks.map(block)}</>;
}
