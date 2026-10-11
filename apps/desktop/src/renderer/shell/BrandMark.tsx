import { brand, SYMBOL, WORDMARK } from '@aio/brand';

/**
 * The Quadrion AI symbol (brand kit): three quarters of a ring and a square tail, the lit fourth
 * piece. The quarters take `--fg-0` and the tail `--acc` (styles.css `.mark-piece`, `.mark-tail`),
 * so it follows the theme. `small` uses the small-size cut (the ring in one piece) for 32 px and
 * less. `label` makes the symbol an image with that accessible name; without it the symbol is
 * decoration. The moving mark is `BrandMotion`.
 */
export function BrandSymbol({
  className = 'mark',
  small = false,
  label,
}: {
  className?: string;
  small?: boolean;
  label?: string;
}) {
  const pieces: readonly string[] = small ? SYMBOL.small : SYMBOL.pieces;
  return (
    <svg
      className={className}
      viewBox={small ? SYMBOL.smallViewBox : SYMBOL.viewBox}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {pieces.map((d, i) => (
        <path key={d} d={d} className={i === pieces.length - 1 ? 'mark-tail' : 'mark-piece'} />
      ))}
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
