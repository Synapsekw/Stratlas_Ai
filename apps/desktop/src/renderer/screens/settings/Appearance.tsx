import type { Settings } from '@aio/schema';
import { Switch, t } from '@aio/ui';
import { useSyncExternalStore } from 'react';
import { shell, useShell } from '../../shell';
import { OS_QUERIES } from '../../theme';

const THEMES: { value: Settings['theme']; label: 'dark' | 'light' | 'system' }[] = [
  { value: 'dark', label: 'dark' },
  { value: 'light', label: 'light' },
  { value: 'system', label: 'system' },
];

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener('change', cb);
      return () => {
        m.removeEventListener('change', cb);
      };
    },
    () => window.matchMedia(query).matches,
  );
}

/** A miniature of the shell in one theme (sidebar, title bar, panel, accent). */
function Preview({ theme }: { theme: 'dark' | 'light' | 'system' }) {
  return (
    <span className={`theme-pv ${theme}`} aria-hidden="true">
      <i className="tb" />
      <i className="sb" />
      <i className="pn" />
      <i className="ac" />
    </span>
  );
}

export function Appearance() {
  const theme = useShell((s) => s.settings.theme);
  const direction = useShell((s) => s.settings.direction ?? 'ltr');
  const prefersDark = useMedia(OS_QUERIES.dark);
  const osContrast = useMedia(OS_QUERIES.moreContrast);
  const osMotion = useMedia(OS_QUERIES.reducedMotion);
  const contrast = useShell((s) => s.settings.contrast ?? 'system');
  const motion = useShell((s) => s.settings.motion ?? 'system');
  const os = (on: boolean) => t(on ? 'settings.appearance.osOn' : 'settings.appearance.osOff');
  const set = (patch: Partial<Settings>) => void shell.getState().updateSettings(patch);

  return (
    <>
      <div className="sblock">
        <h2>{t('settings.appearance.theme')}</h2>
        <div className="theme-pick" role="radiogroup" aria-label={t('settings.appearance.theme')}>
          {THEMES.map((th) => (
            <button
              key={th.value}
              type="button"
              role="radio"
              aria-checked={theme === th.value}
              className="theme-opt"
              onClick={() => {
                set({ theme: th.value });
              }}
            >
              <Preview theme={th.value} />
              <b>{t(`settings.appearance.${th.label}`)}</b>
              {th.value === 'system' && (
                <span className="faint">
                  {t('settings.appearance.systemNow', {
                    theme: t(
                      prefersDark ? 'settings.appearance.dark' : 'settings.appearance.light',
                    ),
                  })}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="sblock">
        <h2>{t('settings.appearance.direction')}</h2>
        <p className="help">{t('settings.appearance.directionHelp')}</p>
        <div className="seg" role="group" aria-label={t('settings.appearance.direction')}>
          <button
            type="button"
            aria-pressed={direction === 'ltr'}
            onClick={() => {
              set({ direction: 'ltr' });
            }}
          >
            {t('settings.appearance.ltr')}
          </button>
          <button
            type="button"
            aria-pressed={direction === 'rtl'}
            onClick={() => {
              set({ direction: 'rtl' });
            }}
          >
            {t('settings.appearance.rtl')}
          </button>
        </div>
      </div>
      <div className="sblock" data-testid="access-settings">
        <h2>{t('settings.appearance.access')}</h2>
        <div className="opt">
          <b>{t('settings.appearance.contrast')}</b>
          <span>{t('settings.appearance.contrastHelp', { state: os(osContrast) })}</span>
          <Switch
            checked={contrast === 'more'}
            label={t('settings.appearance.contrast')}
            onChange={(on) => {
              set({ contrast: on ? 'more' : 'system' });
            }}
          />
        </div>
        <div className="opt">
          <b>{t('settings.appearance.motion')}</b>
          <span>{t('settings.appearance.motionHelp', { state: os(osMotion) })}</span>
          <Switch
            checked={motion === 'reduce'}
            label={t('settings.appearance.motion')}
            onChange={(on) => {
              set({ motion: on ? 'reduce' : 'system' });
            }}
          />
        </div>
      </div>
      <div className="sblock">
        <h2>{t('settings.appearance.language')}</h2>
        <select className="input" aria-label={t('settings.appearance.language')} disabled>
          <option>{t('settings.appearance.english')}</option>
        </select>
        <p className="help" style={{ marginTop: 8 }}>
          The interface text lives in one message catalogue, ready for an Arabic translation. Map
          labels already switch to Arabic with the language.
        </p>
      </div>
    </>
  );
}
