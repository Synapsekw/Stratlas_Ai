/**
 * Settings, This project, "Tool sets" (tools by project type, founder 18 Nov 2026): one switch per
 * tool set, on as the project type gives it. Turning one saves the whole list in the project
 * (`project:setToolSets`) and reads the manifest again, so the tools follow at once. A set whose
 * records the project holds is on and locked: no record ever loses its tools. A package shows the
 * switches and cannot change them. Road is offered only in a road project or with a road model:
 * anywhere else it could show nothing. The rule is `tools/toolSets.ts`.
 */
import { Switch, t, type MessageKey } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { type ReactElement, useState } from 'react';
import { bridge, useShell } from '../../shell';
import { isRoadProject } from '../../road/model';
import { shownSwitches, toggled, type ToolSet } from '../../tools/toolSets';
import { useHeld } from '../../tools/useToolSets';

const NAME: Record<ToolSet, MessageKey> = {
  earthworks: 'settings.toolSets.earthworks',
  road: 'settings.toolSets.road',
  telecom: 'settings.toolSets.telecom',
  thermal: 'settings.toolSets.thermal',
};
const WHAT: Record<ToolSet, MessageKey> = {
  earthworks: 'settings.toolSets.earthworks.what',
  road: 'settings.toolSets.road.what',
  telecom: 'settings.toolSets.telecom.what',
  thermal: 'settings.toolSets.thermal.what',
};
const HELD: Record<ToolSet, MessageKey> = {
  earthworks: 'settings.toolSets.earthworks.held',
  road: 'settings.toolSets.road.held',
  telecom: 'settings.toolSets.telecom.held',
  thermal: 'settings.toolSets.thermal.held',
};

export function ToolSets(): ReactElement | null {
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg);
  const held = useHeld();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!project) return null;
  const { id, root, manifest } = project;
  const isPackage = pkg != null;

  const turn = async (set: ToolSet, on: boolean) => {
    const toolSets = toggled(manifest, held, set, on);
    if (toolSets === null) return;
    setBusy(true);
    setError(null);
    try {
      const call = await bridge.call('project:setToolSets', { projectId: id, toolSets });
      if (!call.ok) {
        setError(call.error);
        return;
      }
      if (!call.value.ok) {
        setError(call.value.error);
        return;
      }
      const seq = workspace.getState().openSeq;
      const opened = await bridge.call('project:open', { path: root });
      if (!opened.ok) {
        setError(opened.error);
        return;
      }
      if (!opened.value.ok) {
        setError(opened.value.error);
        return;
      }
      const now = workspace.getState();
      if (now.openSeq === seq && now.project?.id === id && now.project.root === root)
        now.replaceManifest(opened.value.manifest);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sblock" data-testid="project-tool-sets">
      <h2>{t('settings.toolSets.title')}</h2>
      <p className="help">
        {isPackage ? t('settings.toolSets.package') : t('settings.toolSets.text')}
      </p>
      {shownSwitches(manifest, held, isRoadProject(manifest)).map((row) => (
        <div className="opt" key={row.set}>
          <b>{t(NAME[row.set])}</b>
          <span>{t(row.locked ? HELD[row.set] : WHAT[row.set])}</span>
          <span data-testid={`tool-set-${row.set}`}>
            <Switch
              checked={row.on}
              disabled={isPackage || busy || row.locked}
              label={t(NAME[row.set])}
              onChange={(v) => void turn(row.set, v)}
            />
          </span>
        </div>
      ))}
      {error && (
        <p className="notice warn" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
