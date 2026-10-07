import type { IpcEvent } from '@aio/schema';
import { Icon, t, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useState } from 'react';

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

/**
 * Notices after a sync or an import (`sync:notice`, M9 T4): a device whose clock is ahead, and
 * issue codes renumbered because two copies made the same code apart. Shown in the toast stack
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
        <div key={key} className="toast" data-testid="sync-notice">
          <div className="toast-h">
            <Icon name={notice.kind === 'recode' ? 'refresh' : 'warn'} size={14} />
            <b>
              {t(notice.kind === 'recode' ? 'syncNotice.recodeTitle' : 'syncNotice.clockTitle')}
            </b>
            <span className="toast-grow" />
            <button
              type="button"
              className="btn ghost icon sm"
              aria-label={t('syncNotice.dismiss')}
              onClick={() => {
                setList((old) => old.filter((x) => x.key !== key));
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
          <div className="toast-p">{noticeText(notice, codeOf)}</div>
        </div>
      ))}
    </>
  );
}
