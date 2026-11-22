/**
 * "Which one is the tower?": shown while a detection run waits for the person to click the tower
 * (`needsHint`), with Cancel. It is shown where Detect antennas is pressed, in Tools > Measure >
 * Telecom and in the Antennas group, so the question is never out of sight; the click on the tower
 * itself is taken once, by `AntennaRunner`, whichever of them is on screen.
 */
import { Button, t } from '@aio/ui';
import type { ReactElement } from 'react';
import { cancelHint, useAntennas } from './antennaStore';

export function AntennaTowerHint(): ReactElement | null {
  const needsHint = useAntennas((s) => s.needsHint);
  if (!needsHint) return null;
  return (
    <div role="status" data-testid="antenna-hint">
      <b>{t('telecom.antennas.hint.title')}</b>
      <p className="telecom-help">{t('telecom.antennas.hint.body')}</p>
      <Button onClick={cancelHint}>{t('telecom.antennas.hint.cancel')}</Button>
    </div>
  );
}
