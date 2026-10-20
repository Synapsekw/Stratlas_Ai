/**
 * The drawn section line of a volumetric project (Volume tools' section line): the panel at the
 * foot of the 3D view while the line is picked and once it is drawn, with the two surveys' heights
 * along it on the app's one profile chart (`ProfileChart`), shaded cut and fill between them, and
 * the area between them. The surveys are the ones Cut / fill compares, else the one before the
 * shown survey and that survey. The line, its picking and its profile live in the volumetric store
 * (@aio/volumetric); the chart is the desktop's, so the package keeps no chart of its own.
 */
import { formatQuantity } from '@aio/geo';
import type { ChartSeries } from '@aio/survey';
import { useT } from '@aio/ui';
import { useVolumetric, volumetric } from '@aio/volumetric';
import { ProfileChart } from '../charts';
import { autoExaggeration } from '../survey/card/slots';
import { useMeasure } from '../survey/measureStore';
import { surveyDateLabel } from './surveyDateLabel';

const NO_CAPTURES: readonly { epoch: string; date: string; label: string }[] = [];

export function VolumeSection() {
  const t = useT();
  const section = useVolumetric((s) => s.section);
  const ready = useVolumetric((s) => s.status === 'ready');
  const captures = useVolumetric((s) => s.file?.captures ?? NO_CAPTURES);
  const settings = useMeasure((s) => s.settings);
  if (!ready || section.mode === 'idle') return null;
  const p = section.profile;
  const from = captures.find((c) => c.epoch === section.pair?.from);
  const to = captures.find((c) => c.epoch === section.pair?.to);
  const series: ChartSeries[] =
    p && from && to
      ? [
          {
            key: 'from',
            label: surveyDateLabel(from),
            kind: 'earlier',
            date: from.date,
            chainage: p.s,
            z: p.z1,
          },
          {
            key: 'to',
            label: surveyDateLabel(to),
            kind: 'current',
            date: to.date,
            chainage: p.s,
            z: p.z2,
          },
        ]
      : [];
  const area = (v: number) => formatQuantity(v, 'area', settings.units, settings.precision);
  return (
    <div className="vol-stage">
      <div className="vol-under">
        <div
          className="vol-secpanel overlay-box"
          role="region"
          aria-label={t('vol.section.title')}
          data-testid="vol-section"
        >
          <div className="vol-row">
            <b>
              {p
                ? t('vol.section.titleLength', {
                    length: formatQuantity(
                      p.lengthM,
                      'distance',
                      settings.units,
                      settings.precision,
                    ),
                  })
                : t('vol.section.title')}
            </b>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                volumetric.getState().clearSection();
              }}
            >
              {t(section.mode === 'picking' ? 'vol.section.cancel' : 'vol.section.clear')}
            </button>
          </div>
          {section.mode === 'picking' ? (
            <p className="vol-note">
              {t(section.points.length === 0 ? 'vol.section.pickStart' : 'vol.section.pickEnd')}
            </p>
          ) : p && series.length ? (
            <>
              <ProfileChart
                series={series}
                shadeVs="from"
                exaggeration={autoExaggeration(series)}
                ends={{ a: 'A', b: 'B' }}
                units={settings.units}
                precision={settings.precision}
                {...(settings.angles ? { angles: settings.angles } : {})}
                height={170}
                testId="vol-section-chart"
              />
              <p className="vol-note">
                <span className="vol-cut" data-testid="vol-sec-cut">
                  {t('chart.cutArea', { v: area(p.cutM2) })}
                </span>{' '}
                ·{' '}
                <span className="vol-fill" data-testid="vol-sec-fill">
                  {t('chart.fillArea', { v: area(p.fillM2) })}
                </span>
              </p>
            </>
          ) : (
            <p className="vol-note">{t('section.sampling')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
