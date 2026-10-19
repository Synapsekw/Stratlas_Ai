/**
 * The Coverage panel, the `rf` workbench tab (spec D20, D21; stage island R2; rf-coverage-simplify
 * "The Coverage panel"): coverage prediction for the telecom site.
 *
 * - **AI card:** Auto-plan & run, set up by hand, Use cell export (`rf/panel/AiCard.tsx`).
 * - **Step 1, Antennas:** accepted and draft units, the inventory link, the include drafts switch,
 *   the tower and its highest antenna.
 * - **Step 2, Sectors & equipment:** group by bearing and add sector, then one row per sector with
 *   its state tag. An open row shows the sector's toggle, name and delete, and one unit's fields:
 *   measured geometry with its basis, band and carrier, the AAU, antenna and radio fields that open
 *   the catalogue picker, the e-tilt slider within the port's range and step, power and loss. The
 *   units in no sector and the settings of antennas no longer found stay listed.
 * - **Step 3, Coverage:** RSRP / Best server / Overlap (the layer, T10, draws the choice),
 *   per-class areas, Run coverage, Save as new run, Export, the indicative label and the
 *   assumptions.
 * - **Advanced (folded):** the study settings (model, environment, where people are, radius,
 *   grid) and the CSV import.
 *
 * Every value lives in the RF store's working copy (`rf/rfStore.ts`) until Save; a run saves first.
 * The coverage layer and its legend are T10.
 */
import { BANDS, PENETRATION_MARGIN_DB, bandOfName, getEntry } from '@aio/rf';
import {
  type MarginPreset,
  type PropagationModel,
  type RfAntennaSettings,
  type RfCarrier,
  type RfCatalogueEntry,
  type RfEnvironment,
  type RfTech,
} from '@aio/schema';
import { Button, Chip, EmptyState, IconButton, Menu, Switch, useT, type MessageKey } from '@aio/ui';
import { useWorkspace } from '@aio/workspace';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { clock } from '../../../processing/JobParts';
import { processingTools, useProcessingTools } from '../../../processingTools';
import { CataloguePicker, watts, type PickKind } from '../../../rf/CataloguePicker';
import { CsvImport } from '../../../rf/CsvImport';
import { pickPort } from '../../../rf/rfDefaults';
import {
  bandwidthChoices,
  carrierBandName,
  clampEtilt,
  defaultBandwidth,
  etiltRangeFor,
  sectorBearing,
  shownEtilt,
  trueAzimuth,
} from '../../../rf/rfFields';
import {
  addSector,
  applyProposal,
  clearSetting,
  deleteSector,
  exportRun,
  loadRf,
  moveUnit,
  patchSettings,
  patchStudy,
  reassignOrphanEntry,
  removeOrphanEntry,
  renameSector,
  rfStore,
  saveRf,
  selectRun,
  setEquipment,
  setHeightOverride,
  setPackStatus,
  setView,
  useRf,
  type RfUnitRow,
  type RfView,
} from '../../../rf/rfStore';
import { startRfRun } from '../../../rf/rfTab';
import { useCoverage } from '../../../rf/coverageStore';
import {
  ENVIRONMENT_KEY,
  EXCLUSION_KEY,
  HEIGHT_BASIS_KEY,
  MARGIN_KEY,
  MODEL_KEY,
  REASSIGN_KEY,
  VALUE_BASIS_KEY,
  VIEW_KEY,
  assumptionsText,
  refusalText,
  warningText,
} from '../../../rf/rfText';
import { AdvancedFold, studySummary } from '../../../rf/panel/AdvancedFold';
import { AutoplanDialog } from '../../../rf/AutoplanDialog';
import { openAntennaReviewOrFallback, startAutoplan } from '../../../rf/autoplan/autoplanStore';
import { AiCard } from '../../../rf/panel/AiCard';
import { CoverageChip } from '../../../rf/CoverageChip';
import { LabelledSwitch, fmt } from '../../../rf/panel/parts';
import { Step } from '../../../rf/panel/Step';
import { StepAntennas } from '../../../rf/panel/StepAntennas';
import { StepSectors, UNGROUPED } from '../../../rf/panel/StepSectors';
import { useSections } from '../sectionState';
import type { TabId } from '../tabsModel';
import '../../../rf/rf.css';
import './benches.css';

const BENCH: TabId = 'rf';

// ---------------------------------------------------------------- store wiring

/**
 * Load the RF files for the open project, and hand the store the installed pack (R9: without it
 * the pack refusal never fires, and Run coverage waits until the pack is known).
 */
function useRfSync(): void {
  const projectId = useWorkspace((s) => s.project?.id ?? null);
  // The tab mounts again each time it comes to the front: read the files again, but keep the
  // person's unsaved edits. Another project starts from a fresh store (`loadRf`), and closing a
  // project resets the store (the RF layer), so a later open of the same project starts clean.
  useEffect(() => {
    if (projectId) void loadRf(projectId, { keepEdits: true });
  }, [projectId]);
  const pack = useProcessingTools((s) => s.status);
  useEffect(() => {
    setPackStatus(
      pack ? { state: pack.state, ...(pack.version ? { version: pack.version } : {}) } : null,
    );
    if (!pack) void processingTools.getState().load();
  }, [pack]);
}

// ---------------------------------------------------------------- small parts

/** One labelled line: the name, the value or control, and a basis mark. */
function Field({
  label,
  children,
  basis,
  hint,
  id,
}: {
  label: string;
  children: ReactNode;
  basis?: ReactNode;
  hint?: ReactNode;
  id?: string;
}) {
  return (
    <div className="rf-field" data-field={id}>
      <span className="rf-k">{label}</span>
      <span className="rf-v">{children}</span>
      <span className="rf-b">{basis}</span>
      {hint !== undefined && <span className="rf-hint">{hint}</span>}
    </div>
  );
}

/** A basis mark: measured values in the accent, defaults dashed in amber ink. */
function Basis({ k, tone }: { k: MessageKey; tone?: 'acc' | 'warn' | 'off' | undefined }) {
  const t = useT();
  return (
    <Chip kind="tag" {...(tone ? { tone } : {})}>
      {t(k)}
    </Chip>
  );
}

const valueTone = (basis: string): 'acc' | undefined =>
  basis === 'measured' || basis === 'observed' ? 'acc' : undefined;

/** A number input that commits on blur or Enter; empty commits undefined. */
function NumberField({
  value,
  placeholder,
  min,
  max,
  step,
  label,
  disabled,
  onCommit,
  testId,
}: {
  value: number | undefined;
  placeholder?: string;
  min: number;
  max: number;
  step: number;
  label: string;
  disabled?: boolean;
  onCommit: (v: number | undefined) => void;
  testId?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = draft.trim() === '' ? undefined : Number(draft);
    setDraft(null);
    if (v === undefined) onCommit(undefined);
    else if (Number.isFinite(v)) onCommit(Math.min(max, Math.max(min, v)));
  };
  return (
    <input
      className="input rf-num mono"
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={draft ?? (value === undefined ? '' : String(value))}
      placeholder={placeholder}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onChange={(e) => {
        setDraft(e.target.value);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

// ---------------------------------------------------------------- save bar

function SaveBar() {
  const t = useT();
  const dirty = useRf((s) => s.dirty);
  const saving = useRf((s) => s.saving);
  const readOnly = useRf((s) => s.readOnly);
  const warnings = useRf((s) => s.writeWarnings);
  const projectId = useRf((s) => s.projectId);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (readOnly)
    return (
      <p className="rf-note" data-testid="rf-readonly">
        {t('rf.readOnly')}
      </p>
    );
  return (
    <>
      {dirty && (
        <div className="rf-savebar" role="status">
          <span>{t('rf.unsaved')}</span>
          <Button
            onClick={() => {
              if (projectId) void loadRf(projectId);
              setError(null);
            }}
          >
            {t('rf.revert')}
          </Button>
          <Button
            variant="primary"
            busy={saving}
            data-testid="rf-save"
            onClick={() => {
              void saveRf().then((r) => {
                if (r.ok) {
                  setError(null);
                  setSaved(true);
                } else
                  setError(
                    r.code === 'refused' ? r.message || t('rf.saveFailed') : t('rf.saveFailed'),
                  );
              });
            }}
          >
            {t('rf.save')}
          </Button>
        </div>
      )}
      {error && (
        <p className="rf-note rf-err" role="alert">
          {error}
        </p>
      )}
      {!dirty && saved && warnings.length > 0 && (
        <div className="rf-warnbox" role="status" data-testid="rf-write-warnings">
          <b>{t('rf.writeWarnings')}</b>
          <ul>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Step 2: sectors

/** Above the step 2 rows: group by bearing and add a sector. */
function SectorToolbar() {
  const t = useT();
  const proposed = useRf((s) => s.proposed);
  const readOnly = useRf((s) => s.readOnly);
  return (
    <div className="rf-actions">
      <Button
        icon="refresh"
        disabledReason={
          readOnly
            ? t('rf.refusal.readOnly')
            : proposed.length === 0
              ? t('rf.sectors.nothingToGroup')
              : undefined
        }
        tip={t('rf.sectors.groupTip')}
        onClick={applyProposal}
      >
        {t('rf.sectors.group')}
      </Button>
      <Button icon="plus" disabled={readOnly} onClick={() => void addSector()}>
        {t('rf.sectors.add')}
      </Button>
    </div>
  );
}

/** At the top of an open sector row: its toggle, name, unit count and delete. */
function SectorManage({ sectorId }: { sectorId: string }) {
  const t = useT();
  const sec = useRf((s) => s.sectors.sectors.find((x) => x.id === sectorId) ?? null);
  const settings = useRf((s) => s.sectors.antennas);
  const units = useRf((s) => s.antennas?.units ?? []);
  const readOnly = useRf((s) => s.readOnly);
  const [kept, setKept] = useState(false);
  if (!sec) return null;
  const activeOf = (ids: readonly string[]) =>
    ids.length > 0 && ids.some((id) => settings.find((a) => a.antennaId === id)?.active ?? true);
  const bearing = sectorBearing(sec.antennaIds, units);
  const live = sec.antennaIds.filter((id) => units.some((u) => u.id === id));
  return (
    <div className="rf-sector" data-sector={sec.id}>
      <Switch
        checked={activeOf(live)}
        disabled={readOnly || live.length === 0}
        label={t('rf.sectors.toggle', { name: sec.name })}
        onChange={(on) => {
          for (const id of live) patchSettings(id, { active: on });
        }}
      />
      <input
        className="input rf-sector-name"
        defaultValue={sec.name}
        key={sec.name}
        aria-label={t('rf.sectors.rename', { name: sec.name })}
        disabled={readOnly}
        onBlur={(e) => {
          renameSector(sec.id, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      <span className="rf-sector-meta mono">
        {t('rf.sectors.meta', {
          count: live.length,
          bearing: bearing === null ? t('rf.sectors.noBearing') : `${fmt(bearing, 0)}°`,
        })}
      </span>
      <IconButton
        icon="trash"
        label={t('rf.sectors.delete', { name: sec.name })}
        disabled={readOnly}
        onClick={() => {
          deleteSector(sec.id);
          setKept(rfStore.getState().sectors.sectors.some((x) => x.id === sec.id));
        }}
      />
      {kept && (
        <p className="rf-note rf-warn-ink" role="status" data-testid="rf-sector-kept">
          {t('rf.sectors.keptForOrphans', { name: sec.name })}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Advanced: study

const MODELS: readonly PropagationModel[] = [
  'tr38901',
  'okumura-hata',
  'cost231-hata',
  'free-space',
];
const ENVIRONMENTS: readonly RfEnvironment[] = ['uma', 'umi', 'rma'];
const MARGINS: readonly MarginPreset[] = ['outdoor', 'in-car', 'indoor', 'deep-indoor'];

function StudySettings() {
  const t = useT();
  const study = useRf((s) => s.sectors.study);
  const readOnly = useRf((s) => s.readOnly);
  return (
    <div className="rf-group" data-testid="rf-study">
      <Field label={t('rf.study.model')}>
        <select
          className="input"
          value={study.model}
          disabled={readOnly}
          aria-label={t('rf.study.model')}
          onChange={(e) => {
            patchStudy({ model: e.target.value as PropagationModel });
          }}
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {t(MODEL_KEY[m])}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('rf.study.environment')}>
        <select
          className="input"
          value={study.environment}
          disabled={readOnly || study.model !== 'tr38901'}
          aria-label={t('rf.study.environment')}
          onChange={(e) => {
            patchStudy({ environment: e.target.value as RfEnvironment });
          }}
        >
          {ENVIRONMENTS.map((m) => (
            <option key={m} value={m}>
              {t(ENVIRONMENT_KEY[m])}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('rf.study.margin')}>
        <div className="seg rf-seg-full" role="group" aria-label={t('rf.study.margin')}>
          {MARGINS.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={study.marginPreset === m}
              disabled={readOnly}
              onClick={() => {
                patchStudy({ marginPreset: m });
              }}
            >
              {t(MARGIN_KEY[m])}
              {PENETRATION_MARGIN_DB[m] > 0 && (
                <span className="rf-faint">
                  {t('rf.study.marginDb', { db: PENETRATION_MARGIN_DB[m] })}
                </span>
              )}
            </button>
          ))}
        </div>
      </Field>
      <Field label={t('rf.study.radius')} hint={t('rf.study.radiusHint')}>
        <NumberField
          value={study.radiusM}
          min={100}
          max={15000}
          step={100}
          label={t('rf.study.radius')}
          disabled={readOnly}
          onCommit={(v) => {
            patchStudy({ radiusM: v ?? 3000 });
          }}
        />
      </Field>
      <Field label={t('rf.study.grid')} hint={t('rf.study.gridHint')}>
        <NumberField
          value={study.gridResolutionM}
          min={5}
          max={50}
          step={1}
          label={t('rf.study.grid')}
          disabled={readOnly}
          onCommit={(v) => {
            patchStudy({ gridResolutionM: v ?? 10 });
          }}
        />
      </Field>
      <p className="rf-note">
        {t('rf.study.always', { body: study.bodyLossDb, ue: study.ueHeightM })}
      </p>
    </div>
  );
}

function Orphans() {
  const t = useT();
  const orphans = useRf((s) => s.orphans);
  const rows = useRf((s) => s.rows);
  const settings = useRf((s) => s.sectors.antennas);
  const readOnly = useRf((s) => s.readOnly);
  const [error, setError] = useState<string | null>(null);
  if (orphans.length === 0) return null;
  const free = rows.filter((r) => !settings.some((a) => a.antennaId === r.id));
  return (
    <div className="rf-group" data-testid="rf-orphans">
      <h4 className="rf-sub">{t('rf.orphans.title')}</h4>
      <p className="rf-note">{t('rf.orphans.body')}</p>
      {orphans.map((o) => (
        <div key={o.antennaId} className="rf-orphan">
          <span className="mono">{o.antennaId}</span>
          <span className="rf-faint">{t(`rf.orphans.reason.${o.reason}`)}</span>
          <select
            className="input"
            value=""
            disabled={readOnly || free.length === 0}
            aria-label={t('rf.orphans.reassign', { id: o.antennaId })}
            onChange={(e) => {
              const r = reassignOrphanEntry(o.antennaId, e.target.value);
              setError(r === null ? null : t(REASSIGN_KEY[r]));
            }}
          >
            <option value="">{t('rf.orphans.reassignTo')}</option>
            {free.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <Button
            variant="danger"
            disabled={readOnly}
            onClick={() => {
              removeOrphanEntry(o.antennaId);
            }}
          >
            {t('rf.orphans.remove')}
          </Button>
        </div>
      ))}
      {error && (
        <p className="rf-note rf-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The CSV import, under Advanced. */
function CsvImportButton() {
  const t = useT();
  const readOnly = useRf((s) => s.readOnly);
  const [csv, setCsv] = useState<HTMLElement | null>(null);
  return (
    <>
      <div className="rf-actions">
        <Button
          icon="import"
          disabledReason={readOnly ? t('rf.refusal.readOnly') : undefined}
          data-testid="rf-csv-open"
          onClick={(e) => {
            setCsv(e.currentTarget);
          }}
        >
          {t('rf.csv.open')}
        </Button>
      </div>
      {csv && (
        <CsvImport
          opener={csv}
          onClose={() => {
            setCsv(null);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- Step 1: antennas

/** Under step 1: the tower's units and its highest antenna. */
function SiteFacts() {
  const t = useT();
  const antennas = useRf((s) => s.antennas);
  const rows = useRf((s) => s.rows);
  const units = antennas?.units ?? [];
  const panels = units.filter((u) => u.kind === 'panel' && u.status === 'accepted').length;
  const heights = rows.flatMap((r) => (r.height.heightM === null ? [] : [r.height]));
  const top = heights.reduce<(typeof heights)[number] | null>(
    (a, b) => (a === null || (b.heightM ?? 0) > (a.heightM ?? 0) ? b : a),
    null,
  );
  return (
    <div className="rf-group">
      <Field label={t('rf.site.units')}>
        <span>{t('rf.site.unitsValue', { panels, count: units.length })}</span>
      </Field>
      <Field
        label={t('rf.site.height')}
        basis={
          top?.basis ? (
            <Basis
              k={HEIGHT_BASIS_KEY[top.basis]}
              tone={top.basis === 'measured' ? 'acc' : 'warn'}
            />
          ) : null
        }
      >
        <span className="mono">
          {top?.heightM == null
            ? t('rf.site.heightUnknown')
            : t('rf.site.heightValue', { m: fmt(top.heightM) })}
        </span>
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------- Sector

interface Picking {
  kinds: readonly PickKind[];
  initial: PickKind;
  opener: HTMLElement | null;
}

const carrierOf = (s: RfAntennaSettings | null): RfCarrier | undefined => s?.carriers[0];

/** A change to the first carrier; an undefined field is cleared (back to the job's default). */
type CarrierPatch = { [K in keyof RfCarrier]?: RfCarrier[K] | undefined };

function patchCarrier(antennaId: string, s: RfAntennaSettings | null, patch: CarrierPatch) {
  const c = carrierOf(s);
  if (!c) return;
  const merged: Record<string, unknown> = { ...c, ...patch };
  const next = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
  patchSettings(antennaId, { carriers: [next as RfCarrier, ...(s?.carriers.slice(1) ?? [])] });
}

const entryName = (e: RfCatalogueEntry | undefined, id: string | undefined): string =>
  e ? `${e.vendor} ${e.model}` : (id ?? '');

function UnitFields({ row }: { row: RfUnitRow }) {
  const t = useT();
  const unit = useRf((s) => s.antennas?.units.find((u) => u.id === row.id) ?? null);
  const all = useRf((s) => s.catalogue);
  const sectors = useRf((s) => s.sectors.sectors);
  const readOnly = useRf((s) => s.readOnly);
  const catalogue = useMemo(() => all.map((c) => c.entry), [all]);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!unit) return null;
  const s = row.settings;
  const eq = s?.equipment;
  const aau = eq?.kind === 'aau' ? getEntry(catalogue, eq.aau) : undefined;
  const antenna = eq?.kind === 'separate' ? getEntry(catalogue, eq.antenna) : undefined;
  const radio = eq?.kind === 'separate' && eq.radio ? getEntry(catalogue, eq.radio) : undefined;
  const carrier = carrierOf(s);
  const band = carrier ? bandOfName(carrier.band) : undefined;
  const range = etiltRangeFor(s, catalogue);
  const resolved = row.carriers.find((c) => c.carrierId === carrier?.id);
  const isAau = eq?.kind === 'aau';
  const az = trueAzimuth(unit);
  const grid = unit.azimuthGridDeg;
  const tilt = unit.downtiltDeg;
  const builtIn = isAau ? t('rf.sector.builtIn') : undefined;
  const ro = readOnly ? t('rf.refusal.readOnly') : undefined;

  const onPick = (e: RfCatalogueEntry) => {
    setPicking(null);
    // one rule for the picker and the CSV import (rfFields.withEquipment)
    setNote(setEquipment(row.id, e) ? null : t('rf.sector.radioNeedsAntenna'));
  };

  const setBand = (id: string) => {
    const b = bandOfName(id);
    if (!b) return;
    const tech: RfTech =
      carrier?.tech === 'nr' && b.nrBand !== null
        ? 'nr'
        : b.lteBands.length > 0
          ? (carrier?.tech ?? 'lte')
          : 'nr';
    if (!carrier) {
      patchSettings(row.id, {
        carriers: [
          {
            id: 'c1',
            tech,
            band: carrierBandName({ band: b.id, tech }),
            bandwidthMhz: defaultBandwidth(tech, b.id),
            feederLossDb: 0,
          },
        ],
      });
      return;
    }
    const choices = bandwidthChoices(tech, b.id);
    patchCarrier(row.id, s, {
      band: carrierBandName({ band: b.id, tech }),
      tech,
      scsKhz: undefined,
      bandwidthMhz: choices.includes(carrier.bandwidthMhz)
        ? carrier.bandwidthMhz
        : defaultBandwidth(tech, b.id),
    });
  };

  const tiltValue = range ? shownEtilt(s, range) : 0;
  const setTilt = (v: number) => {
    if (range) patchSettings(row.id, { etiltDeg: clampEtilt(v, range) });
  };
  const defaultPower = resolved && resolved.powerBasis !== 'set' ? resolved.powerDbm : undefined;
  const powerLabel = isAau ? t('rf.sector.aauPower') : t('rf.sector.portPower');

  return (
    <div className="rf-sec" data-testid={`rf-unit-${row.id}`}>
      {row.excluded && (
        <p className="rf-note rf-warn-ink" data-testid="rf-excluded">
          {t('rf.sector.leftOut', { reason: t(EXCLUSION_KEY[row.excluded]) })}
        </p>
      )}
      <h4 className="rf-sub">{t('rf.sector.geometry')}</h4>
      <Field
        id="azimuth"
        label={t('rf.sector.azimuth')}
        basis={
          grid ? (
            <Basis
              k={VALUE_BASIS_KEY[grid.basis] ?? 'rf.basis.measured'}
              tone={valueTone(grid.basis)}
            />
          ) : null
        }
      >
        <span className="mono">
          {grid === undefined
            ? t('rf.sector.noAzimuth')
            : az === null
              ? t('rf.sector.azimuthGridOnly', { grid: fmt(grid.value) })
              : t('rf.sector.azimuthValue', { true: fmt(az), grid: fmt(grid.value) })}
        </span>
      </Field>
      <Field
        id="downtilt"
        label={t('rf.sector.downtilt')}
        basis={
          tilt ? (
            <Basis
              k={VALUE_BASIS_KEY[tilt.basis] ?? 'rf.basis.measured'}
              tone={valueTone(tilt.basis)}
            />
          ) : null
        }
        hint={t('rf.sector.downtiltHint')}
      >
        <span className="mono">{tilt ? `${fmt(tilt.value)}°` : t('rf.sector.unknown')}</span>
      </Field>
      <Field
        id="height"
        label={t('rf.sector.height')}
        basis={
          row.height.basis ? (
            <Basis
              k={HEIGHT_BASIS_KEY[row.height.basis]}
              tone={
                row.height.basis === 'measured'
                  ? 'acc'
                  : row.height.basis === 'estimated'
                    ? 'warn'
                    : undefined
              }
            />
          ) : (
            <Basis k="rf.basis.unknown" tone="off" />
          )
        }
        hint={
          row.height.issue === 'not-above-ground'
            ? t('rf.sector.heightBelow')
            : row.height.basis === 'user'
              ? t('rf.sector.heightTyped')
              : t('rf.sector.heightHint')
        }
      >
        <span className="rf-inline">
          <NumberField
            value={
              row.height.heightM === null ? undefined : Math.round(row.height.heightM * 10) / 10
            }
            placeholder={t('rf.sector.heightPlaceholder')}
            min={0}
            max={1000}
            step={0.1}
            label={t('rf.sector.height')}
            disabled={readOnly}
            testId="rf-height"
            onCommit={(v) => {
              setHeightOverride(row.id, v);
            }}
          />
          <span className="rf-faint">{t('rf.unit.m')}</span>
          {s?.heightOverrideM !== undefined && (
            <Button
              disabled={readOnly}
              onClick={() => {
                setHeightOverride(row.id, undefined);
              }}
            >
              {t('rf.sector.heightReset')}
            </Button>
          )}
        </span>
      </Field>
      <Field label={t('rf.sector.sector')}>
        <select
          className="input"
          value={row.sectorId ?? ''}
          disabled={readOnly}
          aria-label={t('rf.sector.sector')}
          onChange={(e) => {
            moveUnit(row.id, e.target.value === '' ? null : e.target.value);
          }}
        >
          <option value="">{t('rf.sector.noSector')}</option>
          {sectors.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </Field>
      <LabelledSwitch
        checked={s?.active ?? true}
        disabled={readOnly}
        label={t('rf.sector.active')}
        onChange={(on) => {
          patchSettings(row.id, { active: on });
        }}
      />

      <h4 className="rf-sub">{t('rf.sector.radio')}</h4>
      <Field label={t('rf.sector.band')}>
        <select
          className="input"
          value={band?.id ?? ''}
          disabled={readOnly}
          aria-label={t('rf.sector.band')}
          data-testid="rf-band"
          onChange={(e) => {
            setBand(e.target.value);
          }}
        >
          <option value="" disabled>
            {t('rf.sector.chooseBand')}
          </option>
          {BANDS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('rf.sector.tech')}>
        <div className="seg" role="group" aria-label={t('rf.sector.tech')}>
          {(['lte', 'nr'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={carrier?.tech === k}
              disabled={
                readOnly ||
                !carrier ||
                (k === 'lte' && band?.lteBands.length === 0) ||
                (k === 'nr' && band?.nrBand === null)
              }
              onClick={() => {
                patchCarrier(row.id, s, {
                  tech: k,
                  ...(carrier ? { band: carrierBandName({ band: carrier.band, tech: k }) } : {}),
                  scsKhz: undefined,
                  bandwidthMhz: defaultBandwidth(k, carrier?.band),
                });
              }}
            >
              {t(`rf.sector.tech.${k}`)}
            </button>
          ))}
        </div>
      </Field>
      <Field label={t('rf.sector.bandwidth')}>
        <select
          className="input"
          value={carrier ? String(carrier.bandwidthMhz) : ''}
          disabled={readOnly || !carrier}
          aria-label={t('rf.sector.bandwidth')}
          onChange={(e) => {
            patchCarrier(row.id, s, { bandwidthMhz: Number(e.target.value) });
          }}
        >
          {carrier &&
            [...new Set([...bandwidthChoices(carrier.tech, carrier.band), carrier.bandwidthMhz])]
              .sort((a, b) => a - b)
              .map((w) => (
                <option key={w} value={w}>
                  {t('rf.sector.mhz', { n: w })}
                </option>
              ))}
        </select>
      </Field>
      {(s?.carriers.length ?? 0) > 1 && (
        <p className="rf-note" data-testid="rf-more-carriers">
          {t('rf.sector.moreCarriers', { count: (s?.carriers.length ?? 1) - 1 })}
        </p>
      )}
      <Field
        id="aau"
        label={t('rf.sector.aau')}
        basis={
          aau ? (
            <Basis
              k={aau.verified ? 'rf.basis.entered' : 'rf.basis.unverified'}
              tone={aau.verified ? undefined : 'warn'}
            />
          ) : null
        }
      >
        <span className="rf-inline">
          <Button
            className="rf-pick"
            icon="box"
            disabledReason={ro}
            data-testid="rf-pick-aau"
            {...(aau ? { tip: entryName(aau, undefined) } : {})}
            onClick={(e) => {
              setPicking({ kinds: ['aau'], initial: 'aau', opener: e.currentTarget });
            }}
          >
            {aau ? entryName(aau, eq?.kind === 'aau' ? eq.aau : undefined) : t('rf.sector.noAau')}
          </Button>
          {isAau && (
            <IconButton
              icon="x"
              label={t('rf.sector.removeAau')}
              disabled={readOnly}
              onClick={() => {
                clearSetting(row.id, 'equipment');
              }}
            />
          )}
        </span>
      </Field>
      <Field
        id="antenna"
        label={t('rf.sector.antenna')}
        basis={
          antenna ? (
            <Basis
              k={antenna.verified ? 'rf.basis.entered' : 'rf.basis.unverified'}
              tone={antenna.verified ? undefined : 'warn'}
            />
          ) : null
        }
      >
        <Button
          className="rf-pick"
          icon="target"
          disabledReason={ro ?? builtIn}
          data-testid="rf-pick-antenna"
          {...(antenna && !isAau ? { tip: entryName(antenna, undefined) } : {})}
          onClick={(e) => {
            setPicking({ kinds: ['antenna'], initial: 'antenna', opener: e.currentTarget });
          }}
        >
          {isAau
            ? t('rf.sector.builtIn')
            : antenna
              ? entryName(antenna, undefined)
              : t('rf.sector.chooseAntenna')}
        </Button>
      </Field>
      <Field
        id="radio"
        label={t('rf.sector.radioUnit')}
        basis={
          radio ? (
            <Basis
              k={radio.verified ? 'rf.basis.entered' : 'rf.basis.unverified'}
              tone={radio.verified ? undefined : 'warn'}
            />
          ) : null
        }
      >
        <Button
          className="rf-pick"
          icon="telemetry"
          disabledReason={
            ro ??
            builtIn ??
            (eq?.kind === 'separate' ? undefined : t('rf.sector.radioNeedsAntenna'))
          }
          data-testid="rf-pick-radio"
          {...(radio && !isAau ? { tip: entryName(radio, undefined) } : {})}
          onClick={(e) => {
            setPicking({ kinds: ['radio'], initial: 'radio', opener: e.currentTarget });
          }}
        >
          {isAau
            ? t('rf.sector.builtIn')
            : radio
              ? entryName(radio, undefined)
              : t('rf.sector.chooseRadio')}
        </Button>
      </Field>
      {antenna?.kind === 'antenna' && carrier && (
        <Field label={t('rf.sector.port')}>
          <select
            className="input"
            value={carrier.port ?? ''}
            disabled={readOnly}
            aria-label={t('rf.sector.port')}
            onChange={(e) => {
              patchCarrier(row.id, s, { port: e.target.value === '' ? undefined : e.target.value });
            }}
          >
            <option value="">{t('rf.sector.portAuto')}</option>
            {antenna.ports.map((p) => (
              <option key={p.id} value={p.id}>
                {t('rf.sector.portValue', {
                  id: p.id,
                  lo: p.bandRangeMhz[0],
                  hi: p.bandRangeMhz[1],
                })}
              </option>
            ))}
          </select>
        </Field>
      )}
      {note && (
        <p className="rf-note rf-warn-ink" role="status">
          {note}
        </p>
      )}

      <h4 className="rf-sub">{t('rf.sector.pointing')}</h4>
      <Field
        id="etilt"
        label={t('rf.sector.etilt')}
        basis={
          range ? (
            <Basis
              k={s?.etiltDeg === undefined ? 'rf.basis.default' : 'rf.basis.entered'}
              tone={s?.etiltDeg === undefined ? 'warn' : undefined}
            />
          ) : null
        }
        hint={
          range
            ? t('rf.sector.etiltRange', {
                min: range.minDeg,
                max: range.maxDeg,
                step: range.stepDeg,
              })
            : t('rf.sector.etiltNoRange')
        }
      >
        <span className="rf-slider">
          <input
            type="range"
            min={range?.minDeg ?? 0}
            max={range?.maxDeg ?? 0}
            step={range?.stepDeg ?? 1}
            value={tiltValue}
            disabled={readOnly || !range}
            aria-label={t('rf.sector.etilt')}
            aria-valuetext={`${String(tiltValue)}°`}
            data-testid="rf-etilt"
            onChange={(e) => {
              setTilt(Number(e.target.value));
            }}
          />
          <NumberField
            value={range ? tiltValue : undefined}
            min={range?.minDeg ?? 0}
            max={range?.maxDeg ?? 0}
            step={range?.stepDeg ?? 1}
            label={t('rf.sector.etiltNumber')}
            disabled={readOnly || !range}
            testId="rf-etilt-number"
            onCommit={(v) => {
              if (v === undefined) clearSetting(row.id, 'etiltDeg');
              else setTilt(v);
            }}
          />
        </span>
      </Field>

      <h4 className="rf-sub">{t('rf.sector.power')}</h4>
      <Field
        id="power"
        label={powerLabel}
        basis={
          carrier?.powerDbmPerPort !== undefined ? (
            <Basis k="rf.basis.entered" />
          ) : resolved ? (
            <Basis k="rf.basis.default" tone="warn" />
          ) : null
        }
        hint={
          carrier?.powerDbmPerPort !== undefined
            ? t('rf.sector.powerWatts', { w: watts(carrier.powerDbmPerPort) })
            : defaultPower !== undefined
              ? t(isAau ? 'rf.sector.powerDefaultAau' : 'rf.sector.powerDefaultRadio', {
                  dbm: defaultPower,
                  w: watts(defaultPower),
                })
              : undefined
        }
      >
        <span className="rf-inline">
          <NumberField
            value={carrier?.powerDbmPerPort}
            placeholder={defaultPower === undefined ? '' : String(defaultPower)}
            min={0}
            max={80}
            step={0.1}
            label={powerLabel}
            disabled={readOnly || !carrier}
            testId="rf-power"
            onCommit={(v) => {
              patchCarrier(row.id, s, { powerDbmPerPort: v });
            }}
          />
          <span className="rf-faint">{t('rf.unit.dbm')}</span>
        </span>
      </Field>
      <Field
        id="loss"
        label={t('rf.sector.loss')}
        hint={isAau ? t('rf.sector.lossAau') : t('rf.sector.lossHint')}
      >
        <span className="rf-inline">
          <NumberField
            value={isAau ? 0 : carrier?.feederLossDb}
            min={0}
            max={30}
            step={0.1}
            label={t('rf.sector.loss')}
            disabled={readOnly || !carrier || isAau}
            testId="rf-loss"
            onCommit={(v) => {
              patchCarrier(row.id, s, { feederLossDb: v ?? 0 });
            }}
          />
          <span className="rf-faint">{t('rf.unit.db')}</span>
        </span>
      </Field>
      {row.warnings.length > 0 && (
        <ul className="rf-defaults" aria-label={t('rf.sector.defaults')}>
          {row.warnings.map((w, i) => (
            <li key={`${w.code}-${String(i)}`}>{warningText(t, w)}</li>
          ))}
        </ul>
      )}
      {picking && (
        <CataloguePicker
          kinds={picking.kinds}
          initialKind={picking.initial}
          band={band?.id ?? null}
          bandName={carrier ? carrierBandName(carrier) : undefined}
          context={t('rf.picker.context', {
            unit: row.name,
            band: band?.label ?? t('rf.sector.noBand'),
          })}
          selectedId={
            picking.initial === 'aau'
              ? aau?.id
              : picking.initial === 'antenna'
                ? antenna?.id
                : radio?.id
          }
          blockedReason={(k) =>
            k === 'radio' && eq?.kind !== 'separate' ? t('rf.sector.radioNeedsAntenna') : undefined
          }
          portFor={(e) => {
            const freq = carrier ? (carrier.frequencyMhz ?? band?.centreMHz) : undefined;
            if (!carrier || freq === undefined) return undefined;
            return pickPort(e.ports, carrier, freq).port?.id;
          }}
          opener={picking.opener}
          onPick={onPick}
          onClose={() => {
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * The body of an open step 2 row: the sector's own controls, a choice of unit when it has more
 * than one, and that unit's fields. `UNGROUPED` shows the units in no sector.
 */
function SectorSection({
  sectorKey,
  unitId,
  onUnit,
}: {
  sectorKey: string;
  unitId: string | null;
  onUnit: (id: string) => void;
}) {
  const t = useT();
  const rows = useRf((s) => s.rows);
  const sectorId = sectorKey === UNGROUPED ? null : sectorKey;
  const inSector = rows.filter((r) => r.sectorId === sectorId);
  const row = inSector.find((r) => r.id === unitId) ?? inSector[0] ?? null;
  return (
    <div className="rf-sec">
      {sectorId !== null && <SectorManage sectorId={sectorId} />}
      {inSector.length > 1 && (
        <div className="rf-chips" role="group" aria-label={t('rf.sector.chooseUnit')}>
          {inSector.map((r) => (
            <Button
              key={r.id}
              pressed={row?.id === r.id}
              onClick={() => {
                onUnit(r.id);
              }}
            >
              {r.name}
            </Button>
          ))}
        </div>
      )}
      {row ? (
        <UnitFields key={row.id} row={row} />
      ) : (
        <p className="rf-note">{t('rf.sector.empty')}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Results

const VIEWS: readonly RfView[] = ['rsrp', 'bestServer', 'overlap'];
const CLASSES = ['excellent', 'good', 'fair', 'poor', 'none'] as const;

function ResultsSection() {
  const t = useT();
  const root = useWorkspace((s) => s.project?.root ?? null);
  const view = useRf((s) => s.view);
  const runs = useRf((s) => s.runs);
  const selectedRunId = useRf((s) => s.selectedRunId);
  const check = useRf((s) => s.check);
  const running = useRf((s) => s.running);
  const runError = useRf((s) => s.runError);
  const stats = useRf((s) => s.classStats);
  const reduced = useCoverage((c) => c.run?.reducedFrom ?? null);
  const study = useRf((s) => s.sectors.study);
  const preview = useRf((s) => s.preview);
  const rows = useRf((s) => s.rows);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const exportBtn = useRef<HTMLButtonElement>(null);
  const run = runs.find((r) => r.runId === selectedRunId) ?? null;
  const packError = useProcessingTools((s) => (s.status === null ? s.error : null));
  const first = check.refusals[0];
  const reason =
    first === 'pack-unknown' && packError
      ? t('rf.refusal.packCheckFailed')
      : first
        ? refusalText(t, first)
        : root
          ? undefined
          : t('rf.refusal.noProject');
  const th = study.thresholds;
  const range: Record<(typeof CLASSES)[number], string> = {
    excellent: t('rf.results.range.above', { dbm: th.excellentDbm }),
    good: t('rf.results.range.between', { hi: th.excellentDbm, lo: th.goodDbm }),
    fair: t('rf.results.range.between', { hi: th.goodDbm, lo: th.fairDbm }),
    poor: t('rf.results.range.between', { hi: th.fairDbm, lo: th.poorDbm }),
    none: t('rf.results.range.below', { dbm: th.poorDbm }),
  };
  const start = () => {
    if (!root) return;
    void startRfRun(root);
  };
  const doExport = (format: 'geotiff' | 'geojson' | 'csv') => {
    void exportRun(format).then((r) => {
      if (!r.ok) setExportNote(r.message || t('rf.results.exportFailed'));
      else setExportNote(r.path === null ? null : t('rf.results.exported', { path: r.path }));
    });
  };
  const nameOf = (id: string) => rows.find((r) => r.id === id)?.name ?? id;
  const generic = run?.patterns.filter((p) => p.source === 'generic').length ?? 0;
  return (
    <div className="rf-sec">
      <div className="seg rf-seg-full" role="group" aria-label={t('rf.results.view')}>
        {VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            data-testid={`rf-view-${v}`}
            onClick={() => {
              setView(v);
            }}
          >
            {t(VIEW_KEY[v])}
          </button>
        ))}
      </div>
      {runs.length > 0 && (
        <Field label={t('rf.results.runPick')}>
          <select
            className="input"
            value={selectedRunId ?? ''}
            aria-label={t('rf.results.runPick')}
            onChange={(e) => {
              void selectRun(e.target.value === '' ? null : e.target.value);
            }}
          >
            <option value="">{t('rf.results.noRun')}</option>
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {t('rf.results.runValue', {
                  at: clock(r.createdAt),
                  status: t(r.status === 'done' ? 'rf.results.runDone' : 'rf.results.runFailed'),
                })}
              </option>
            ))}
          </select>
        </Field>
      )}
      <table className="rf-classes" data-testid="rf-classes">
        <caption className="sr-only">{t('rf.results.classes')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('rf.results.class')}</th>
            <th scope="col">{t('rf.results.range')}</th>
            <th scope="col">{t('rf.results.area')}</th>
            <th scope="col">{t('rf.results.share')}</th>
          </tr>
        </thead>
        <tbody>
          {CLASSES.map((c) => {
            const st = stats?.find((x) => x.cls === c);
            return (
              <tr key={c}>
                <th scope="row">{t(`rf.results.class.${c}`)}</th>
                <td className="mono">{range[c]}</td>
                <td className="mono">
                  {st ? t('rf.results.km2', { v: fmt(st.areaM2 / 1e6, 2) }) : ''}
                </td>
                <td className="mono">{st ? `${fmt(st.share * 100, 0)}%` : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!stats && (
        <p className="rf-note">{t(run ? 'rf.results.areasPending' : 'rf.results.noRunYet')}</p>
      )}
      {reduced && (
        <p className="rf-note" role="status" data-testid="rf-reduced">
          {t('rf.results.reducedView', {
            width: reduced.width,
            height: reduced.height,
            step: reduced.step,
          })}
        </p>
      )}
      <p className="rf-note" data-testid="rf-participants">
        {t('rf.results.participants', { count: check.participants.length })}
      </p>
      {check.excluded.length > 0 && (
        <ul className="rf-defaults" aria-label={t('rf.results.leftOut')} data-testid="rf-left-out">
          {check.excluded.map((e) => (
            <li key={e.antennaId}>
              {t('rf.results.leftOutItem', {
                name: nameOf(e.antennaId),
                reason: t(EXCLUSION_KEY[e.reason]),
              })}
            </li>
          ))}
        </ul>
      )}
      <div className="rf-actions">
        <Button
          variant="primary"
          icon="play"
          busy={running}
          disabledReason={running ? undefined : reason}
          data-testid="rf-run"
          onClick={start}
        >
          {t(running ? 'rf.results.running' : 'rf.results.run')}
        </Button>
        <Button
          icon="plus"
          data-testid="rf-save-run"
          disabledReason={
            // a study past the preview's pixel cap is saved and run without a preview
            preview.status === 'ready' || preview.status === 'too-large'
              ? running
                ? undefined
                : reason
              : t('rf.results.saveNeedsPreview')
          }
          onClick={start}
        >
          {t('rf.results.saveAsRun')}
        </Button>
        <Button
          ref={exportBtn}
          icon="download"
          disabledReason={run?.status === 'done' ? undefined : t('rf.results.exportNeedsRun')}
          aria-haspopup="menu"
          aria-expanded={exportOpen}
          onClick={() => {
            setExportOpen(!exportOpen);
          }}
        >
          {t('rf.results.export')}
        </Button>
        <Menu
          open={exportOpen}
          onClose={() => {
            setExportOpen(false);
          }}
          opener={exportBtn}
          label={t('rf.results.export')}
          items={[
            {
              id: 'geotiff',
              label: t('rf.results.exportTiff'),
              onSelect: () => {
                doExport('geotiff');
              },
            },
            {
              id: 'geojson',
              label: t('rf.results.exportGeojson'),
              onSelect: () => {
                doExport('geojson');
              },
            },
            {
              id: 'csv',
              label: t('rf.results.exportCsv'),
              onSelect: () => {
                doExport('csv');
              },
            },
          ]}
        />
      </div>
      {preview.status === 'too-large' && (
        <p className="rf-note" role="status" data-testid="rf-preview-too-large">
          {t('rf.results.previewTooLarge')}
        </p>
      )}
      {packError && (
        <div className="rf-actions" role="alert" data-testid="rf-pack-failed">
          <span className="rf-note rf-err">{t('rf.results.packFailed', { error: packError })}</span>
          <Button icon="refresh" onClick={() => void processingTools.getState().load()}>
            {t('rf.results.packRetry')}
          </Button>
        </div>
      )}
      {runError !== null && (
        <p className="rf-note rf-err" role="alert">
          {runError || t('rf.results.runFailedPlain')}
        </p>
      )}
      {exportNote && (
        <p className="rf-note" role="status">
          {exportNote}
        </p>
      )}
      <div className="rf-indicative" data-testid="rf-indicative">
        <p>
          <b>{t('rf.results.indicative')}</b> {t('rf.results.indicativeBody')}
        </p>
        <p>{assumptionsText(t, study)}</p>
        {generic > 0 && <p>{t('rf.results.generic', { count: generic })}</p>}
        {run?.usedUnreviewed && <p>{t('rf.results.unreviewed')}</p>}
        {run && run.warnings.length > 0 && (
          <ul>
            {run.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the bench

/**
 * Review in inventory, through Auto-plan's one review link (`openAntennaReviewOrFallback`). The
 * Coverage tab keeps the pin it has (opened pinned, it stays open beside the inventory); a person
 * who unpinned it is not overruled.
 */
function reviewAntennas(): void {
  openAntennaReviewOrFallback();
}

export function RfBench() {
  const t = useT();
  useRfSync();
  const status = useRf((s) => s.status);
  const message = useRf((s) => s.message);
  const antennas = useRf((s) => s.antennas);
  const focus = useRf((s) => s.focusUnitId);
  const rows = useRf((s) => s.rows);
  const runs = useRf((s) => s.runs);
  const settings = useRf((s) => s.sectors.antennas);
  const study = useRf((s) => s.sectors.study);
  const readOnly = useRf((s) => s.readOnly);
  const sections = useSections(BENCH);
  // the open step 2 row (a sector id or UNGROUPED) and the unit it shows
  const [expanded, setExpanded] = useState<string | null>(null);
  const [unitId, setUnitId] = useState<string | null>(null);
  const step2 = useRef<HTMLDivElement>(null);
  // an Edit RF action on a unit opens that unit's sector row (once the unit is loaded)
  const [seenFocus, setSeenFocus] = useState<string | null>(null);
  if (focus !== seenFocus && (focus === null || rows.some((x) => x.id === focus))) {
    setSeenFocus(focus);
    const r = rows.find((x) => x.id === focus);
    if (r) {
      setExpanded(r.sectorId ?? UNGROUPED);
      setUnitId(r.id);
    }
  }

  if (status === 'error')
    return (
      <div className="wb-bench wb-scroll" data-testid="rf-bench">
        <EmptyState icon="warn" title={t('rf.loadFailed')} body={message ?? ''} />
      </div>
    );
  if (status !== 'ready')
    return (
      <div className="wb-bench wb-scroll" data-testid="rf-bench">
        <p className="rf-note" role="status">
          {t('rf.loading')}
        </p>
      </div>
    );
  if (!antennas)
    return (
      <div className="wb-bench wb-scroll" data-testid="rf-bench">
        <EmptyState icon="target" title={t('rf.noAntennas')} body={t('rf.noAntennasBody')} />
      </div>
    );
  const accepted = antennas.units.filter((u) => u.status === 'accepted').length;
  const drafts = antennas.units.filter((u) => u.status === 'draft');
  const fromExport = settings.some(
    (s) =>
      s.origins?.equipment?.by === 'export' || s.carriers.some((c) => c.origin?.by === 'export'),
  );
  const done = runs.filter((r) => r.status === 'done').length;
  const open = (key: string) => {
    setExpanded(key);
    setUnitId(null);
  };
  return (
    <div className="wb-bench wb-scroll rf-bench" data-testid="rf-bench">
      <SaveBar />
      <AutoplanDialog />
      {/* the Coverage chip's status line and its next step (spec F1 revised) */}
      <CoverageChip variant="panel" />
      <AiCard
        onAutoplan={() => {
          void startAutoplan();
        }}
        onUseExport={(csvText) => {
          void startAutoplan({ csvText });
        }}
        exportAvailable={fromExport}
        disabled={readOnly}
        onSetUpByHand={() => {
          const first = rfStore.getState().sectors.sectors[0]?.id;
          const ungrouped = rows.some((r) => r.sectorId === null);
          const key = first ?? (ungrouped ? UNGROUPED : null);
          if (key !== null) open(key);
          // jsdom has no scrollIntoView
          (step2.current as Partial<HTMLElement> | null)?.scrollIntoView?.({ block: 'start' });
        }}
      />
      <StepAntennas accepted={accepted} drafts={drafts.length} onReview={reviewAntennas}>
        <SiteFacts />
      </StepAntennas>
      <div ref={step2}>
        <StepSectors
          expanded={expanded}
          onToggle={(key) => {
            if (expanded === key) setExpanded(null);
            else open(key);
          }}
          toolbar={<SectorToolbar />}
          renderBody={(key) => <SectorSection sectorKey={key} unitId={unitId} onUnit={setUnitId} />}
        >
          <Orphans />
        </StepSectors>
      </div>
      <Step
        n={3}
        done={done > 0}
        title={t('rf.steps.coverage.title')}
        meta={
          runs.length === 0
            ? t('rf.steps.coverage.noRuns')
            : t('rf.steps.coverage.runs', { count: runs.length })
        }
        testId="rf-step-coverage"
      >
        <ResultsSection />
      </Step>
      <AdvancedFold
        title={t('rf.steps.advanced.title')}
        summary={studySummary(t, study)}
        open={sections.isOpen('rf-advanced', false)}
        onToggle={() => {
          sections.toggle('rf-advanced', false);
        }}
      >
        <StudySettings />
        <CsvImportButton />
      </AdvancedFold>
    </div>
  );
}
