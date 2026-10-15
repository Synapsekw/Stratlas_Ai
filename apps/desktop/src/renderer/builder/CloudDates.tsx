// The survey day of each Bentley .zpc cloud, asked in Add data before it is imported (ruling of
// 15 Oct 2026): the file only carries the day it was exported, so that day is a default the person
// confirms or corrects. The chosen day goes to the job (`pointcloud.to_copc` surveyDate), which
// files the cloud under the project's date of that day.
import { formatDate, Icon, useT } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useState } from 'react';
import { SurveyDateOptions, type SurveyDateChoice } from '../change/SurveyDate';
import { builder, type CloudDatesPrompt } from './state';

interface Capture {
  id: string;
  date: string;
  label: string;
}

const NO_CAPTURES: readonly Capture[] = [];

/**
 * The choice a cloud's row starts with: the project's date of the header day when it has one,
 * else a new date with that day filled in; Not dated when the file carries no day.
 */
export function cloudDateDefault(
  headerDay: string | null,
  captures: readonly Capture[],
): SurveyDateChoice {
  if (headerDay === null) return { kind: 'capture', id: '' };
  const same = captures.find((c) => c.date === headerDay);
  return same ? { kind: 'capture', id: same.id } : { kind: 'new', day: headerDay };
}

/**
 * The day a row hands main: the date's day, null for Not dated, undefined while a new day is not
 * filled in (the card cannot be confirmed then).
 */
export function cloudDayOf(
  choice: SurveyDateChoice,
  captures: readonly Capture[],
): string | null | undefined {
  if (choice.kind === 'new') return choice.day || undefined;
  if (!choice.id) return null;
  return captures.find((c) => c.id === choice.id)?.date ?? null;
}

/** One row per cloud: its name, the survey date options and where the default came from. */
export function CloudDatesCard({ p }: { p: CloudDatesPrompt }) {
  const t = useT();
  const captures = useWorkspace((s) => s.project?.manifest.captures ?? NO_CAPTURES);
  const [choices, setChoices] = useState<SurveyDateChoice[]>(() =>
    p.clouds.map((c) => cloudDateDefault(c.headerDay, captures)),
  );
  const days = choices.map((c) => cloudDayOf(c, captures));
  const ready = days.every((d) => d !== undefined);
  const choose = (i: number, next: SurveyDateChoice) => {
    setChoices((all) => all.map((c, k) => (k === i ? next : c)));
  };
  const confirm = () => {
    const dates: Record<string, string | null> = {};
    p.clouds.forEach((c, i) => {
      const day = days[i];
      if (day !== undefined) dates[c.path] = day;
    });
    void builder.getState().confirmCloudDates(dates);
  };
  const title = t('builder.cloudDate.title', { count: p.clouds.length });
  return (
    <section className="b-import" aria-label={title} data-testid="cloud-dates-prompt">
      <header role="none">
        <Icon name="calendar-plus" size={14} />
        {title}
      </header>
      <div className="b-heights">
        {p.clouds.map((c, i) => (
          <div key={c.path} className="survey-date" data-testid={`cloud-date-${String(i)}`}>
            <p className="small">{c.name}</p>
            <SurveyDateOptions
              captures={captures}
              value={choices[i] ?? { kind: 'capture', id: '' }}
              onChange={(next) => {
                choose(i, next);
              }}
              onCloseNew={() => {
                choose(i, { kind: 'capture', id: '' });
              }}
              suggestedDay={c.headerDay ?? undefined}
              testId={`cloud-date-${String(i)}`}
              label={t('builder.cloudDate.label')}
              noneLabel={t('change.surveyDateNone')}
            />
            <p className="faint small">
              {c.headerDay
                ? t('builder.cloudDate.fromHeader', { date: formatDate(c.headerDay) })
                : t('builder.cloudDate.noHeader')}
            </p>
          </div>
        ))}
        <div className="b-heights-actions">
          <button
            type="button"
            className="btn ghost sm"
            data-testid="cloud-dates-cancel"
            onClick={() => {
              builder.getState().cancelCloudDates();
            }}
          >
            {t('builder.cloudDate.cancel')}
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={!ready}
            data-testid="cloud-dates-confirm"
            onClick={confirm}
          >
            {t('builder.cloudDate.import')}
          </button>
        </div>
      </div>
    </section>
  );
}
