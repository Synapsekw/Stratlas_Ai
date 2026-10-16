import type { ReactElement, ReactNode } from 'react';
import { useResizableSplit, type SplitOptions } from './useResizableSplit';

export interface ResizableSplitProps extends SplitOptions {
  label: string; // the separator's accessible name, e.g. "Resize the library"
  start: ReactNode;
  end: ReactNode;
  className?: string;
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
      <div {...separatorProps} aria-label={label}>
        <span className="kbd split-readout" aria-hidden="true" />
      </div>
      <div className="split-pane" id={options.sized === 'end' ? paneId : undefined}>
        {end}
      </div>
    </div>
  );
}
