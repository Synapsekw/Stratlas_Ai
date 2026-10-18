/**
 * The Auto-plan review dialog (spec "Auto-plan", F2): one row per planned antenna with its
 * sector, equipment, band · tech · bandwidth, reason and confidence, the units left out, the
 * `<provider> | Rules only` switch, and Cancel / Apply only / Apply & run coverage. Nothing is
 * written until Apply. Self-contained: it follows `autoplanStore` and renders into a portal under
 * <body>, so it is mounted once and shows itself.
 *
 * - The carriers shown are exactly the row's `picks`, which is what Apply writes (ruling R15).
 *   The equipment is the row's equipment pick, else the unit's current equipment. Groups Re-plan
 *   keeps (C3) are marked "kept".
 * - Phases: `blocked-review` (F6), `preview` (the send preview, as the antenna AI labels do; a
 *   local model skips it), `thinking`, `review` and `error` (which offers Rules only).
 * - The store's English messages (`AUTOPLAN_MESSAGES`) are shown through `rf.autoplan.*` keys; a
 *   provider's own error text is shown as it came.
 */
import { PROVIDER_LABELS, SendDialog } from '@aio/ai';
import type { IpcResponse, RfCatalogueEntry, RfEquipment, RfTech } from '@aio/schema';
import { Button, PortalRoot, Tip, useFocusTrap, useT, type MessageKey, type Vars } from '@aio/ui';
import { assetUrl } from '@aio/workspace';
import { useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { antennaStore } from '../telecom/antennaStore';
import {
  applyAutoplan,
  AUTOPLAN_MESSAGES,
  cancelAutoplan,
  confirmSend,
  openAntennaReviewOrFallback,
  switchSource,
  useAutoplan,
  type ApplyRefusal,
  type AutoplanPhase,
} from './autoplan/autoplanStore';
import type { Proposal, ProposalRow } from './autoplan/proposal';
import type { LeftOut } from './autoplan/sectors';
import type { PlanPick } from './autoplan/types';
import { sectorColour, swatchBackground } from './coverageRamp';
import { carrierBandName, sectorBearing } from './rfFields';
import { rfStore, useRf, type StartResult } from './rfStore';
import { openCoverage } from './rfTab';
import './rf.css';

type T = (key: MessageKey, vars?: Vars) => string;
type Preview = Extract<IpcResponse<'ai:rfPlanPreview'>, { ok: true }>;
type Confidence = PlanPick['confidence'];
/** Why Apply did not end in a run: the plan applied but no run, or nothing applied (read only). */
type RunProblem = Extract<StartResult, { ok: false }> | ApplyRefusal;

/** The store's fixed texts, by the key that says the same (provider errors have none). */
const MESSAGE_KEY: ReadonlyMap<string, MessageKey> = new Map<string, MessageKey>([
  [AUTOPLAN_MESSAGES.exportEmpty, 'rf.autoplan.error.exportEmpty'],
  [AUTOPLAN_MESSAGES.exportNoAntennaColumn, 'rf.autoplan.error.exportNoAntennaColumn'],
  [AUTOPLAN_MESSAGES.noProject, 'rf.autoplan.error.noProject'],
  [AUTOPLAN_MESSAGES.aiUnavailable, 'rf.autoplan.error.aiUnavailable'],
  [AUTOPLAN_MESSAGES.aiNoAnswer, 'rf.autoplan.error.aiNoAnswer'],
  [AUTOPLAN_MESSAGES.noRoot, 'rf.autoplan.error.noRoot'],
]);
const NO_EXPORT_ROW = AUTOPLAN_MESSAGES.noExportRow('');

function messageText(t: T, m: string): string {
  const key = MESSAGE_KEY.get(m);
  if (key) return t(key);
  if (m.startsWith(NO_EXPORT_ROW))
    return t('rf.autoplan.noExportRow', { name: m.slice(NO_EXPORT_ROW.length) });
  return m;
}

const LEFT_KEY: Readonly<Record<LeftOut['reason'], MessageKey>> = {
  draft: 'rf.autoplan.left.draft',
  'not-panel': 'rf.autoplan.left.notPanel',
  'no-azimuth': 'rf.autoplan.left.noAzimuth',
  inactive: 'rf.autoplan.left.inactive',
  rejected: 'rf.autoplan.left.rejected',
};
const CONF_KEY: Readonly<Record<Confidence, MessageKey>> = {
  high: 'rf.autoplan.conf.high',
  medium: 'rf.autoplan.conf.medium',
  low: 'rf.autoplan.conf.low',
};
const TECH_KEY: Readonly<Record<RfTech, MessageKey>> = {
  lte: 'rf.autoplan.tech.lte',
  nr: 'rf.autoplan.tech.nr',
};
const RANK: Readonly<Record<Confidence, number>> = { low: 0, medium: 1, high: 2 };

/** The provider's display name, else the id as it came. */
const providerName = (id: string): string =>
  id in PROVIDER_LABELS ? PROVIDER_LABELS[id as keyof typeof PROVIDER_LABELS] : id;

function costText(t: T, p: Preview): string {
  if (!p.cloud) return t('rf.autoplan.cost.local');
  const usd = p.estimate.costUsd;
  if (usd === undefined) return t('rf.autoplan.cost.unknown');
  if (usd < 0.01) return t('rf.autoplan.cost.under');
  return t('rf.autoplan.cost.about', { usd: usd.toFixed(2) });
}

/** Photos go only under the project's consent (R7), which the preview reflects. */
const photosSent = (p: Preview): number => (p.photosAllowed ? p.crops.length : 0);

/** The row's lowest confidence over what it writes; null when it writes no new value. */
function rowConfidence(row: ProposalRow): Confidence | null {
  const all = [row.equipment, ...row.picks].flatMap((p) => (p ? [p.confidence] : []));
  if (all.length === 0) return null;
  return all.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
}

/** The equipment's model names and its vendor · verified line, from the catalogue. */
function equipmentText(
  t: T,
  eq: RfEquipment,
  catalogue: readonly RfCatalogueEntry[],
): { name: string; sub: string } {
  const ids = eq.kind === 'aau' ? [eq.aau] : [eq.antenna, ...(eq.radio ? [eq.radio] : [])];
  const entries = ids.map((id) => catalogue.find((e) => e.id === id));
  const name = ids.map((id, i) => entries[i]?.model ?? id).join(' + ');
  const main = entries[0];
  const vendor =
    !main || main.vendor.toLowerCase() === 'generic' ? t('rf.autoplan.entry.generic') : main.vendor;
  const verified = entries.every((e) => e?.verified === true);
  return {
    name,
    sub: t(verified ? 'rf.autoplan.entry.verified' : 'rf.autoplan.entry.unverified', { vendor }),
  };
}

const KeptTag = ({ t, children }: { t: T; children?: ReactNode }) => (
  <span className="rf-autoplan-kept">{children ?? t('rf.autoplan.kept')}</span>
);

function PlanRow({ row, proposal, t }: { row: ProposalRow; proposal: Proposal; t: T }) {
  const catalogue = useRf((s) => s.catalogue);
  const settings = useRf((s) => s.sectors.antennas.find((a) => a.antennaId === row.unitId));
  const height = useRf((s) => s.rows.find((r) => r.id === row.unitId)?.height.heightM ?? null);
  const units = useUnits();
  const unit = units.find((u) => u.id === row.unitId);
  const entries = catalogue.map((c) => c.entry);

  const index = proposal.sectors.findIndex((s) => s.id === row.sectorId);
  const sector = proposal.sectors[index];
  const bearing = sector ? sectorBearing(sector.antennaIds, units) : null;
  const sectorName = sector?.name ?? row.sectorId;

  const tilt = unit?.downtiltDeg?.value;
  const meta = [
    height !== null ? t('rf.autoplan.height', { m: height.toFixed(1) }) : null,
    tilt !== undefined ? t('rf.autoplan.tilt', { deg: Math.round(tilt) }) : null,
  ].filter((x): x is string => x !== null);

  const eq = row.equipment?.equipment ?? settings?.equipment;
  const eqKept = !row.equipment && eq !== undefined;
  const eqText = eq ? equipmentText(t, eq, entries) : null;

  // kept carriers are written unchanged, so the current settings show them truthfully
  const keptList = (settings?.carriers ?? []).filter((_, k) => row.kept.carriers[k] === true);
  const keptCarriers = keptList.length;
  const conf = rowConfidence(row);
  const reasons = [...new Set([row.equipment, ...row.picks].flatMap((p) => (p ? [p.reason] : [])))];

  return (
    <tr data-testid={`rf-autoplan-row-${row.unitId}`} data-confidence={conf ?? 'kept'}>
      <td>
        <span
          className="rf-autoplan-sw"
          aria-hidden="true"
          style={{ background: swatchBackground(sectorColour(Math.max(index, 0)), 'none', false) }}
        />
        <b>
          {bearing === null
            ? sectorName
            : t('rf.autoplan.sectorName', { name: sectorName, deg: Math.round(bearing) })}
        </b>
      </td>
      <td>
        {unit?.name ?? row.unitId}
        {meta.length > 0 && <small>{meta.join(' · ')}</small>}
      </td>
      <td>
        {eqText ? (
          <>
            <b>{eqText.name}</b>
            <small>
              {eqText.sub}
              {eqKept && (
                <>
                  {' '}
                  <KeptTag t={t} />
                </>
              )}
            </small>
          </>
        ) : (
          <span className="rf-off">{t('rf.autoplan.noEquipment')}</span>
        )}
      </td>
      <td>
        {row.picks.map((p, i) => (
          <div key={i} className="mono">
            {t('rf.autoplan.carrier', {
              band: carrierBandName(p.carrier),
              tech: t(TECH_KEY[p.carrier.tech]),
              bw: p.carrier.bandwidthMhz,
            })}
          </div>
        ))}
        {keptList.map((c) => (
          <div key={c.id} className="mono">
            <KeptTag t={t}>
              {t('rf.autoplan.keptCarrier', {
                carrier: t('rf.autoplan.carrier', {
                  band: carrierBandName(c),
                  tech: t(TECH_KEY[c.tech]),
                  bw: c.bandwidthMhz,
                }),
              })}
            </KeptTag>
          </div>
        ))}
        {row.picks.length === 0 && keptCarriers === 0 && (
          <span className="rf-off">{t('rf.autoplan.noCarrier')}</span>
        )}
        {row.etilt && <small>{t('rf.autoplan.etilt', { deg: row.etilt.deg })}</small>}
        {row.kept.etiltDeg && (
          <small>
            <KeptTag t={t}>{t('rf.autoplan.keptEtilt')}</KeptTag>
          </small>
        )}
      </td>
      <td className="rf-autoplan-why">
        {reasons.length > 0
          ? reasons.map((r) => <div key={r}>{r}</div>)
          : t('rf.autoplan.keptReason')}
        {row.note && <small className="rf-autoplan-note">{row.note}</small>}
      </td>
      <td>
        {conf ? (
          <span className="rf-autoplan-conf" data-level={conf}>
            <span className="rf-autoplan-bar" aria-hidden="true">
              <i />
            </span>
            {t(CONF_KEY[conf])}
          </span>
        ) : (
          <KeptTag t={t} />
        )}
      </td>
    </tr>
  );
}

/** The detected units: the inventory's when it holds the RF store's project, else the RF store's. */
function useUnits() {
  const projectId = useRf((s) => s.projectId);
  const rfUnits = useRf((s) => s.antennas?.units);
  const inv = useStore(antennaStore, (s) =>
    s.file && s.projectId === projectId ? s.file.units : null,
  );
  return inv ?? rfUnits ?? [];
}

function LeftOutRow({ left, t }: { left: LeftOut; t: T }) {
  const units = useUnits();
  const unit = units.find((u) => u.id === left.unitId);
  return (
    <tr className="rf-autoplan-left" data-testid={`rf-autoplan-left-${left.unitId}`}>
      <td>{t('rf.autoplan.leftOut')}</td>
      <td>{unit?.name ?? left.unitId}</td>
      <td colSpan={3}>{t(LEFT_KEY[left.reason])}</td>
      <td>
        {left.reason === 'draft' && (
          <Button
            size="sm"
            onClick={() => {
              cancelAutoplan();
              openAntennaReviewOrFallback();
            }}
          >
            {t('rf.autoplan.review')}
          </Button>
        )}
      </td>
    </tr>
  );
}

function ReviewBody({ proposal, warnings, t }: { proposal: Proposal; warnings: string[]; t: T }) {
  const sectorsWithRows = new Set(proposal.rows.map((r) => r.sectorId)).size;
  const nameOf = (id: string) => proposal.sectors.find((s) => s.id === id)?.name ?? id;
  return (
    <>
      <p className="rf-note">
        {t('rf.autoplan.summary', {
          antennas: t('rf.autoplan.antennas', { count: proposal.rows.length }),
          sectors: t('rf.autoplan.sectors', { count: sectorsWithRows }),
          how: t(proposal.regrouped ? 'rf.autoplan.byBearing' : 'rf.autoplan.sectorsKept'),
        })}
      </p>
      <div className="rf-autoplan-table-wrap">
        <table className="rf-autoplan-table">
          <thead>
            <tr>
              <th scope="col">{t('rf.autoplan.col.sector')}</th>
              <th scope="col">{t('rf.autoplan.col.antenna')}</th>
              <th scope="col">{t('rf.autoplan.col.equipment')}</th>
              <th scope="col">{t('rf.autoplan.col.band')}</th>
              <th scope="col">{t('rf.autoplan.col.why')}</th>
              <th scope="col">{t('rf.autoplan.col.confidence')}</th>
            </tr>
          </thead>
          <tbody>
            {proposal.rows.map((r) => (
              <PlanRow key={r.unitId} row={r} proposal={proposal} t={t} />
            ))}
            {proposal.leftOut.map((l) => (
              <LeftOutRow key={l.unitId} left={l} t={t} />
            ))}
          </tbody>
        </table>
      </div>
      {(proposal.renames.length > 0 ||
        proposal.unmatchedRows.length > 0 ||
        warnings.length > 0) && (
        <ul className="rf-autoplan-notes">
          {proposal.renames.map((r) => (
            <li key={r.sectorId}>
              {t('rf.autoplan.rename', { from: nameOf(r.sectorId), to: r.name })}
            </li>
          ))}
          {proposal.unmatchedRows.length > 0 && (
            <li>{t('rf.autoplan.unmatchedRows', { lines: proposal.unmatchedRows.join(', ') })}</li>
          )}
          {warnings.map((w, i) => (
            <li key={i}>{messageText(t, w)}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function Progress({ label }: { label: string }) {
  return (
    <div className="rf-autoplan-progress">
      <div className="rf-autoplan-progress-bar" role="progressbar" aria-label={label}>
        <i />
      </div>
      <p className="rf-note">{label}</p>
    </div>
  );
}

function SendPreview({ preview, t }: { preview: Preview; t: T }) {
  const projectId = useRf((s) => s.projectId);
  const units = useUnits();
  const nameOf = (id: string) => units.find((u) => u.id === id)?.name ?? '';
  const provider = providerName(preview.provider);
  const photos = photosSent(preview);
  return (
    <div data-testid="rf-autoplan" className="rf-autoplan-send">
      <SendDialog
        standalone
        className="surface-dlg"
        titleId="rf-autoplan-send-title"
        title={t('rf.autoplan.send.title', { provider })}
        onCancel={cancelAutoplan}
        actions={
          <>
            <Button onClick={cancelAutoplan}>{t('rf.autoplan.cancel')}</Button>
            <Button
              variant="primary"
              data-testid="rf-autoplan-send"
              onClick={() => {
                void confirmSend(preview.photosAllowed);
              }}
            >
              {t('rf.autoplan.send.send')}
            </Button>
          </>
        }
      >
        <p>{t('rf.autoplan.send.body', { provider })}</p>
        <p className="mono">
          {preview.model}, {costText(t, preview)}
        </p>
        {photos > 0 && projectId ? (
          <>
            <p>{t('rf.autoplan.send.photos', { count: photos })}</p>
            <ul className="rf-autoplan-crops">
              {preview.crops.map((c) => (
                <li key={c.unitId}>
                  <img
                    src={assetUrl(projectId, { path: c.path })}
                    alt={nameOf(c.unitId)}
                    width={72}
                    height={72}
                  />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>{t('rf.autoplan.send.noPhotos')}</p>
        )}
      </SendDialog>
    </div>
  );
}

function runProblemText(t: T, r: RunProblem): string {
  if (r.code === 'read-only') return t('rf.refusal.readOnly');
  if (r.code === 'failed')
    return t('rf.autoplan.applied.failed', { message: messageText(t, r.message) });
  return t(r.code === 'refused' ? 'rf.autoplan.applied.refused' : 'rf.autoplan.applied.notSaved');
}

export function AutoplanDialog() {
  const t = useT();
  const phase = useAutoplan((s) => s.phase);
  const source = useAutoplan((s) => s.source);
  const preview = useAutoplan((s) => s.preview);
  const proposal = useAutoplan((s) => s.proposal);
  const warnings = useAutoplan((s) => s.warnings);
  const error = useAutoplan((s) => s.error);
  const aiAvailable = useAutoplan((s) => s.aiAvailable);
  const storeProvider = useAutoplan((s) => s.provider);
  const cloud = useAutoplan((s) => s.cloud);
  const [problem, setProblem] = useState<RunProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  // the last send preview, for the provider's name and the cost line once it has been sent
  const [lastPreview, setLastPreview] = useState<Preview | null>(null);
  const [seenPhase, setSeenPhase] = useState<AutoplanPhase>(phase);
  const rfProject = useRf((s) => s.projectId);
  const [seenProject, setSeenProject] = useState(rfProject);
  const dlg = useRef<HTMLDivElement>(null);

  // another project: what the last one's Apply said is not about this one (R17)
  if (seenProject !== rfProject) {
    setSeenProject(rfProject);
    setProblem(null);
  }
  // adjust state while rendering (not in an effect): a new Auto-plan remembers what opened it
  if (seenPhase !== phase) {
    setSeenPhase(phase);
    if (seenPhase === 'idle') {
      setOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
      setProblem(null);
      // a new Auto-plan: never show the last one's provider, cost or photos
      setLastPreview(null);
    }
  }
  // the current run's send preview, kept for the cost line once it has been sent
  if (preview?.ok && preview !== lastPreview && seenPhase === phase) setLastPreview(preview);

  const sendShown = phase === 'preview' && preview?.ok === true;
  const open = (phase !== 'idle' && !sendShown) || (phase === 'idle' && problem !== null);
  const close = () => {
    setProblem(null);
    if (phase !== 'idle') cancelAutoplan();
  };
  useFocusTrap(dlg, open, { onEscape: close, returnTo: () => opener });

  if (sendShown) {
    return (
      <PortalRoot opener={opener}>
        <SendPreview preview={preview} t={t} />
      </PortalRoot>
    );
  }
  if (!open) return null;

  const providerId = storeProvider ?? lastPreview?.provider ?? null;
  const provider = providerId ? providerName(providerId) : t('rf.autoplan.source.ai');
  const apply = async (run: boolean) => {
    if (busy) return;
    setBusy(true);
    const before = rfStore.getState().projectId;
    try {
      const r = await applyAutoplan(run);
      // a problem with another project's plan is not about the one open now (R17)
      if (r && !r.ok && rfStore.getState().projectId === before) setProblem(r);
    } finally {
      setBusy(false);
    }
  };

  let title = t('rf.autoplan.title');
  let body: ReactNode;
  let foot: ReactNode;
  const cancelButton = (
    <Button data-testid="rf-autoplan-cancel" onClick={close}>
      {t('rf.autoplan.cancel')}
    </Button>
  );

  if (phase === 'idle' && problem?.code === 'read-only') {
    title = t('rf.autoplan.error.title');
    body = (
      <p className="rf-note rf-warn-ink" role="alert">
        {runProblemText(t, problem)}
      </p>
    );
    foot = (
      <>
        <span className="grow" />
        <Button data-testid="rf-autoplan-cancel" onClick={close}>
          {t('rf.autoplan.applied.close')}
        </Button>
      </>
    );
  } else if (phase === 'idle' && problem) {
    title = t('rf.autoplan.applied.title');
    body = (
      <p className="rf-note rf-warn-ink" role="alert">
        {runProblemText(t, problem)}
      </p>
    );
    foot = (
      <>
        <span className="grow" />
        <Button data-testid="rf-autoplan-cancel" onClick={close}>
          {t('rf.autoplan.applied.close')}
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            setProblem(null);
            openCoverage();
          }}
        >
          {t('rf.autoplan.applied.open')}
        </Button>
      </>
    );
  } else if (phase === 'blocked-review') {
    title = t('rf.autoplan.blocked.title');
    body = <p className="rf-note">{t('rf.autoplan.blocked.body')}</p>;
    foot = (
      <>
        <span className="grow" />
        {cancelButton}
        <Button
          variant="primary"
          onClick={() => {
            cancelAutoplan();
            openAntennaReviewOrFallback();
          }}
        >
          {t('rf.autoplan.blocked.open')}
        </Button>
      </>
    );
  } else if (phase === 'preview' || phase === 'thinking') {
    body = (
      <Progress
        label={
          phase === 'preview' ? t('rf.autoplan.preparing') : t('rf.autoplan.thinking', { provider })
        }
      />
    );
    foot = (
      <>
        <span className="grow" />
        {cancelButton}
      </>
    );
  } else if (phase === 'error') {
    title = t('rf.autoplan.error.title');
    body = (
      <p className="rf-note rf-err" role="alert">
        {messageText(t, error ?? '')}
      </p>
    );
    foot = (
      <>
        <span className="grow" />
        {cancelButton}
        <Button
          variant="primary"
          onClick={() => {
            void switchSource('rules');
          }}
        >
          {t('rf.autoplan.useRules')}
        </Button>
      </>
    );
  } else if (phase === 'review' && proposal) {
    body = <ReviewBody proposal={proposal} warnings={warnings} t={t} />;
    const nothing = proposal.rows.length === 0 ? t('rf.autoplan.nothingToApply') : undefined;
    const cost =
      source === 'rules'
        ? t('rf.autoplan.cost.rules')
        : source === 'ai'
          ? lastPreview
            ? t('rf.autoplan.cost.ai', {
                cost: costText(t, lastPreview),
                photos: t('rf.autoplan.photos', { count: photosSent(lastPreview) }),
              })
            : cloud === false
              ? t('rf.autoplan.cost.local')
              : null
          : t('rf.autoplan.source.export');
    foot = (
      <>
        <span className="grow rf-autoplan-foot">
          <span
            className="seg"
            role="group"
            aria-label={t('rf.autoplan.source')}
            data-testid="rf-autoplan-source"
          >
            {aiAvailable ? (
              <button
                type="button"
                aria-pressed={source === 'ai'}
                data-testid="rf-autoplan-source-ai"
                onClick={() => {
                  if (source !== 'ai') void switchSource('ai');
                }}
              >
                {provider}
              </button>
            ) : (
              // greyed with its reason in a tip (no native title), and still focusable to read it
              <Tip content={t('rf.autoplan.source.aiOff')}>
                <button
                  type="button"
                  aria-pressed={false}
                  aria-disabled="true"
                  aria-describedby="rf-autoplan-ai-off"
                  data-testid="rf-autoplan-source-ai"
                >
                  {provider}
                </button>
              </Tip>
            )}
            <button
              type="button"
              aria-pressed={source === 'rules'}
              data-testid="rf-autoplan-source-rules"
              onClick={() => {
                if (source !== 'rules') void switchSource('rules');
              }}
            >
              {t('rf.autoplan.source.rules')}
            </button>
          </span>
          {cost && <span className="rf-faint">{cost}</span>}
          {!aiAvailable && (
            <span id="rf-autoplan-ai-off" className="sr-only">
              {t('rf.autoplan.source.aiOff')}
            </span>
          )}
        </span>
        {cancelButton}
        <Button
          data-testid="rf-autoplan-apply"
          disabledReason={nothing}
          busy={busy}
          title={t('rf.autoplan.notSaved')}
          onClick={() => {
            void apply(false);
          }}
        >
          {t('rf.autoplan.apply')}
        </Button>
        <Button
          variant="primary"
          icon="play"
          data-testid="rf-autoplan-apply-run"
          disabledReason={nothing}
          busy={busy}
          onClick={() => {
            void apply(true);
          }}
        >
          {t('rf.autoplan.applyRun')}
        </Button>
      </>
    );
  } else {
    return null;
  }

  return (
    <PortalRoot opener={opener}>
      <div
        className="dlg-scrim"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div
          ref={dlg}
          className="dlg wide rf-autoplan"
          role="dialog"
          aria-modal="true"
          aria-labelledby="rf-autoplan-title"
          data-testid="rf-autoplan"
          data-phase={phase}
        >
          <div className="dlg-h">
            <h2 id="rf-autoplan-title">
              <span className="rf-autoplan-mark" aria-hidden="true">
                ✦
              </span>{' '}
              {title}
            </h2>
          </div>
          <div className="dlg-b">{body}</div>
          <div className="dlg-f">{foot}</div>
        </div>
      </div>
    </PortalRoot>
  );
}
