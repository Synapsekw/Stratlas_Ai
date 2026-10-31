import { Chip, formatDate, Icon, t, Tip, useT } from '@aio/ui';
import { ProcessingChip } from '../processing/ProcessingChip';
import { shell, useShell } from '../shell';
import { AiStatusChip } from './AiStatusChip';
import { ConnectionStatus } from './ConnectionStatus';

/**
 * The status group at the end of the title bar ("● Online · AI ready · 1 job", UI revision W11):
 * the connection, which opens the connection menu; the AI status, which opens Ask AI or what
 * fixes it; and the jobs, which open the processing drawer. Before them, the package the project
 * came from: a package opened in place (read-only or not) or a folder extracted from one. The
 * left sidebar's foot held these until the rail took its place.
 */
export function SidebarStatus() {
  useT();
  const pkg = useShell((s) => s.pkg);
  const origin = useShell((s) => s.origin);
  return (
    <div className="sb-status" role="group" aria-label={t('titlebar.status')}>
      {pkg && (
        <Tip
          placement="bottom"
          content={t(pkg.header.readOnly ? 'titlebar.readOnlyPackageTip' : 'titlebar.packageTip', {
            file: pkg.file,
          })}
        >
          <span className="sb-status-pkg" role="note" tabIndex={0} data-testid="readonly-chip">
            <Chip kind="tag" tone="acc">
              <Icon name="lock" size={12} />
              <span className="sb-pkg-lbl">
                {t(pkg.header.readOnly ? 'titlebar.readOnlyPackage' : 'titlebar.package')}
              </span>
            </Chip>
          </span>
        </Tip>
      )}
      {!pkg && origin && (
        <Tip
          placement="bottom"
          content={t('titlebar.copyOfTip', {
            file: origin.package,
            exported: formatDate(origin.exportedAt),
            extracted: formatDate(origin.extractedAt),
          })}
        >
          <span className="sb-status-pkg" role="note" tabIndex={0} data-testid="origin-chip">
            <Chip kind="tag">
              <Icon name="copy" size={12} />
              <span className="sb-pkg-lbl">{t('titlebar.copyOf', { file: origin.package })}</span>
            </Chip>
          </span>
        </Tip>
      )}
      <div className="sb-status-row">
        <ConnectionStatus store={shell} variant="bar" />
        <AiStatusChip store={shell} className="foot-cloud" placement="bottom" announces />
        <ProcessingChip />
      </div>
    </div>
  );
}
