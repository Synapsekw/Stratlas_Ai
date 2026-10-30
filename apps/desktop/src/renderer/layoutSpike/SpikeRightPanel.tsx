/**
 * The right panel as four fixed tabs (D2): Selection, Tools, Layers & display, Project, always
 * present, never pinned, closed or moved to overflow. Each tab is a scrolling list of sections
 * that show today's panels by import (the workbench's `FrontBody`); a section mounts its panel
 * only while it is open. The agent stays docked at the panel's foot. One width per band, dragged
 * on the inner edge; opening a tab never changes it.
 */
import { Button, Icon, Tabs, t, useT } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { AgentPane } from '../agent/AgentPane';
import { useCardFocusSeq } from '../issueCard/state';
import { useIsRoad } from '../road/useRoadMap';
import { shell, useShell } from '../shell';
import { isPile } from '../survey/pile/openPile';
import { PilePanel } from '../survey/pile/PilePanel';
import { measureStore, useMeasure } from '../survey/measureStore';
import { agentWindow } from '../workspace/agentWindow';
import { StageShow } from '../workspace/StageShow';
import { ProjectList } from '../workspace/workbench/project/ProjectList';
import { FrontBody } from '../workspace/workbench/RightSidebar';
import { workbench } from '../workspace/workbench/workbenchStore';
import '../workspace/workbench/section.css';
import {
  clampRight,
  OLD_TAB_HOME,
  PANEL_TABS,
  projectSections,
  sectionsOf,
  TAB_LABEL,
  toolSections,
  waitingGroups,
  type Band,
  type PanelTab,
  type Preset,
  type ProjectData,
  type SectionDef,
} from './model';
import { spike, useSpike } from './spikeStore';

/** A spike section: the workbench section's look; its body mounts only while it is open. */
function SpikeSection({ def, children }: { def: SectionDef; children: ReactNode }) {
  const open = useSpike((s) => s.open[def.id] === true);
  const bodyId = `spk-sec-${def.id.replace('.', '-')}`;
  return (
    <section
      className="wb-section spk-section"
      data-open={open}
      data-testid={`spike-section-${def.id}`}
    >
      <button
        type="button"
        className="wb-section-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          spike.getState().toggle(def.id);
        }}
      >
        <Icon name="chev-r" size={12} />
        <span className="wb-section-title">{t(def.label)}</span>
      </button>
      <div className="wb-section-body" id={bodyId} inert={!open}>
        <div className="wb-section-inner spk-section-inner">{open ? children : null}</div>
      </div>
    </section>
  );
}

/** Project > Issues: counts by severity and the five most severe open issues (D8, a stub). */
function IssuesSummary() {
  const issues = useWorkspace((s) => s.issues);
  const open = issues.filter((i) => i.status !== 'closed');
  const rank = (sev: number | 'uncertain') => (sev === 'uncertain' ? -1 : sev);
  const label = (sev: number | 'uncertain') => (sev === 'uncertain' ? '?' : `S${String(sev)}`);
  const bySeverity = new Map<number | 'uncertain', number>();
  for (const i of open) bySeverity.set(i.severity, (bySeverity.get(i.severity) ?? 0) + 1);
  const top = [...open].sort((a, b) => rank(b.severity) - rank(a.severity)).slice(0, 5);
  return (
    <div className="spk-issues" data-testid="spike-issues-summary">
      {open.length === 0 ? (
        <p className="muted">{t('layoutSpike.issues.none')}</p>
      ) : (
        <>
          <p className="spk-issue-counts" aria-label={t('layoutSpike.issues.counts')}>
            {[...bySeverity.entries()]
              .sort(([a], [b]) => rank(b) - rank(a))
              .map(([sev, n]) => (
                <span key={String(sev)} className="spk-sev">
                  {label(sev)} <b>{n}</b>
                </span>
              ))}
          </p>
          <ul className="spk-issue-list">
            {top.map((i) => (
              <li key={i.id}>
                <button
                  type="button"
                  onClick={() => {
                    workspace.getState().select({ kind: 'issue', id: i.id });
                  }}
                >
                  <span className="spk-sev">{label(i.severity)}</span>
                  <span className="mono">{i.code}</span>
                  <span className="spk-issue-title">{i.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <Button
        variant="quiet"
        onClick={() => {
          shell.getState().go('issues');
        }}
      >
        {t('layoutSpike.issues.open')}
      </Button>
    </div>
  );
}

/** The body of a section: today's panel for its old tab id, or the spike's own. */
function SectionBody({ def, road }: { def: SectionDef; road: boolean }) {
  if (def.id === 'project.inThisProject') return <ProjectList />;
  if (def.id === 'project.issues') return <IssuesSummary />;
  if (def.id === 'layers.show') return <StageShow />;
  if (def.id === 'tools.view') return <ViewTools />;
  if (def.id === 'tools.volumes')
    return (
      <div className="spk-note">
        <p>{t('layoutSpike.volumesTools')}</p>
        <Button
          variant="quiet"
          onClick={() => {
            spike.getState().show('project.volumes');
          }}
        >
          {t('layoutSpike.openVolumes')}
        </Button>
      </div>
    );
  if (def.body === null) return null;
  return <FrontBody front={def.body} road={road} />;
}

function ViewTools() {
  const mode = useShell((s) => s.stageMode);
  return (
    <div className="seg spk-view-seg" role="group" aria-label={t('layoutSpike.group.view')}>
      {(['3d', 'map', 'split'] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          onClick={() => {
            shell.getState().setStageMode(m);
          }}
        >
          {t(`layoutSpike.view.${m}`)}
        </button>
      ))}
    </div>
  );
}

/** Selection: what was clicked on the site, a pile included (founder, 30 Oct). */
function SelectionBody({ road }: { road: boolean }) {
  const focus = useMeasure((s) => s.focus);
  const pile = useMeasure((s) => {
    const m = s.file.measurements.find((x) => x.id === s.focus);
    return m && isPile(m) ? m.id : null;
  });
  const selected = useWorkspace((s) => s.selection !== null);
  if (pile) return <PilePanel id={pile} />;
  if (!road && !selected && focus === null)
    return <p className="spk-empty muted">{t('layoutSpike.selection.empty')}</p>;
  return <FrontBody front="selection" road={road} />;
}

/**
 * The panel follows what the person does, through today's workbench calls: a tool that brings
 * its old tab brings its new section, a picked issue opens Selection, and a clicked pile opens in
 * Selection (not Volumes).
 */
function useFollow() {
  useEffect(() => {
    const pileFocused = () => {
      const s = measureStore.getState();
      const m = s.file.measurements.find((x) => x.id === s.focus);
      return m !== undefined && isPile(m);
    };
    const offBench = workbench.subscribe((s, prev) => {
      if (s.front === prev.front) return;
      if (s.front === 'volumes' && pileFocused()) spike.getState().show('selection.selected');
      else spike.getState().show(OLD_TAB_HOME[s.front]);
    });
    const offMeasure = measureStore.subscribe((s, prev) => {
      if (s.focus !== prev.focus && pileFocused()) spike.getState().show('selection.selected');
    });
    return () => {
      offBench();
      offMeasure();
    };
  }, []);
  const seq = useCardFocusSeq();
  const seen = useRef(seq);
  useEffect(() => {
    if (seen.current === seq) return;
    seen.current = seq;
    spike.getState().show('selection.selected');
  }, [seq]);
}

/** The inner edge's drag handle: a pointer drag or the arrow keys, kept inside the band. */
function ResizeEdge({ band, width }: { band: Band; width: number }) {
  const start = useRef<{ x: number; w: number; id: number } | null>(null);
  const rtl = document.documentElement.dir === 'rtl';
  const set = (px: number) => {
    spike.getState().setRight(band, clampRight(band, px));
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={t('layoutSpike.resizePanel')}
      aria-valuenow={width}
      className="spk-resize"
      data-testid="spike-resize"
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width, id: e.pointerId };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (s?.id !== e.pointerId) return;
        const dx = e.clientX - s.x;
        set(s.w + (rtl ? dx : -dx));
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      onPointerCancel={() => {
        start.current = null;
      }}
      onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
        const step = e.shiftKey ? 40 : 10;
        if (e.key === 'ArrowLeft') set(width + (rtl ? -step : step));
        else if (e.key === 'ArrowRight') set(width + (rtl ? step : -step));
        else return;
        e.preventDefault();
      }}
    />
  );
}

export function SpikeRightPanel({
  preset,
  data,
  band,
  width,
}: {
  preset: Preset;
  data: ProjectData;
  band: Band;
  width: number;
}) {
  useT();
  useFollow();
  const tab = useSpike((s) => s.tab);
  const road = useIsRoad();
  const focusedWindow = useWorkspace((s) => s.focusedWindow);
  const stageMode = useShell((s) => s.stageMode);
  const issues = useWorkspace((s) => s.issues.length);
  const sections: SectionDef[] =
    tab === 'tools'
      ? toolSections(preset, data)
      : tab === 'project'
        ? projectSections(preset, data)
        : sectionsOf(tab, data);
  const waiting = tab === 'tools' ? waitingGroups(data) : [];
  return (
    <aside
      className="right spk-right"
      aria-label={t('layoutSpike.panel')}
      data-testid="spike-right"
    >
      <ResizeEdge band={band} width={width} />
      <div className="wb-bar spk-tabs" data-testid="spike-tabs">
        <Tabs<PanelTab>
          items={PANEL_TABS.map((id) => ({
            id,
            label: t(TAB_LABEL[id]),
            ...(id === 'project' && issues > 0 ? { count: issues } : {}),
            testId: `spike-tab-${id}`,
          }))}
          value={tab}
          onChange={(id) => {
            spike.getState().setTab(id);
          }}
          label={t('layoutSpike.panel')}
          idPrefix="spk"
        />
      </div>
      <AgentPane
        window={agentWindow(focusedWindow, stageMode)}
        bench={
          <div
            className="ctx-wrap tall spk-body"
            role="tabpanel"
            id={`spk-panel-${tab}`}
            aria-labelledby={`spk-tab-${tab}`}
            data-front={tab}
          >
            <div className="spk-scroll">
              {tab === 'selection' ? (
                <SelectionBody road={road} />
              ) : (
                sections.map((def) => (
                  <SpikeSection key={def.id} def={def}>
                    <SectionBody def={def} road={road} />
                  </SpikeSection>
                ))
              )}
              {waiting.length > 0 && (
                <p className="spk-waiting muted" data-testid="spike-waiting">
                  {t('layoutSpike.needs', {
                    groups: waiting.map((g) => t(`layoutSpike.group.${g}`)).join(', '),
                  })}
                </p>
              )}
            </div>
          </div>
        }
      />
    </aside>
  );
}
