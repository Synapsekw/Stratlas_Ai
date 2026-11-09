import type { InspectorMission, InspectorScan } from '@aio/schema';
import { Button, Dialog, useT } from '@aio/ui';
import { chamberTick, importable, missionRequest, missionTotals, type Choice } from './pickerModel';
import {
  closeInspectorPicker,
  confirmInspectorPicker,
  pickerMission,
  toggleChamberTick,
  toggleFlightTick,
  toggleInspectionTick,
  usePicker,
} from './pickerStore';
import './flyability.css';

const ALIGNED = {
  relocalised: 'fly.picker.aligned.relocalised',
  transform: 'fly.picker.aligned.transform',
  reference: 'fly.picker.aligned.reference',
} as const;

type Inspection = InspectorScan['inspections'][number];

function InspectionRow({ i, choice }: { i: Inspection; choice: Choice }) {
  const t = useT();
  const c = choice.inspections[i.id] ?? { on: false, flights: [] };
  const usable = i.flights.filter(importable);
  const all = usable.length > 0 && usable.every((f) => c.flights.includes(f.id));
  return (
    <section className="fly-insp" data-testid={`inspector-row-${i.id}`}>
      <label className="fly-insp-head">
        <input
          type="checkbox"
          checked={all || (c.on && usable.length === 0)}
          ref={(el) => {
            if (el) el.indeterminate = c.on && !all && usable.length > 0;
          }}
          onChange={() => {
            toggleInspectionTick(i.id);
          }}
          aria-describedby={i.importedAs !== null ? `inspector-merge-${i.id}` : undefined}
          data-testid={`inspector-tick-${i.id}`}
        />
        <span className="fly-insp-name">{i.name}</span>
      </label>
      <div className="fly-insp-meta">
        <span>{i.mergedCloud ? t('fly.picker.merged') : t('fly.picker.noMerged')}</span>
        <span>{t('fly.picker.findings', { count: i.findings })}</span>
        {i.importedAs !== null && (
          <span
            id={`inspector-merge-${i.id}`}
            className="fly-insp-merge"
            data-testid={`inspector-imported-${i.id}`}
          >
            {t('fly.picker.imported')}
          </span>
        )}
      </div>
      {i.flights.length > 0 && (
        <ul className="fly-flights" aria-label={t('fly.picker.flights')}>
          {i.flights.map((f) => (
            <li key={f.id} className="fly-flight" data-empty={!importable(f)}>
              <label className="fly-flight-label">
                <input
                  type="checkbox"
                  disabled={!importable(f)}
                  aria-describedby={`inspector-note-${f.id}`}
                  checked={c.flights.includes(f.id)}
                  onChange={() => {
                    toggleFlightTick(i.id, f.id);
                  }}
                  data-testid={`inspector-flight-${f.id}`}
                />
                <span>{f.name}</span>
              </label>
              <span
                className="fly-flight-note"
                id={`inspector-note-${f.id}`}
                data-testid={`inspector-note-${f.id}`}
              >
                {importable(f) ? t(ALIGNED[f.aligned]) : t('fly.picker.noData')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One chamber of a mission folder: its tick, what it holds, then its inspections. */
function ChamberBlock({
  index,
  chamber,
  choice,
  shown,
}: {
  index: number;
  chamber: InspectorMission['exports'][number];
  choice: Choice;
  shown: ReadonlySet<string>;
}) {
  const t = useT();
  const tick = chamberTick(choice, chamber.scan);
  const insp = chamber.scan.inspections;
  const one = missionTotals({ ...emptyMission, exports: [chamber] });
  const flights = insp.reduce((n, i) => n + i.flights.length, 0);
  const findings = insp.reduce((n, i) => n + i.findings, 0);
  return (
    <section
      className="fly-chamber"
      aria-labelledby={`inspector-chamber-name-${String(index)}`}
      data-testid={`inspector-chamber-${String(index)}`}
    >
      <label className="fly-chamber-head">
        <input
          type="checkbox"
          checked={tick === 'all'}
          ref={(el) => {
            if (el) el.indeterminate = tick === 'some';
          }}
          onChange={() => {
            toggleChamberTick(chamber.path);
          }}
          aria-label={t('fly.picker.chamber', { name: chamber.name })}
          data-testid={`inspector-chamber-tick-${String(index)}`}
        />
        <span className="fly-chamber-name" id={`inspector-chamber-name-${String(index)}`}>
          {chamber.name}
        </span>
      </label>
      <p className="fly-chamber-meta">
        {[
          t('fly.picker.inspections', { count: insp.length }),
          t('fly.picker.flightCount', { count: flights }),
          t('fly.picker.findings', { count: findings }),
          t('fly.picker.photos', { count: one.photos }),
          t('fly.picker.clouds', { count: one.clouds }),
        ].join(' · ')}
      </p>
      <div className="fly-chamber-list">
        {insp
          .filter((i) => shown.has(i.id))
          .map((i) => (
            <InspectionRow key={i.id} i={i} choice={choice} />
          ))}
      </div>
    </section>
  );
}

const emptyMission: InspectorMission = {
  root: '',
  exports: [],
  skipped: { folders: [], files: 0 },
  capped: false,
};

/** What was found and what was left out, above the list. */
function MissionSummary({ mission }: { mission: InspectorMission }) {
  const t = useT();
  const totals = missionTotals(mission);
  const { folders, files } = mission.skipped;
  const left = [
    ...(folders.length > 0 ? [t('fly.picker.skippedFolders', { count: folders.length })] : []),
    ...(files > 0 ? [t('fly.picker.skippedFiles', { count: files })] : []),
  ];
  return (
    <div className="fly-summary">
      <p className="fly-summary-found" data-testid="inspector-summary">
        {[
          t('fly.picker.chambers', { count: totals.chambers }),
          t('fly.picker.photos', { count: totals.photos }),
          t('fly.picker.clouds', { count: totals.clouds }),
        ].join(', ')}
      </p>
      {left.length > 0 &&
        (folders.length > 0 ? (
          <details className="fly-skipped" data-testid="inspector-skipped">
            <summary>{left.join(', ')}</summary>
            <p className="fly-skipped-note">{t('fly.picker.skippedList')}</p>
            <ul className="fly-skipped-list">
              {folders.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="fly-skipped" data-testid="inspector-skipped">
            {left.join(', ')}
          </p>
        ))}
      {mission.capped && (
        <p className="fly-capped" role="status" data-testid="inspector-capped">
          {t('fly.picker.capped')}
        </p>
      )}
    </div>
  );
}

/**
 * The dialog that asks which chambers, inspections and flights of a Flyability mission folder (or
 * one export) to bring in. Several chambers are listed each with its tick and counts; one export
 * lists its inspections directly. A folder with no export says so with a hint.
 */
export function InspectorPickerHost() {
  const t = useT();
  const path = usePicker((s) => s.path);
  const bare = usePicker((s) => s.mission ?? null);
  const scan = usePicker((s) => s.scan);
  const choice = usePicker((s) => s.choice);
  const mission = pickerMission({ path, mission: bare, scan, choice });
  if (path === null || !mission || !choice) return null;
  const ready = missionRequest(choice, mission) !== null;
  const none = mission.exports.length === 0;
  // an inspection listed under an earlier chamber is not shown twice
  const seen = new Set<string>();
  const shownBy = mission.exports.map((e) => {
    const mine = new Set<string>();
    for (const i of e.scan.inspections)
      if (!seen.has(i.id)) {
        seen.add(i.id);
        mine.add(i.id);
      }
    return mine;
  });
  return (
    <Dialog
      open
      size="lg"
      testId="inspector-picker"
      title={t('fly.picker.title')}
      description={t('fly.picker.description')}
      onClose={closeInspectorPicker}
      footer={
        <>
          <Button variant="quiet" onClick={closeInspectorPicker} data-testid="inspector-cancel">
            {t('fly.picker.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => void confirmInspectorPicker()}
            data-testid="inspector-import"
          >
            {t('fly.picker.import')}
          </Button>
        </>
      }
    >
      <div className="fly-picker">
        {none ? (
          <div className="fly-none" data-testid="inspector-none-found">
            <p className="fly-none-title">{t('fly.picker.noneFound')}</p>
            <p className="fly-none-hint">{t('fly.picker.noneHint')}</p>
            {mission.capped && (
              <p className="fly-capped" role="status" data-testid="inspector-capped">
                {t('fly.picker.capped')}
              </p>
            )}
          </div>
        ) : (
          <>
            <MissionSummary mission={mission} />
            <div className="fly-picker-list" data-testid="inspector-list">
              {mission.exports.length === 1
                ? (mission.exports[0]?.scan.inspections ?? []).map((i) => (
                    <InspectionRow key={i.id} i={i} choice={choice} />
                  ))
                : mission.exports.map((e, k) => (
                    <ChamberBlock
                      key={e.path}
                      index={k}
                      chamber={e}
                      choice={choice}
                      shown={shownBy[k] ?? new Set()}
                    />
                  ))}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
