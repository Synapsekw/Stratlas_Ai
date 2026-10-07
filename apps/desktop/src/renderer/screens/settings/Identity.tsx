import { Icon, t } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useState } from 'react';
import { refreshIdentity, saveIdentity, useIdentity } from '../../author';
import { bridge } from '../../shell';
import { Members } from '../../team/Members';

const INITIALS = /^\p{L}{1,3}\d?$/u;

/** A text field that saves when it loses focus or on Enter. */
function Field({
  label,
  value,
  maxLength,
  width,
  check,
  save,
}: {
  label: string;
  value: string;
  maxLength: number;
  width: number;
  check: (v: string) => string | null;
  save: (v: string) => Promise<string | null>;
}) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const commit = async () => {
    const v = text.trim();
    if (v === value) {
      setError(null);
      return;
    }
    const bad = check(v);
    setError(bad ?? (await save(v)));
  };
  return (
    <label style={{ display: 'grid', gap: 4 }}>
      <span className="faint" style={{ fontSize: 'var(--t-12)' }}>
        {label}
      </span>
      <input
        className="input"
        aria-label={label}
        aria-invalid={error !== null}
        style={{ width }}
        value={text}
        maxLength={maxLength}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
        }}
      />
      {error && (
        <span role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--t-12)' }}>
          {error}
        </span>
      )}
    </label>
  );
}

/** Settings, Identity and team: who you are, your identity card, and the open project's members. */
export function IdentitySettings() {
  const { identity, device, unsigned, error } = useIdentity();
  const project = useWorkspace((s) => s.project);
  const [saved, setSaved] = useState<string | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);

  const exportCard = async () => {
    setSaved(null);
    setCardError(null);
    const r = await bridge.call('identity:exportCard', {});
    if (!r.ok) setCardError(r.error);
    else if (!r.value.ok) setCardError(r.value.error);
    else if (r.value.path) setSaved(r.value.path);
    await refreshIdentity();
  };

  return (
    <>
      <div className="sblock">
        <h2>{t('identity.you')}</h2>
        <p className="help">{t('identity.you.help')}</p>
        {error && (
          <p className="notice warn" role="status">
            <Icon name="warn" size={14} />
            {error}
          </p>
        )}
        {identity && (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'start' }}>
            <Field
              key={`name:${identity.name}`}
              label={t('identity.name')}
              value={identity.name}
              maxLength={80}
              width={260}
              check={(v) => (v.length >= 1 && v.length <= 80 ? null : t('identity.name.invalid'))}
              save={(name) => saveIdentity({ name })}
            />
            <Field
              key={`initials:${identity.initials}`}
              label={t('identity.initials')}
              value={identity.initials}
              maxLength={4}
              width={80}
              check={(v) => (INITIALS.test(v) ? null : t('identity.initials.invalid'))}
              save={(initials) => saveIdentity({ initials })}
            />
            <Field
              key={`email:${identity.email ?? ''}`}
              label={t('identity.email')}
              value={identity.email ?? ''}
              maxLength={254}
              width={240}
              check={() => null}
              save={(email) => saveIdentity({ email })}
            />
          </div>
        )}
      </div>
      <div className="sblock">
        <h2>{t('identity.device')}</h2>
        <p className="help">
          {device
            ? t('identity.device.key', { id: `${device.slice(0, 10)}...` })
            : t('identity.device.none')}
        </p>
        {unsigned && (
          <p className="notice warn" role="status">
            <Icon name="warn" size={14} />
            {t('identity.device.unsigned')}
          </p>
        )}
        <p className="help">{t('identity.card.help')}</p>
        <button type="button" className="btn sm" onClick={() => void exportCard()}>
          {t('identity.card.export')}
        </button>
        {saved && (
          <p className="help" role="status" style={{ marginTop: 8 }}>
            {t('identity.card.saved', { path: saved })}
          </p>
        )}
        {cardError && (
          <p className="notice warn" role="alert" style={{ marginTop: 8 }}>
            <Icon name="warn" size={14} />
            {cardError}
          </p>
        )}
      </div>
      {project ? (
        <Members projectId={project.id} projectName={project.manifest.name} />
      ) : (
        <div className="sblock">
          <p className="help">{t('identity.members.noProject')}</p>
        </div>
      )}
    </>
  );
}
