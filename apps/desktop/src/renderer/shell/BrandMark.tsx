import { brand, SYMBOL, WORDMARK } from '@aio/brand';
import { useId } from 'react';

/**
 * The Quadrion AI symbol (brand kit): four plates stepping forward as they rise, the top one lit.
 * The cuts between plates are real transparency (masks), so the mark sits on any ground. Plates
 * take `--fg-0` and the top plate `--acc` (styles.css `.mark-plate`, `.mark-top`), so it follows
 * the theme. `small` uses the small-size cut (wider gaps) for 32 px and less.
 *
 * `layered` (the launch screen) tags every plate and every cut copy of it with `data-plate`
 * (0 bottom to 3 top) and the classes `plate p1` to `p4`, so a caller can move the plates one by
 * one: each cut moves with the plate that makes it, and each mask sits on the unmoved group around
 * its plate, so the gaps stay true while the stack opens. `label` makes the symbol an image with
 * that accessible name; without it the symbol is decoration.
 */
export function BrandSymbol({
  className = 'mark',
  small = false,
  layered = false,
  label,
}: {
  className?: string;
  small?: boolean;
  layered?: boolean;
  label?: string;
}) {
  const id = `bm${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const cut = small ? SYMBOL.smallCutWidth : SYMBOL.cutWidth;
  const plates = SYMBOL.plates;
  const top = plates.length - 1;
  const tag = (i: number) => (layered ? { 'data-plate': String(i) } : {});
  const plateClass = (i: number) =>
    `${i === top ? 'mark-top' : 'mark-plate'}${layered ? ` plate p${String(i + 1)}` : ''}`;
  return (
    <svg
      className={className}
      viewBox={SYMBOL.viewBox}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
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
              {plates.slice(i + 1).map((d, j) => (
                <path
                  key={d}
                  d={d}
                  fill="#000"
                  stroke="#000"
                  strokeWidth={cut}
                  strokeLinejoin="miter"
                  {...tag(i + 1 + j)}
                />
              ))}
            </mask>
          ))}
        </defs>
        {plates.map((d, i) =>
          i === top ? (
            <path key={d} d={d} className={plateClass(i)} {...tag(i)} />
          ) : (
            <g key={d} mask={`url(#${id}-${String(i)})`}>
              <path d={d} className={plateClass(i)} {...tag(i)} />
            </g>
          ),
        )}
      </g>
    </svg>
  );
}

/**
 * The outlined wordmark, QUADRION in `--fg-0` and AI in `--acc` (no font needed). Its accessible
 * name is the product name; `decorative` hides it where the name is given beside it.
 */
export function BrandWordmark({
  className = 'wordmark',
  decorative = false,
}: {
  className?: string;
  decorative?: boolean;
}) {
  return (
    <svg
      className={className}
      viewBox={WORDMARK.viewBox}
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': brand.productName, 'data-testid': 'brand-wordmark' })}
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
