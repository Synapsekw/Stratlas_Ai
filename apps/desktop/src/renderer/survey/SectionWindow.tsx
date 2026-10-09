/**
 * The cross-section in a large window (M11 G5): the "pop-out" of the dock. The app has no
 * renderer pop-out windows of its own (popups only open project files in a viewer), so this is a
 * large modal over the workspace with the same chart, pins and controls; Esc or Close returns the
 * section to the dock.
 */
import { Icon, useFocusTrap } from '@aio/ui';
import { useRef } from 'react';
import { SectionBody } from './SectionBody';
import { setWindow, useSection } from './sectionStore';

export function SectionWindow() {
  const label = useSection((s) => s.source?.label ?? 'Section');
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    setWindow(false);
  };
  useFocusTrap(ref, true, { onEscape: close });
  return (
    <div
      ref={ref}
      className="sv-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="sec-window-title"
      data-testid="section-window"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="sv-dialog sec-window">
        <header className="sv-head" role="none">
          <h2 id="sec-window-title">
            <Icon name="section" size={14} /> {label}
          </h2>
          <button
            type="button"
            className="btn ghost sm"
            aria-label="Back to the dock"
            onClick={close}
          >
            <Icon name="x" size={14} />
          </button>
        </header>
        <SectionBody big />
      </div>
    </div>
  );
}
