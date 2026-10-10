import { Icon, t, useFocusTrap, useT } from '@aio/ui';
import { useEffect, useRef, useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { cloudAiBlocked } from '../player';
import { useShellStore, type SettingsPage, type Shell } from '../store';
import { connectionStatus, useNetworkUp } from './connection';

/**
 * The title bar's connection pair: the mode chip (Online or Offline only, the real
 * `settings.offlineOnly`) and the cloud AI chip beside it, both read from one status so they
 * cannot disagree. The mode chip opens a small menu: the switch between the two modes, what the
 * mode means, and the two things people go online for (map downloads, cloud AI).
 */
export function ConnectionStatus({ store }: { store: StoreApi<Shell> }) {
  useT();
  const offlineOnly = useShellStore(store, (s) => s.settings.offlineOnly === true);
  const cloudAi = useShellStore(store, (s) => s.settings.cloudAi);
  const pkg = useShellStore(store, (s) => s.pkg);
  const notSaved = useShellStore(store, (s) => s.settingsError);
  const status = connectionStatus({ offlineOnly, cloudAi, pkgBlocked: cloudAiBlocked(pkg) });
  const online = status.mode === 'online';
  const networkUp = useNetworkUp();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => {
      window.removeEventListener('pointerdown', away);
    };
  }, [open]);
  // focus moves to the switch, Tab stays inside, Esc closes and focus returns to the chip
  useFocusTrap(pop, open, {
    onEscape: () => {
      setOpen(false);
    },
    returnTo: () => opener.current,
  });

  const settings = (page: SettingsPage) => {
    setOpen(false);
    store.getState().openSettingsPage(page);
  };

  return (
    <div
      className="conn"
      ref={root}
      role="group"
      aria-label={t('connection.title')}
      data-mode={status.mode}
    >
      <button
        ref={opener}
        type="button"
        className="chip-status conn-mode"
        title={open ? undefined : t(status.modeTip)}
        aria-label={t('connection.chip', { mode: t(status.modeLabel) })}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="connection-chip"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name={status.modeIcon} size={14} />
        <span className="conn-label">{t(status.modeLabel)}</span>
        <Icon name="chevdown" size={12} className="conn-caret" />
      </button>
      <button
        type="button"
        className="chip-status conn-cloud"
        title={t(status.cloudTip)}
        data-state={status.cloud}
        data-testid="cloud-chip"
        onClick={() => {
          settings('privacy');
        }}
      >
        <span className={status.cloudActive ? 'dot' : 'dot off'} />
        {t(status.cloudLabel)}
      </button>
      {open && (
        <div
          ref={pop}
          className="conn-pop"
          role="dialog"
          aria-label={t('connection.title')}
          data-testid="connection-menu"
        >
          <span className="pop-title">{t('connection.title')}</span>
          <button
            type="button"
            className="conn-switch"
            role="switch"
            aria-checked={online}
            aria-label={t('connection.switch')}
            aria-describedby="conn-mode-text"
            data-testid="connection-switch"
            onClick={() => void store.getState().updateSettings({ offlineOnly: online })}
          >
            <span className="conn-opt" data-current={!online}>
              <Icon name="offline" size={14} />
              {t('titlebar.offlineOnly')}
            </span>
            <span className="conn-track" aria-hidden="true" />
            <span className="conn-opt" data-current={online}>
              <Icon name="globe" size={14} />
              {t('titlebar.online')}
            </span>
          </button>
          <p className="conn-text" id="conn-mode-text" data-testid="connection-text">
            {t(online ? 'connection.onlineText' : 'connection.offlineText')}
          </p>
          {online && !networkUp && (
            <p className="conn-note" role="status" data-testid="connection-no-network">
              <Icon name="warn" size={14} />
              {t('connection.noNetwork')}
            </p>
          )}
          {notSaved && (
            <p className="conn-note" role="alert">
              <Icon name="warn" size={14} />
              {t('settings.notSaved', { error: notSaved })}
            </p>
          )}
          <div className="conn-links">
            <button
              type="button"
              className="conn-link"
              aria-disabled={!online}
              data-testid="connection-maps"
              onClick={() => {
                if (online) settings('maps');
              }}
            >
              <Icon name="download" size={14} />
              <span>{t('connection.maps')}</span>
              <span className="conn-hint">
                {t(online ? 'connection.mapsHint' : 'connection.mapsOffline')}
              </span>
            </button>
            <button
              type="button"
              className="conn-link"
              title={t(status.cloudTip)}
              data-testid="connection-cloud"
              onClick={() => {
                settings('privacy');
              }}
            >
              <Icon name="agent" size={14} />
              <span>{t('connection.cloud')}</span>
              <span className="conn-hint" data-state={status.cloud}>
                <span className={status.cloudActive ? 'dot' : 'dot off'} />
                {t(status.cloudWord)}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
