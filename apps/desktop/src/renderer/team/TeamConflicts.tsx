import type { Conflict, QuarantineEntry, RecordRef } from '@aio/schema';
import { loadCollab, personOf, useCollabStore } from '@aio/collab/ui';
import { t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useCallback, useEffect, useState } from 'react';
import { bridge } from '../shell';
import { ConflictsPanel } from './Conflicts';
import { refreshTeamStatus } from './SyncStatus';

/**
 * The Conflicts inbox and the quarantine list of the open project (T4), in the Team dialog:
 * Keep mine, Take theirs, Edit, Restore (a `conflict.resolve` op through main), and Apply anyway
 * for an owner. Names come from the members (T2); issue codes from the open project.
 */
export function TeamConflicts({ projectId }: { projectId: string }) {
  useT();
  const issues = useWorkspace((s) => s.issues);
  const members = useCollabStore((s) => s.members);
  const me = useCollabStore((s) => s.me);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [quarantined, setQuarantined] = useState<QuarantineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [rev, setRev] = useState(0);
  const load = useCallback(() => {
    setRev((n) => n + 1);
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.all([
      bridge.call('sync:conflicts', { projectId }),
      bridge.call('sync:quarantine', { projectId }),
    ]).then(([c, q]) => {
      if (!live) return;
      if (!c.ok || !c.value.ok) {
        setError(!c.ok ? c.error : c.value.ok ? null : c.value.error);
        setConflicts([]);
      } else setConflicts(c.value.conflicts);
      setQuarantined(q.ok && q.value.ok ? q.value.entries : []);
    });
    return () => {
      live = false;
    };
  }, [projectId, rev]);

  useEffect(() => {
    void loadCollab(projectId);
    return window.aio.on('journal:changed', (e) => {
      if (e.projectId === projectId) load();
    });
  }, [projectId, load]);

  if (conflicts === null) return null;
  if (conflicts.length === 0 && quarantined.length === 0 && !error) return null;
  const nameOf = (actor: string) =>
    me?.actor === actor ? t('conflicts.you') : personOf({ members, me }, actor).name;
  const labelOf = (r: RecordRef) =>
    r.rec === 'issue' ? (issues.find((i) => i.id === r.id)?.code ?? r.id) : `${r.rec} ${r.id}`;
  const after = async () => {
    load();
    await refreshTeamStatus(projectId);
  };
  return (
    <>
      {error && (
        <p className="notice danger" role="alert">
          {error}
        </p>
      )}
      <ConflictsPanel
        conflicts={conflicts}
        quarantined={quarantined}
        {...(me ? { viewer: me.actor } : {})}
        nameOf={nameOf}
        labelOf={labelOf}
        canRelease={me?.role === 'owner' || members.length === 0}
        onResolve={async (c, choice, value) => {
          const r = await bridge.call('sync:resolve', {
            projectId,
            conflict: c.id,
            choice,
            ...(value !== undefined ? { value } : {}),
          });
          if (!r.ok) throw new Error(r.error);
          if (!r.value.ok) throw new Error(r.value.error);
          await after();
        }}
        onRelease={async (q) => {
          const r = await bridge.call('sync:release', { projectId, op: q.op });
          if (!r.ok) throw new Error(r.error);
          if (!r.value.ok) throw new Error(r.value.error);
          await after();
        }}
      />
    </>
  );
}
