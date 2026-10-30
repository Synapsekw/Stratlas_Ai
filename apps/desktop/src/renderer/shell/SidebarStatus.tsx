import { Chip, formatDate, Icon, t, Tip, useT } from '@aio/ui';
import { ProcessingChip } from '../processing/ProcessingChip';
import { shell, useShell } from '../shell';
import { AiStatusChip } from './AiStatusChip';
import { ConnectionStatus } from './ConnectionStatus';

/**
 * The status row at the foot of the left sidebar ("● Online · AI ready · 1 job"): the
 * connection, which opens the connection menu; the AI status, which opens Ask AI or what fixes it;
 * and the jobs, which open the processing drawer. Under them, the package the project came from: a
 * package opened in place (read-only or not) or a folder extracted from one. The title bar held
 * these before it went. Folded to the rail, the row keeps what must stay in sight as glyphs: the
 * connection's dot, a running job or a job warning, and the package's mark, each still named
 * (styles.css; the AI chip keeps the row's `foot-cloud` place).
 */
export function SidebarStatus() {
  useT();
  const pkg = useShell((s) => s.pkg);
  const origin = useShell((s) => s.origin);
  return (
    <div className="sb-status">
      <div className="sb-status-row">
        <ConnectionStatus store={shell} variant="foot" />
        <AiStatusChip store={shell} className="foot-cloud" announces />
        <ProcessingChip />
      </div>
      {pkg && (
        <Tip
          placement="top"
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
          placement="top"
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
    </div>
  );
}
