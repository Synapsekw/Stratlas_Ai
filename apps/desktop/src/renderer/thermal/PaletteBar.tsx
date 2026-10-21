/**
 * The palette bar under the thermal photo: the ramp in use between the range's ends (one decimal,
 * °C), the palette picker as swatches of the ramps themselves, and Auto range. The ramps are
 * painted from the lookup tables into canvases, so the bar shows exactly what the photo uses.
 */
import { Button, Tip, useT } from '@aio/ui';
import { useEffect, useRef } from 'react';
import { PALETTE_IDS, PALETTES, type PaletteId } from './palettes';

/** A temperature as the bench shows it: one decimal, °C. */
export function tempLabel(t: ReturnType<typeof useT>, c: number): string {
  return t('thermal.hover', { temp: c.toFixed(1) });
}

/** Paint a palette's 256 entries left to right into a 256 x 1 canvas (the CSS stretches it). */
function Ramp({ palette, className }: { palette: PaletteId; className: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx || typeof ImageData === 'undefined') return;
    ctx.putImageData(new ImageData(PALETTES[palette].slice(), 256, 1), 0, 0);
  }, [palette]);
  return <canvas ref={ref} className={className} width={256} height={1} aria-hidden="true" />;
}

export function PaletteBar({
  palette,
  range,
  rangeAuto,
  onPalette,
  onAuto,
}: {
  palette: PaletteId;
  range: [number, number] | null;
  rangeAuto: boolean;
  onPalette: (p: PaletteId) => void;
  onAuto: () => void;
}) {
  const t = useT();
  return (
    <div className="th-bar">
      <div className="th-scale">
        <span className="th-end" data-testid="thermal-range-min">
          {range ? tempLabel(t, range[0]) : ''}
        </span>
        <Ramp palette={palette} className="th-ramp" />
        <span className="th-end" data-testid="thermal-range-max">
          {range ? tempLabel(t, range[1]) : ''}
        </span>
      </div>
      <div className="th-bar-tools">
        <div className="th-swatches" role="group">
          {PALETTE_IDS.map((id) => (
            <Tip key={id} content={t(`thermal.palette.${id}`)} repeatsName>
              <button
                type="button"
                className="th-swatch"
                aria-label={t(`thermal.palette.${id}`)}
                aria-pressed={id === palette}
                data-testid={`thermal-palette-${id}`}
                onClick={() => {
                  onPalette(id);
                }}
              >
                <Ramp palette={id} className="th-swatch-ramp" />
              </button>
            </Tip>
          ))}
        </div>
        <Button
          variant="quiet"
          pressed={rangeAuto}
          onClick={onAuto}
          data-testid="thermal-range-auto"
        >
          {t('thermal.range.auto')}
        </Button>
      </div>
    </div>
  );
}
