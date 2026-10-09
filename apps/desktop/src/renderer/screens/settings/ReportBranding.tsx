import { brand } from '@aio/brand';
import type { ReportBrandingSettings } from '@aio/schema';
import { Icon, t } from '@aio/ui';
import { useEffect, useRef, useState } from 'react';
import { bridge, shell, useShell } from '../../shell';

/** The report's house accent (renderer/reportPage/report.css `--acc`). */
const HOUSE_ACCENT = '#1a9e86';

const logoUrl = (file: string) => `aio://branding/${encodeURIComponent(file)}`;

/** Store the branding; the logo is managed by main (branding:setLogo, branding:clearLogo). */
function save(next: ReportBrandingSettings) {
  void shell.getState().updateSettings({ reportBranding: next });
}

/** A small copy of the report cover with the current branding. */
function CoverPreview({ b }: { b: ReportBrandingSettings | undefined }) {
  const accent = b?.accent ?? HOUSE_ACCENT;
  const name = b?.companyName?.trim();
  return (
    <div
      className="brand-pv"
      style={{ ['--pv-acc' as string]: accent }}
      aria-label={t('settings.branding.preview')}
      role="img"
    >
      <div className="brand-pv-mark">
        {b?.logo && (
          <span className="brand-pv-logo">
            <img src={logoUrl(b.logo)} alt="" />
          </span>
        )}
        {name && <span className="brand-pv-name">{name}</span>}
      </div>
      <div className="brand-pv-main">
        <span className="brand-pv-kicker">{t('settings.branding.previewKicker')}</span>
        <b>{t('settings.branding.previewTitle')}</b>
      </div>
      {!name && !b?.logo && (
        <span className="brand-pv-credit">
          {t('settings.branding.credit', { product: brand.productName })}
        </span>
      )}
    </div>
  );
}

/** Settings, Report branding: the person's company name, logo and accent for generated reports. */
export function ReportBranding() {
  const branding = useShell((s) => s.settings.reportBranding);
  const [company, setCompany] = useState(branding?.companyName ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accentTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(accentTimer.current);
    },
    [],
  );

  const current = (): ReportBrandingSettings => shell.getState().settings.reportBranding ?? {};
  const custom = Boolean(branding?.companyName?.trim()) || Boolean(branding?.logo);

  const saveCompany = () => {
    const name = company.trim();
    if (name === (branding?.companyName ?? '')) return;
    const rest = { ...current() };
    delete rest.companyName;
    save(name ? { ...rest, companyName: name } : rest);
  };

  const setAccent = (accent: string | null) => {
    window.clearTimeout(accentTimer.current);
    const apply = () => {
      const rest = { ...current() };
      delete rest.accent;
      save(accent ? { ...rest, accent } : rest);
    };
    // The colour picker reports every step of a drag; store the colour it settles on.
    if (accent) accentTimer.current = window.setTimeout(apply, 300);
    else apply();
  };

  const pickLogo = async () => {
    setError(null);
    const pick = await bridge.call('dialog:openFile', {
      title: t('settings.branding.pickTitle'),
      filters: [{ name: t('settings.branding.images'), extensions: ['png', 'jpg', 'jpeg', 'svg'] }],
    });
    if (!pick.ok || !pick.value.path) return;
    setBusy(true);
    const path = pick.value.path;
    // its settings answer must not undo a change made while the logo was copied
    const r = await shell.getState().settingsCall(
      () => bridge.call('branding:setLogo', { path }),
      (a) => (a.ok && a.value.ok ? a.value.settings : null),
    );
    setBusy(false);
    if (!r.ok) setError(r.error);
    else if (!r.value.ok) setError(r.value.error);
  };

  const removeLogo = async () => {
    setError(null);
    const r = await shell.getState().settingsCall(
      () => bridge.call('branding:clearLogo', {}),
      (a) => (a.ok ? a.value : null),
    );
    if (!r.ok) setError(r.error);
  };

  return (
    <div className="brand-set" data-testid="report-branding">
      <p className={`notice${custom ? ' ok' : ''}`} role="status">
        <Icon name={custom ? 'check' : 'report'} size={14} />
        {custom
          ? t('settings.branding.custom')
          : t('settings.branding.neutral', { product: brand.productName })}
      </p>
      <div className="brand-grid">
        <div>
          <div className="sblock">
            <h2>{t('settings.branding.company')}</h2>
            <p className="help">{t('settings.branding.companyHelp')}</p>
            <input
              className="input"
              aria-label={t('settings.branding.company')}
              style={{ width: '100%', maxWidth: 320 }}
              value={company}
              placeholder={t('settings.branding.companyPlaceholder')}
              maxLength={120}
              onChange={(e) => {
                setCompany(e.target.value);
              }}
              onBlur={saveCompany}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveCompany();
              }}
            />
          </div>
          <div className="sblock">
            <h2>{t('settings.branding.logo')}</h2>
            <p className="help">{t('settings.branding.logoHelp')}</p>
            <div className="path-row" data-testid="branding-logo">
              {branding?.logo ? (
                <span className="brand-logo-chip">
                  <img src={logoUrl(branding.logo)} alt={t('settings.branding.logo')} />
                </span>
              ) : (
                <span className="faint">{t('settings.branding.noLogo')}</span>
              )}
              <span className="brand-acts">
                {branding?.logo && (
                  <button type="button" className="btn sm ghost" onClick={() => void removeLogo()}>
                    {t('settings.branding.removeLogo')}
                  </button>
                )}
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => void pickLogo()}
                >
                  {branding?.logo
                    ? t('settings.branding.replaceLogo')
                    : t('settings.branding.pickLogo')}
                </button>
              </span>
            </div>
            {error && (
              <p className="notice warn" role="alert" style={{ marginTop: 8 }}>
                <Icon name="warn" size={14} />
                {error}
              </p>
            )}
          </div>
          <div className="sblock">
            <h2>{t('settings.branding.accent')}</h2>
            <p className="help">{t('settings.branding.accentHelp')}</p>
            <div className="brand-accent">
              <input
                type="color"
                aria-label={t('settings.branding.accent')}
                value={branding?.accent ?? HOUSE_ACCENT}
                onChange={(e) => {
                  setAccent(e.target.value);
                }}
              />
              <span className="mono">
                {branding?.accent ?? t('settings.branding.accentDefault')}
              </span>
              {branding?.accent && (
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => {
                    setAccent(null);
                  }}
                >
                  {t('settings.branding.accentReset')}
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="sblock">
          <h2>{t('settings.branding.preview')}</h2>
          <CoverPreview b={branding} />
        </div>
      </div>
    </div>
  );
}
