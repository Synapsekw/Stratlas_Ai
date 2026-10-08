/**
 * The cross-section dock (M11 G5, SRV-7): docked under the view whenever a **Section** measurement
 * is focused (or a station of the active alignment is shown). One coloured line per surface, pins
 * with each surface's elevation, its delta to the reference surface and the grade in degrees,
 * percent and 1:n; vertical exaggeration 1:1 to 1:20; cut and fill shading between two lines;
 * **Enable cutaway** cuts the 3D view along the section; **Download** as DXF or CSV through the
 * `survey.section` job; the larger window (`SectionWindow`) shows the same section.
 */
import type { EngineStage } from '@aio/engine';
import { cutawayPlane } from '@aio/survey';
import { Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect } from 'react';
import { measureStore } from './measureStore';
import { SectionBody } from './SectionBody';
import {
  closeSection,
  isDismissed,
  loadSectionSources,
  openSection,
  sectionStore,
  setWindow,
  useSection,
} from './sectionStore';
import { SectionWindow } from './SectionWindow';
import './section.css';

/** Follow the focused Section measurement: its line opens the dock. */
function useFollowMeasurement(): void {
  useEffect(() => {
    const follow = () => {
      const s = measureStore.getState();
      const m = s.file.measurements.find((x) => x.id === s.focus);
      if (m?.tool !== 'section' || m.points.length < 2) return;
      const line = (s.editing && s.focus === m.id ? s.editing.points : m.points).map(
        (p) => [p[0], p[1]] as [number, number],
      );
      openSection(line, { kind: 'measurement', id: m.id, label: m.label });
    };
    follow();
    return measureStore.subscribe((s, prev) => {
      if (s.focus !== prev.focus || s.file !== prev.file || s.editing !== prev.editing) follow();
    });
  }, []);
}

/** Cut the 3D view along the section while **Enable cutaway** is on. */
function useCutaway(stage: EngineStage | null): void {
  const on = useSection((s) => s.cutaway && !isDismissed(s));
  const line = useSection((s) => s.line);
  const origin = useWorkspace((s) => s.project?.manifest.origin ?? null);
  useEffect(() => {
    if (!stage || !on || !line || !origin) return;
    const c = stage.sectionOrigin();
    const plane = cutawayPlane(line, [origin[0], origin[1]], { x: c.x, z: c.z });
    if (!plane) return;
    stage.setSection({ enabled: true, mode: 'vertical', ...plane, flip: false });
    return () => {
      stage.setSection({ enabled: false });
    };
  }, [stage, on, line, origin]);
}

/** The dock under the view, mounted with the measurements (`MeasureLayer`). */
export function SectionDock({ stage }: { stage: EngineStage | null }) {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const shown = useSection((s) => s.line !== null && !isDismissed(s));
  const label = useSection((s) => s.source?.label ?? 'Section');
  const busy = useSection((s) => s.busy);
  const windowOpen = useSection((s) => s.window);
  useFollowMeasurement();
  useCutaway(stage);
  useEffect(() => {
    if (projectId) void loadSectionSources(projectId);
    else sectionStore.setState({ line: null, source: null, projectId: null });
  }, [projectId]);
  if (!shown) return null;
  return (
    <>
      <section
        className="sv-card sec-dock"
        aria-label={`Cross-section ${label}`}
        data-testid="section-dock"
      >
        <header className="sv-head">
          <h2>
            <Icon name="section" size={14} /> {label}
          </h2>
          {busy && <span className="small faint">Sampling…</span>}
          <button
            type="button"
            className="btn ghost sm"
            data-testid="section-popout"
            aria-label="Open the section in a large window"
            onClick={() => {
              setWindow(true);
            }}
          >
            <Icon name="maximize" size={14} />
          </button>
          <button
            type="button"
            className="btn ghost sm"
            aria-label="Close the section"
            onClick={closeSection}
          >
            <Icon name="x" size={14} />
          </button>
        </header>
        {!windowOpen && <SectionBody />}
        {windowOpen && <p className="small faint">The section is open in the large window.</p>}
      </section>
      {windowOpen && <SectionWindow />}
    </>
  );
}
