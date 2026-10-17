/**
 * The Annotate workbench (stage island D12): the annotation tools on the model, the cloud and the
 * map, and the findings still in draft. The tools used to sit in a bar under the island; they live
 * here now. Starting annotating (A, or the island) opens this tab as a live tool tab, and closing
 * the tools closes it again (D13).
 */
import { AnnotationToolbar, type MapDraw } from '@aio/annotate';
import type { MapDrawMode } from '@aio/maps';
import { Button, EmptyState, Row, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { useEffect, useRef } from 'react';
import { shell, useShell } from '../../../shell';
import { primaryScene } from '../../compare';
import { Section } from '../Section';
import { workbench } from '../workbenchStore';
import { useAnnotateStage, useMapDrawHandle } from './annotateStage';
import './benches.css';

const MAP_MODES: { mode: MapDrawMode; label: string; tip: string }[] = [
  { mode: 'point', label: 'Point', tip: 'Map point' },
  { mode: 'line', label: 'Line', tip: 'Map line (double-click or Enter to finish)' },
  { mode: 'polygon', label: 'Area', tip: 'Map area (double-click or Enter to close)' },
];

/**
 * A on, the tools' tab opens as a live tab in front, and a folded sidebar unfolds (the tools are
 * in it); A off, the tab goes away if the tools opened it. Mounted with the sidebar.
 */
export function useAnnotateFollow(): void {
  const annotating = useShell((s) => s.annotating);
  const was = useRef(false);
  useEffect(() => {
    if (annotating === was.current) return;
    was.current = annotating;
    if (annotating) {
      if (shell.getState().rightCollapsed) shell.getState().setRight(false);
      workbench.getState().toolStarted('annotate');
    } else workbench.getState().toolStopped('annotate');
  }, [annotating]);
}

/**
 * Point, line and area drawing on the map: the buttons only. Enter and Backspace (finish, undo)
 * and Esc (stop) are the stage's (annotateStage.ts), so they work whichever tab is in front.
 */
export function MapDrawTools({ draw }: { draw: MapDraw }) {
  const { mode, setMode } = draw;
  return (
    <div className="ann-toolbar stage-ann" role="toolbar" aria-label="Map annotation tools">
      {MAP_MODES.map((m) => (
        <Button
          key={m.mode}
          variant="quiet"
          tip={m.tip}
          pressed={mode === m.mode}
          onClick={() => {
            setMode(mode === m.mode ? null : m.mode);
          }}
        >
          {m.label}
        </Button>
      ))}
    </div>
  );
}

/** The findings that are still drafts; a click opens one. */
function Drafts() {
  const t = useT();
  const issues = useWorkspace((s) => s.issues);
  const drafts = issues.filter((i) => i.status === 'draft');
  return (
    <Section id="drafts" bench="annotate" title={t('bench.annotate.drafts')} count={drafts.length}>
      {drafts.length === 0 ? (
        <p className="ab-note">{t('bench.annotate.noDrafts')}</p>
      ) : (
        <div className="ab-drafts">
          {drafts.map((i) => (
            <Row
              key={i.id}
              as="button"
              kind="tree"
              icon="flag"
              label={`${i.code} ${i.title}`}
              data-draft={i.id}
              onClick={() => {
                workspace.getState().select({ kind: 'issue', id: i.id });
              }}
            />
          ))}
        </div>
      )}
    </Section>
  );
}

export function AnnotateBench() {
  const t = useT();
  const annotating = useShell((s) => s.annotating);
  const pkg = useShell((s) => s.pkg);
  const show3d = useAnnotateStage((s) => s.show3d);
  const showMap = useAnnotateStage((s) => s.showMap);
  const draw = useMapDrawHandle();
  const tool = useAnnotateStage((s) => s.tool);
  const setTool = useAnnotateStage((s) => s.setTool);
  if (pkg) {
    return <EmptyState icon="anno" title={t('bench.annotate.readOnly')} />;
  }
  return (
    <div className="ab wb-scroll">
      {annotating ? (
        <div className="ab-tools" role="group" aria-label="Annotation tools">
          <div className="ab-close">
            <Button
              variant="quiet"
              icon="x"
              shortcut="scene.annotate"
              onClick={() => {
                shell.getState().setAnnotating(false);
              }}
            >
              {t('bench.annotate.close')}
            </Button>
          </div>
          <Section id="model" bench="annotate" title={t('bench.annotate.model')} forceOpen>
            {show3d ? (
              <AnnotationToolbar
                className="stage-ann"
                store={primaryScene}
                picker={false}
                control={{ tool, onTool: setTool }}
              />
            ) : (
              <p className="ab-note">{t('bench.annotate.needs3d')}</p>
            )}
          </Section>
          <Section id="map" bench="annotate" title={t('bench.annotate.map')} forceOpen>
            {showMap ? (
              <MapDrawTools draw={draw} />
            ) : (
              <p className="ab-note">{t('bench.annotate.needsMap')}</p>
            )}
          </Section>
        </div>
      ) : (
        <div className="ab-start">
          <Button
            variant="primary"
            icon="anno"
            shortcut="scene.annotate"
            aria-label={t('bench.annotate.start')}
            onClick={() => {
              shell.getState().setAnnotating(true);
            }}
          >
            {t('bench.annotate.startShort')}
          </Button>
        </div>
      )}
      <Drafts />
    </div>
  );
}
