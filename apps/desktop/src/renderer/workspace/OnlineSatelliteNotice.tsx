/**
 * The one-time notice of online satellite (`onlineSatellite.ts`): what is requested, from whom,
 * how old and how coarse the imagery is, with **Switch on** and **Cancel**. Rendered by every
 * place that offers the switch (Settings, the map type picker); it shows only while a first
 * "switch on" waits for the person's answer, and closes without switching anything on when the
 * place it is shown in goes away.
 */
import { Icon, useT } from '@aio/ui';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { onlineSatelliteSwitch } from './onlineSatellite';

export function OnlineSatelliteNotice({ className = '' }: { className?: string }) {
  const t = useT();
  const asking = useStore(onlineSatelliteSwitch, (s) => s.asking);
  const error = useStore(onlineSatelliteSwitch, (s) => s.error);
  useEffect(
    () => () => {
      onlineSatelliteSwitch.getState().cancel();
    },
    [],
  );
  if (!asking)
    return error ? (
      <p className="prov-err" role="alert" data-testid="online-satellite-error">
        {error}
      </p>
    ) : null;
  return (
    <div
      className={`notice warn os-notice ${className}`.trim()}
      role="alert"
      data-testid="online-satellite-notice"
    >
      <Icon name="warn" size={14} />
      <span>{t('g7.online.notice')}</span>
      <span className="os-acts">
        <button
          type="button"
          className="btn sm primary"
          onClick={() => {
            onlineSatelliteSwitch.getState().confirm();
          }}
        >
          {t('g7.online.confirm')}
        </button>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            onlineSatelliteSwitch.getState().cancel();
          }}
        >
          {t('g7.online.cancel')}
        </button>
      </span>
    </div>
  );
}
