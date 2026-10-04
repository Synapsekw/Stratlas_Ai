import { Icon, t } from '@aio/ui';
import { bridge } from '../shell';
import {
  CLOUD_FILTERS,
  MAX_SURVEYS,
  RASTER_FILTERS,
  emptySurvey,
  fileName,
  surveyProblem,
  type SurveyInput,
} from './surveys';

async function pickOne(
  title: string,
  filters: { name: string; extensions: string[] }[],
): Promise<string | null> {
  const r = await bridge.call('dialog:openFiles', { title, filters, multi: false });
  return r.ok ? (r.value.paths[0] ?? null) : null;
}

/**
 * Survey dates of a new volumetric project: per date a DSM GeoTIFF or a point cloud, and an
 * optional orthomosaic. The wizard turns them into a `volumetric.build` job.
 */
export function VolumetricSurveys({
  value,
  onChange,
}: {
  value: SurveyInput[];
  onChange: (next: SurveyInput[]) => void;
}) {
  const set = (i: number, patch: Partial<SurveyInput>) => {
    onChange(value.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  };
  const problem = surveyProblem(value);

  return (
    <div className="b-field" data-testid="volumetric-surveys">
      <span>{t('builder.surveys.title')}</span>
      <p className="hint">{t('builder.surveys.text')}</p>
      {value.map((s, i) => (
        <div className="b-survey" key={i} data-testid="survey-row">
          <label className="b-inline">
            <span className="hint">{t('builder.surveys.date')}</span>
            <input
              className="input mono"
              type="date"
              value={s.date}
              aria-label={`${t('builder.surveys.date')} ${String(i + 1)}`}
              onChange={(e) => {
                set(i, { date: e.target.value });
              }}
            />
          </label>
          <div className="b-inline">
            <span className="hint">{t('builder.surveys.surface')}</span>
            <button
              type="button"
              className="btn"
              aria-pressed={Boolean(s.dsm)}
              onClick={() =>
                void pickOne(t('builder.surveys.pickDsm'), RASTER_FILTERS).then((p) => {
                  if (p) set(i, { dsm: p, cloud: '' });
                })
              }
            >
              <Icon name="layers" size={14} />
              {t('builder.surveys.pickDsm')}
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={Boolean(s.cloud)}
              onClick={() =>
                void pickOne(t('builder.surveys.pickCloud'), CLOUD_FILTERS).then((p) => {
                  if (p) set(i, { cloud: p, dsm: '' });
                })
              }
            >
              <Icon name="layers" size={14} />
              {t('builder.surveys.pickCloud')}
            </button>
            <span className="mono small" data-testid="survey-surface" title={s.dsm || s.cloud}>
              {fileName(s.dsm || s.cloud)}
            </span>
          </div>
          <div className="b-inline">
            <span className="hint">{t('builder.surveys.ortho')}</span>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void pickOne(t('builder.surveys.pickOrtho'), RASTER_FILTERS).then((p) => {
                  if (p) set(i, { ortho: p });
                })
              }
            >
              <Icon name="photo" size={14} />
              {t('builder.surveys.pickOrtho')}
            </button>
            <span className="mono small" data-testid="survey-ortho" title={s.ortho}>
              {s.ortho ? fileName(s.ortho) : t('builder.surveys.noOrtho')}
            </span>
            {s.ortho && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  set(i, { ortho: '' });
                }}
              >
                {t('builder.surveys.clear')}
              </button>
            )}
          </div>
          {value.length > 1 && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                onChange(value.filter((_, k) => k !== i));
              }}
            >
              {t('builder.surveys.remove')}
            </button>
          )}
        </div>
      ))}
      {value.length < MAX_SURVEYS && (
        <button
          type="button"
          className="btn"
          onClick={() => {
            onChange([...value, emptySurvey()]);
          }}
        >
          <Icon name="plus" size={14} />
          {t('builder.surveys.add')}
        </button>
      )}
      {problem && <span className="bad">{t(problem)}</span>}
    </div>
  );
}
