import { useAnnotateReadOnly } from '@aio/annotate';
import { actionsFor, ContextMenu, makeActionCtx } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { useShell } from '../shell';
import { registerSidebarActions } from '../shell/actions';
import { toastHost } from '../shell/actions/toastHost';
import { timeline } from '../workspace/timeline';
import { closeIssueMenu, issueMenu } from './issueMenuStore';

/** The registered actions of the right-clicked issues (Place on model, Move point). */
export function IssueMenuMount() {
  const at = useStore(issueMenu, (s) => s.at);
  const project = useWorkspace((s) => s.project);
  const hidden = useWorkspace((s) => s.hidden);
  const pkg = useShell((s) => s.pkg);
  const lookOnly = useAnnotateReadOnly();
  const code = useWorkspace((s) => s.issues.find((i) => i.id === at?.clicked)?.code);
  if (!at || !project || code === undefined) return null;
  registerSidebarActions();
  const items = actionsFor(
    { kind: 'issues', ids: at.ids, clicked: at.clicked },
    makeActionCtx({
      manifest: project.manifest,
      hidden,
      focus: timeline.getState().focus,
      pkg: !!pkg,
      canEdit: !pkg && !lookOnly,
      host: toastHost(code),
    }),
  );
  if (items.length === 0) return null;
  return (
    <ContextMenu
      items={items}
      x={at.x}
      y={at.y}
      label={code}
      title={code}
      testId="issue-menu"
      onClose={closeIssueMenu}
    />
  );
}
