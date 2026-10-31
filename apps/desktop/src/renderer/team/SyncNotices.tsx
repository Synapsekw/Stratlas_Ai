import type { IpcEvent } from '@aio/schema';
import { t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useState } from 'react';
import { useToastNotice } from '../exports/useToastNotice';

type Notice = IpcEvent<'sync:notice'>['notices'][number];

/** The words of one notice: a clock ahead on a device, or a code renumbered by a merge. */
export function noticeText(n: Notice, codeOf: (id: string) => string | undefined): string {
  if (n.kind === 'recode') {
    const delivered = n.delivered?.length
      ? t('syncNotice.delivered', { packages: n.delivered.join(', ') })
      : '';
    return `${t('syncNotice.recode', { from: n.from, to: codeOf(n.issue) ?? n.to })}${delivered ? ` ${delivered}` : ''}`;
  }
  const hours = Math.round(n.aheadMs / 3_600_000);
  const minutes = Math.max(1, Math.round(n.aheadMs / 60_000));
  const ahead =
    hours >= 1
      ? t('syncNotice.hours', { count: hours })
      : t('syncNotice.minutes', { count: minutes });
  const who = n.name ?? n.device.slice(0, 12);
  return n.level === 'hold'
    ? t('syncNotice.clockHold', { who, ahead })
    : t('syncNotice.clockAhead', { who, ahead });
}

/** One notice as a toast; Dismiss takes it off the list. */
function SyncNotice({
  id,
  notice,
  text,
  onDismiss,
}: {
  id: string;
  notice: Notice;
  text: string;
  onDismiss: () => void;
}) {
  useToastNotice(id, {
    message: t(notice.kind === 'recode' ? 'syncNotice.recodeTitle' : 'syncNotice.clockTitle'),
    detail: text,
    icon: notice.kind === 'recode' ? 'refresh' : 'warn',
    testId: 'sync-notice',
    closeLabel: t('syncNotice.dismiss'),
    onDismiss,
  });
  return null;
}

/**
 * Notices after a sync or an import (`sync:notice`, M9 T4): a device whose clock is ahead, and
 * issue codes renumbered because two copies made the same code apart. Each is a toast on the host
 * for the open project until dismissed.
 */
export function SyncNotices() {
  useT();
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  const issues = useWorkspace((s) => s.issues);
  const [list, setList] = useState<{ key: string; notice: Notice }[]>([]);
  useEffect(() => {
    let n = 0;
    return window.aio.on('sync:notice', (e) => {
      if (e.projectId !== projectId) return;
      setList((old) =>
        [...old, ...e.notices.map((notice) => ({ key: String(n++), notice }))].slice(-5),
      );
    });
  }, [projectId]);
  const codeOf = (id: string) => issues.find((i) => i.id === id)?.code;
  const shown = projectId ? list : [];
  return (
    <>
      {shown.map(({ key, notice }) => (
        <SyncNotice
          key={`${projectId ?? ''}:${key}`}
          id={`sync-notice-${projectId ?? ''}-${key}`}
          notice={notice}
          text={noticeText(notice, codeOf)}
          onDismiss={() => {
            setList((old) => old.filter((x) => x.key !== key));
          }}
        />
      ))}
    </>
  );
}
