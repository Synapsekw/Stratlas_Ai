import type { ReactElement } from 'react';

export interface ThresholdSliderProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** The slider's accessible name. */
  label: string;
  onChange: (value: number) => void;
}

/** A native range input for a detector's bar, styled with tokens (`detectors.css`). */
export function ThresholdSlider({
  value,
  min = 0.3,
  max = 0.95,
  step = 0.05,
  label,
  onChange,
}: ThresholdSliderProps): ReactElement {
  return (
    <input
      type="range"
      className="det-vlm-slider"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      // the slider's keys (arrows, Home, End) are its own, not the review's shortcuts
      onKeyDown={(e) => {
        e.stopPropagation();
      }}
      onChange={(e) => {
        onChange(Number(e.target.value));
      }}
    />
  );
}
