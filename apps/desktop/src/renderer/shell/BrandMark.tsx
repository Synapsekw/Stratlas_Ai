import { brand, SYMBOL, WORDMARK } from '@aio/brand';
import { useId } from 'react';

/**
 * The Quadrion AI symbol (brand kit): four plates stepping forward as they rise, the top one lit.
 * The cuts between plates are real transparency (masks), so the mark sits on any ground. Plates
 * take `--fg-0` and the top plate `--acc` (styles.css `.mark-plate`, `.mark-top`), so it follows
 * the theme. `small` uses the small-size cut (wider gaps) for 32 px and less.
 */
export function BrandSymbol({
  className = 'mark',
  small = false,
}: {
  className?: string;
  small?: boolean;
}) {
  const id = `bm${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const cut = small ? SYMBOL.smallCutWidth : SYMBOL.cutWidth;
  const plates = SYMBOL.plates;
  const top = plates.length - 1;
  return (
    <svg className={className} viewBox={SYMBOL.viewBox} aria-hidden="true">
      <g transform={SYMBOL.transform}>
        <defs>
          {plates.slice(0, top).map((_, i) => (
            <mask
              key={i}
              id={`${id}-${String(i)}`}
              maskUnits="userSpaceOnUse"
              x="-16"
              y="-16"
              width="96"
              height="96"
            >
              <rect x="-16" y="-16" width="96" height="96" fill="#fff" />
              {plates.slice(i + 1).map((d) => (
                <path
                  key={d}
                  d={d}
                  fill="#000"
                  stroke="#000"
                  strokeWidth={cut}
                  strokeLinejoin="miter"
                />
              ))}
            </mask>
          ))}
        </defs>
        {plates.map((d, i) =>
          i === top ? (
            <path key={d} d={d} className="mark-top" />
          ) : (
            <path key={d} d={d} className="mark-plate" mask={`url(#${id}-${String(i)})`} />
          ),
        )}
      </g>
    </svg>
  );
}

/**
 * The outlined wordmark, QUADRION in `--fg-0` and AI in `--acc` (no font needed). Its accessible
 * name is the product name.
 */
export function BrandWordmark({ className = 'wordmark' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox={WORDMARK.viewBox}
      role="img"
      aria-label={brand.productName}
      data-testid="brand-wordmark"
    >
      <g transform={WORDMARK.transform}>
        <path d={WORDMARK.quadrion} className="wm-word" />
        <path d={WORDMARK.ai} className="wm-ai" />
      </g>
    </svg>
  );
}

/** Symbol beside the wordmark: the horizontal lockup. */
export function BrandLockup({ className = 'lockup' }: { className?: string }) {
  return (
    <span className={className}>
      <BrandSymbol className="lockup-mark" />
      <BrandWordmark className="lockup-word" />
    </span>
  );
}
