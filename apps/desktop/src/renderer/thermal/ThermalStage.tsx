/**
 * The thermal photo on the bench: the raster painted with the palette over the range, and the
 * temperature under the pointer (one decimal, °C) in a chip beside it. No raster, no numbers: a
 * photo whose temperatures are held back is never painted here (the bench shows why instead); an
 * unsupported camera's photo shows as an ordinary picture.
 */
import { useT } from '@aio/ui';
import { useEffect, useRef, useState } from 'react';
import { colourise } from './colourise';
import type { PaletteId } from './palettes';
import { tempLabel } from './PaletteBar';
import { tempAt, type ThermalRaster } from './raster';

interface Hover {
  /** The raster read: another photo drops the reading. */
  of: ThermalRaster;
  /** Where the chip sits in the stage, CSS pixels. */
  left: number;
  top: number;
  temp: number | null;
}

export function ThermalStage({
  raster,
  range,
  palette,
  plain = null,
}: {
  raster: ThermalRaster | null;
  range: [number, number] | null;
  palette: PaletteId;
  /** With no raster: the photo itself, shown as an ordinary picture (an unsupported camera). */
  plain?: string | null;
}) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !raster || !range) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(colourise(raster, range, palette), 0, 0);
  }, [raster, range, palette]);

  if (!raster)
    return plain ? (
      <div className="th-stage" data-testid="thermal-stage">
        <img className="th-photo th-plain" src={plain} alt="" data-testid="thermal-plain" />
      </div>
    ) : (
      <div className="th-stage th-stage-empty" data-testid="thermal-stage" />
    );

  return (
    <div className="th-stage" data-testid="thermal-stage">
      <canvas
        ref={canvas}
        className="th-photo"
        width={raster.width}
        height={raster.height}
        data-testid="thermal-canvas"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return;
          const x = ((e.clientX - r.left) / r.width) * raster.width;
          const y = ((e.clientY - r.top) / r.height) * raster.height;
          setHover({
            of: raster,
            left: e.clientX - r.left,
            top: e.clientY - r.top,
            temp: tempAt(raster, x, y),
          });
        }}
        onPointerLeave={() => {
          setHover(null);
        }}
      />
      {hover?.of === raster && hover.temp !== null && (
        <output
          className="th-hover"
          data-testid="thermal-hover"
          style={{
            insetInlineStart: `${String(hover.left)}px`,
            insetBlockStart: `${String(hover.top)}px`,
          }}
        >
          {tempLabel(t, hover.temp)}
        </output>
      )}
    </div>
  );
}
