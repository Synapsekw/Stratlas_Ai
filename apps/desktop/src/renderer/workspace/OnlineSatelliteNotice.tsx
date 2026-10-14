/**
 * The one-time notice of each provider (`onlineSatellite.ts`): what is requested, from whom, how
 * old and how coarse the imagery is, with **Switch on** and **Cancel**. Rendered by every place
 * that offers the switch (Settings, the Map menus); it shows only while a first "switch on" of a
 * provider waits for the person's answer, and closes without switching anything on when the place
 * it is shown in goes away.
 */
import { onlineSource, type OnlineProvider } from '@aio/schema';
import { Icon, useT, type MessageKey } from '@aio/ui';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { onlineSatelliteSwitch } from './onlineSatellite';

const NOTICE: Record<OnlineProvider, MessageKey> = {
  eox: 'online.notice.eox',
  esri: 'online.notice.esri',
  mapbox: 'online.notice.mapbox',
};

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
  // in a short popover or a long page the question must be in view, with its two buttons
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (asking && el && typeof el.scrollIntoView === 'function')
      el.scrollIntoView({ block: 'nearest' });
  }, [asking]);
  if (!asking)
    return error ? (
      <p className="prov-err" role="alert" data-testid="online-satellite-error">
        {error}
      </p>
    ) : null;
  const provider = onlineSource(asking)?.provider ?? 'eox';
  return (
    <div
      ref={box}
      className={`notice warn os-notice ${className}`.trim()}
      role="alert"
      data-testid="online-satellite-notice"
      data-provider={provider}
    >
      <Icon name="warn" size={14} />
      <span>{t(NOTICE[provider])}</span>
      <span className="os-acts">
        <button
          type="button"
          className="btn sm primary"
          onClick={() => {
            onlineSatelliteSwitch.getState().confirm();
          }}
        >
          {t('online.confirm')}
        </button>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            onlineSatelliteSwitch.getState().cancel();
          }}
        >
          {t('online.cancel')}
        </button>
      </span>
    </div>
  );
}
