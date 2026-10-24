/**
 * The cross-section in a larger panel (M11 G5; spec section 4): the "pop-out" of the dock. Not a
 * modal: no scrim and no focus trap, a panel over the lower part of the stage so the linked hover
 * marker on the line stays visible above it, and the 3D view and the map stay usable. Esc (a pin
 * on the section first) or Close returns the section to the dock.
 */
import { Icon, useT } from '@aio/ui';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { linkedHover } from './linkedHover';
import { SectionBody } from './SectionBody';
import { setWindow, useSection } from './sectionStore';
import { taken as escapeTaken } from './stageEscape';

export function SectionWindow() {
  const t = useT();
  const label = useSection((s) => s.source?.label ?? 'Section');
  // set over the stage (the 3D view, the map and the split); without one it floats on the window
  const [stage] = useState(() => document.querySelector<HTMLElement>('.stage'));
  const close = () => {
    setWindow(false);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // a field, a dialog, a menu, a drawing or the chart that took the Esc keeps it (the
      // stage's own rules)
      if (e.key !== 'Escape' || escapeTaken(e)) return;
      // taken here: the stage's Esc (a pin elsewhere, the open pile) waits for the next one
      e.preventDefault();
      const h = linkedHover.getState();
      if (h.pin?.key === 'section') h.setPin(null);
      else setWindow(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  const panel = (
    <section
      className={`sv-card sec-window${stage ? '' : ' is-floating'}`}
      role="region"
      aria-labelledby="sec-window-title"
      data-testid="section-window"
    >
      <header className="sv-head">
        <h2 id="sec-window-title">
          <Icon name="section" size={14} /> {label}
        </h2>
        <button
          type="button"
          className="btn ghost sm"
          data-testid="section-window-close"
          aria-label={t('section.close')}
          onClick={close}
        >
          <Icon name="x" size={14} />
        </button>
      </header>
      <SectionBody big />
    </section>
  );
  return stage ? createPortal(panel, stage) : panel;
}
