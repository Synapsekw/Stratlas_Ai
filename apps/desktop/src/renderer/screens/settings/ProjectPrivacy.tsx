/**
 * Settings, Privacy and cloud, "This project": the switch "Keep this project's images on this PC"
 * (the manifest's `aiPolicy: 'forbid'`). Main reads the policy from disk on every request, so a
 * flip stops the next cloud request. After a successful call the manifest is read again, as the
 * engineer run store does after a save in main.
 */
import { Switch, t } from '@aio/ui';
import { useWorkspace, workspace } from '@aio/workspace';
import { type ReactElement, useState } from 'react';
import { bridge, useShell } from '../../shell';

export function ProjectPrivacy(): ReactElement | null {
  const project = useWorkspace((s) => s.project);
  const pkg = useShell((s) => s.pkg);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!project) return null;
  const { id, root } = project;
  const keepLocal = project.manifest.aiPolicy === 'forbid';
  const isPackage = pkg != null;

  const flip = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const call = await bridge.call('ai:setProjectPolicy', { projectId: id, keepLocal: next });
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
    <div className="sblock" data-testid="project-privacy">
      <h2>{t('settings.projectPrivacy.title')}</h2>
      <div className="opt">
        <b>{t('settings.projectPrivacy.keepLocal')}</b>
        <span>
          {isPackage
            ? t('settings.projectPrivacy.package')
            : keepLocal
              ? t('settings.projectPrivacy.on')
              : t('settings.projectPrivacy.off')}
        </span>
        <span data-testid="keep-local">
          <Switch
            checked={keepLocal}
            disabled={isPackage || busy}
            label={t('settings.projectPrivacy.keepLocal')}
            onChange={(v) => void flip(v)}
          />
        </span>
      </div>
      {error && (
        <p className="notice warn" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
