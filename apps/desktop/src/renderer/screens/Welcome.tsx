import { formatBytes, formatDate, Icon } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useState } from 'react';
import { landingScreen } from '../legacy';
import { welcomeTips } from '../player';
import { shell, useShell } from '../shell';
import { NoProject } from './NoProject';

/** Customer welcome for a read-only package: what this is, when it was captured, what to try. */
export function WelcomeScreen() {
  const project = useWorkspace((s) => s.project);
  const issueCount = useWorkspace((s) => s.issues.length);
  const pkg = useShell((s) => s.pkg);
  const [thumbFailed, setThumbFailed] = useState(false);
  if (!project || !pkg) return <NoProject view="Welcome" />;

  const m = project.manifest;
  const dates = m.captures.map((c) => c.date).sort();
  const first = dates[0];
  const last = dates.at(-1);
  const captured =
    first && last
      ? first === last
        ? formatDate(first)
        : `${formatDate(first)} to ${formatDate(last)}`
      : null;
  const tips = pkg.header.welcome?.tips?.length
    ? pkg.header.welcome.tips
    : welcomeTips(m, issueCount);
  const start = () => {
    shell.getState().go(landingScreen(m));
  };

  return (
    <section className="screen welcome" aria-label="Welcome" data-testid="welcome">
      <div className="welcome-in">
        <div>
          <span className="kicker">
            <Icon name="lock" size={12} />
            Read-only package
          </span>
          <h1>{m.name}</h1>
          <p className="lead">
            A survey delivered for review. You can explore every view and export what the package
            allows; nothing in it can be changed.
          </p>
          {pkg.header.welcome?.message && <p className="msg">{pkg.header.welcome.message}</p>}
          <dl className="kv">
            {m.customer && (
              <>
                <dt>Customer</dt>
                <dd>{m.customer}</dd>
              </>
            )}
            {m.site && (
              <>
                <dt>Site</dt>
                <dd>{m.site}</dd>
              </>
            )}
            {captured && (
              <>
                <dt>Captured</dt>
                <dd>{captured}</dd>
              </>
            )}
            <dt>Issues</dt>
            <dd>{issueCount}</dd>
          </dl>
          <h2 className="caps">What to try</h2>
          <ol className="tips">
            {tips.map((t, i) => (
              <li key={t}>
                <span>{String(i + 1).padStart(2, '0')}</span>
                {t}
              </li>
            ))}
          </ol>
          <div className="acts">
            <button
              type="button"
              className="btn primary"
              onClick={start}
              data-testid="welcome-start"
            >
              Start exploring
            </button>
            {issueCount > 0 && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  shell.getState().go('issues');
                }}
              >
                Open the issue register
              </button>
            )}
          </div>
        </div>
        <div className="welcome-media">
          {!thumbFailed && (
            <img
              src={`aio://project/${project.id}/thumbnail.jpg`}
              alt=""
              draggable={false}
              onError={() => {
                setThumbFailed(true);
              }}
            />
          )}
          <div className="welcome-facts">
            <span>
              <Icon name="offline" size={12} />
              Works offline
            </span>
            <span>
              <Icon name="shield" size={12} />
              {pkg.header.aiPolicy === 'allow' ? 'Cloud AI allowed' : 'No cloud AI'}
            </span>
            {pkg.encrypted && (
              <span>
                <Icon name="key" size={12} />
                Encrypted
              </span>
            )}
            <span className="mono">{formatBytes(pkg.sizeBytes)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
