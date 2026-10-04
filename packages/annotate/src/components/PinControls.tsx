import { useWorkspace } from '@aio/workspace';
import { useMemo } from 'react';
import type { PinFilter } from '../tools/declutter';
import { pinDisplay, usePinDisplay } from '../tools/pinDisplay';
import { AnnotateStyles } from './styles';

/** Severity levels above the lowest across the project's models: the "and above" choices. */
function useThresholds(): number[] {
  const models = useWorkspace((s) => s.project?.manifest.severityModels);
  return useMemo(() => {
    const values = [...new Set((models ?? []).flatMap((m) => m.levels.map((l) => l.value)))];
    values.sort((a, b) => a - b);
    return values.slice(1);
  }, [models]);
}

const HINT: Record<'all' | 'off' | 'min', string> = {
  all: 'Every issue. Close pins merge into count badges; click a badge to expand it.',
  min: 'Graded issues at this severity or worse. The selected issue always shows.',
  off: 'No pins; the selected issue still shows.',
};

/**
 * Pins: All, Severity N and above, or Off, plus the severity heat map. Drives the 3D overlay
 * and the map markers through `pinDisplay`.
 */
export function PinControls({ className }: { className?: string }) {
  const filter = usePinDisplay((s) => s.filter);
  const heat = usePinDisplay((s) => s.heat);
  const thresholds = useThresholds();
  const choices: { f: PinFilter; text: string; label: string }[] = [
    { f: 'all', text: 'All', label: 'All pins' },
    ...thresholds.map((n) => ({ f: n, text: `≥ ${n}`, label: `Severity ${n} and above` })),
    { f: 'off', text: 'Off', label: 'No pins' },
  ];
  const set = (f: PinFilter) => {
    pinDisplay.getState().setFilter(f);
  };
  return (
    <div className={`ann-pins ${className ?? ''}`}>
      <AnnotateStyles />
      <div className="ann-seg" role="group" aria-label="Issue pins">
        {choices.map((c) => (
          <button
            key={String(c.f)}
            type="button"
            aria-label={c.label}
            title={c.label}
            aria-pressed={filter === c.f}
            onClick={() => {
              set(c.f);
            }}
          >
            {c.text}
          </button>
        ))}
      </div>
      <label className="ann-check">
        <input
          type="checkbox"
          checked={heat}
          onChange={(e) => {
            pinDisplay.getState().setHeat(e.target.checked);
          }}
        />
        Severity heat map
      </label>
      <p className="ann-faint">{HINT[typeof filter === 'number' ? 'min' : filter]}</p>
    </div>
  );
}
