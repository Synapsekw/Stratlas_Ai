export interface CompassProps {
  /** View heading, degrees clockwise from north. */
  headingDeg: number;
  label?: string;
  className?: string;
}

const OV = 'oklch(0.96 0.008 250)';
const OVF = 'oklch(0.96 0.008 250 / .28)';
const OVD = 'oklch(0.96 0.008 250 / .55)';
const ACC = 'oklch(0.79 0.115 172)';
const TICKS = Array.from({ length: 24 }, (_, i) => i * 15);

/** Stage compass: a rotating rose with the north arrow and the heading readout. */
export function Compass({ headingDeg, label = 'N', className }: CompassProps) {
  const h = ((headingDeg % 360) + 360) % 360;
  return (
    <svg
      className={className ? `compass ${className}` : 'compass'}
      viewBox="0 0 64 64"
      role="img"
      aria-label={`Heading ${Math.round(h)} degrees`}
    >
      <circle cx="32" cy="32" r="27" fill="oklch(0.13 0.01 250 / .78)" stroke={OVF} />
      <g transform={`rotate(${-h} 32 32)`}>
        {TICKS.map((a) => (
          <line
            key={a}
            x1="32"
            y1="5"
            x2="32"
            y2={a % 90 === 0 ? 12 : 9}
            stroke={a % 90 === 0 ? OV : OVF}
            strokeWidth="1"
            transform={`rotate(${a} 32 32)`}
          />
        ))}
        <path d="M32 9 L36 19 L32 17 L28 19 Z" fill={ACC} />
        <text
          x="32"
          y="30"
          textAnchor="middle"
          fill={OV}
          fontSize="9"
          fontWeight="600"
          transform={`rotate(${h} 32 27)`}
        >
          {label}
        </text>
      </g>
      <text x="32" y="44" textAnchor="middle" fill={OVD} fontSize="9" fontWeight="500">
        {String(Math.round(h) % 360).padStart(3, '0')}°
      </text>
    </svg>
  );
}
