import { Chip, formatDate, Icon, t, Tip, useT } from '@aio/ui';
import { ProcessingChip } from '../processing/ProcessingChip';
import { shell, useShell } from '../shell';
import { ConnectionStatus } from './ConnectionStatus';

/**
 * The status row at the foot of the left sidebar ("● Online · Processing 40%"): the connection,
 * which opens the connection menu, and what the project is processing, which opens the processing
 * drawer. Under them, the package the project came from: a package opened in place (read-only or
 * not) or a folder extracted from one. The title bar held these before it went.
 */
export function SidebarStatus() {
  useT();
  const pkg = useShell((s) => s.pkg);
  const origin = useShell((s) => s.origin);
  return (
    <div className="sb-status">
      <div className="sb-status-row">
        <ConnectionStatus store={shell} variant="foot" />
        <ProcessingChip />
      </div>
      {pkg && (
        <Tip
          placement="top"
          content={t(pkg.header.readOnly ? 'titlebar.readOnlyPackageTip' : 'titlebar.packageTip', {
            file: pkg.file,
          })}
        >
          <span className="sb-status-pkg sb-hide" tabIndex={0} data-testid="readonly-chip">
            <Chip kind="tag" tone="acc">
              <Icon name="lock" size={12} />
              {t(pkg.header.readOnly ? 'titlebar.readOnlyPackage' : 'titlebar.package')}
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
          <span className="sb-status-pkg sb-hide" tabIndex={0} data-testid="origin-chip">
            <Chip kind="tag">
              <Icon name="copy" size={12} />
              {t('titlebar.copyOf', { file: origin.package })}
            </Chip>
          </span>
        </Tip>
      )}
    </div>
  );
}
