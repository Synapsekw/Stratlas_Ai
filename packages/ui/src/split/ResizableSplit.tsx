import type { HTMLAttributes, ReactElement, ReactNode } from 'react';
import {
  useResizableSplit,
  type ResizableSplitState,
  type SplitOptions,
} from './useResizableSplit';

export interface ResizableSplitProps extends SplitOptions {
  label: string; // the separator's accessible name, e.g. "Resize the library"
  start: ReactNode;
  end: ReactNode;
  className?: string;
}

export interface SplitHandleProps extends HTMLAttributes<HTMLDivElement> {
  separatorProps: ResizableSplitState['separatorProps'];
  label: string; // the separator's accessible name
}

/**
 * The handle on a split's shared edge, with its size readout: what `ResizableSplit` draws, for a
 * layout that places the panes itself. Props after `separatorProps` (`hidden`, `onDoubleClick`)
 * override the hook's.
 */
export function SplitHandle({ separatorProps, label, ...rest }: SplitHandleProps): ReactElement {
  return (
    <div {...separatorProps} {...rest} aria-label={label}>
      <span className="kbd split-readout" aria-hidden="true" />
    </div>
  );
}

/**
 * Two panes and one handle on their shared edge: drag, arrow keys, double-click to reset and,
 * with a `collapsedSize`, collapse. Styles in `parts/split.css`.
 */
export function ResizableSplit({
  label,
  start,
  end,
  className,
  ...options
}: ResizableSplitProps): ReactElement {
  const { containerRef, separatorProps } = useResizableSplit(options);
  const paneId = separatorProps['aria-controls'];
  return (
    <div ref={containerRef} className={className ? `split ${className}` : 'split'}>
      <div className="split-pane" id={options.sized === 'start' ? paneId : undefined}>
        {start}
      </div>
      <SplitHandle separatorProps={separatorProps} label={label} />
      <div className="split-pane" id={options.sized === 'end' ? paneId : undefined}>
        {end}
      </div>
    </div>
  );
}
