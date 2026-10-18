import { useId, useRef, useState, type HTMLAttributes } from 'react';
import { formatNumber } from '@aio/geo';
import { Button, Chip, EmptyState, formatCount, useT, type MessageKey } from '@aio/ui';
import type {
  CorrectionComposerDraft,
  CorrectionPanelProps,
  CorrectionTargetView,
} from './CorrectionPanel.types';
import './CorrectionPanel.css';
export type { CorrectionPanelProps } from './CorrectionPanel.types';

/** Feature layout, not the design system's navigation Row. */
function ActionRow({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`eng-correction-row ${className}`} />;
}

/** Scene view switches, not design-system tab panels. */
function ViewSwitch<T extends string>({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: T;
  items: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <ActionRow role="group" aria-label={label}>
      {items.map((item) => (
        <Button
          key={item.value}
          pressed={value === item.value}
          disabled={item.disabled === true}
          onClick={() => {
            onChange(item.value);
          }}
        >
          {item.label}
        </Button>
      ))}
    </ActionRow>
  );
}

const TEXT_LIMIT = 4000;
const EVIDENCE_LIMIT = 16;
const EVIDENCE_KINDS: Record<string, MessageKey> = {
  photo: 'eng.ev.kind.photo',
  crop: 'eng.ev.kind.crop',
  side: 'eng.ev.kind.side',
  top: 'eng.ev.kind.top',
  slice: 'eng.ev.kind.slice',
  generated: 'eng.ev.kind.generated',
};
function targetLabel(target: CorrectionTargetView, t: ReturnType<typeof useT>): string {
  return target.kind === 'part' ? target.label : t('eng.correction.pin');
}
function Position({ position }: { position: [number, number, number] }) {
  const t = useT();
  return (
    <p className="eng-correction-coordinates">
      {t('eng.correction.position', {
        x: formatNumber(position[0], 3),
        y: formatNumber(position[1], 3),
        z: formatNumber(position[2], 3),
      })}
    </p>
  );
}

/** Content only. The parent owns model selection, scene rendering, persistence and AI delivery. */
export function CorrectionPanel(p: CorrectionPanelProps) {
  const t = useT();
  const id = useId();
  const [localDraft, setLocalDraft] = useState<CorrectionComposerDraft>({
    targetMode: 'part',
    comment: '',
    evidenceIds: [],
    replies: {},
  });
  const { targetMode, comment, evidenceIds, replies } = p.draft ?? localDraft;
  const changeDraft = (patch: Partial<CorrectionComposerDraft>) => {
    if (p.onDraftChange) p.onDraftChange(patch);
    else setLocalDraft((current) => ({ ...current, ...patch }));
  };
  const setTargetMode = (targetMode: 'part' | 'pin') => {
    changeDraft({ targetMode });
  };
  const setComment = (comment: string) => {
    changeDraft({ comment });
  };
  const setEvidenceIds = (evidenceIds: string[]) => {
    changeDraft({ evidenceIds });
  };
  const setReplies = (replies: Record<string, string>) => {
    changeDraft({ replies });
  };
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const locked = !!p.busy || !!p.readOnly || pending;
  const selectedPart = p.parts.find((part) => part.id === p.selectedPartId);
  const validPin = p.pin?.position.every(Number.isFinite) ? p.pin : undefined;
  const radiusM = p.pinRadiusM ?? 2;
  const validRadius = Number.isFinite(radiusM) && radiusM >= 0.1 && radiusM <= 5;
  const target: CorrectionTargetView | undefined =
    targetMode === 'part'
      ? selectedPart
        ? { kind: 'part', partId: selectedPart.id, label: selectedPart.label }
        : undefined
      : validPin && validRadius
        ? { kind: 'pin', ...validPin, radiusM }
        : undefined;
  const selected = p.requests.find((request) => request.id === p.selectedRequestId);
  const proposal = p.proposal?.requestId === selected?.id ? p.proposal : undefined;
  const activeProposal = !!proposal && selected?.status === 'proposed';
  const stale = !!proposal?.stale || selected?.status === 'stale';
  const queued = p.requests.filter(
    (request) => request.status === 'open' || request.status === 'failed',
  );
  const selectedEvidence = evidenceIds.filter((evidenceId) =>
    p.evidenceOptions.some((item) => item.id === evidenceId),
  );
  const reply = selected ? (replies[selected.id] ?? '') : '';

  async function perform(
    action: () => void | Promise<void>,
    success: () => void = () => undefined,
  ) {
    if (locked || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setActionError('');
    setNotice(null);
    try {
      await action();
      success();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('eng.correction.error.save'));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  function changeMode(mode: 'part' | 'pin') {
    if (locked) return;
    setTargetMode(mode);
    p.onPinModeChange(mode === 'pin' && !validPin);
  }

  return (
    <section
      className="eng-corrections"
      aria-label={t('eng.correction.label')}
      aria-busy={!!p.busy || pending}
    >
      {p.onSourceVisibleChange && (
        <ActionRow>
          <Button
            pressed={p.sourceVisible === true}
            onClick={() => {
              p.onSourceVisibleChange?.(!p.sourceVisible);
            }}
          >
            {t(p.sourceVisible ? 'eng.correction.source.hide' : 'eng.correction.source.show')}
          </Button>
        </ActionRow>
      )}
      <details
        key={p.selectedRequestId ?? 'compose'}
        className="eng-correction-composer"
        aria-label={t('eng.correction.new')}
        open={!selected}
      >
        <summary>
          <h3>{t('eng.correction.request')}</h3>
        </summary>
        <div className="eng-correction-section">
          <p className="eng-correction-hint">{t('eng.correction.requestHint')}</p>
          {p.readOnly && (
            <p role="status" className="eng-correction-hint">
              {t('eng.correction.readOnly')}
            </p>
          )}
          <ViewSwitch
            label={t('eng.correction.target')}
            value={targetMode}
            onChange={changeMode}
            items={[
              { value: 'part', label: t('eng.correction.selectedPart'), disabled: locked },
              { value: 'pin', label: t('eng.correction.pin'), disabled: locked },
            ]}
          />
          {targetMode === 'part' ? (
            <label className="eng-correction-field">
              {t('eng.correction.part')}
              <select
                className="input"
                aria-label={t('eng.correction.part')}
                value={p.selectedPartId ?? ''}
                disabled={locked || p.parts.length === 0}
                onChange={(e) => {
                  p.onSelectPart(e.target.value);
                }}
              >
                <option value="">{t('eng.correction.selectPart')}</option>
                {p.parts.map((part) => (
                  <option key={part.id} value={part.id}>
                    {part.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="eng-correction-field">
              {validPin ? (
                <>
                  <Position position={validPin.position} />
                  <label className="eng-correction-field">
                    {t('eng.correction.radius')}
                    <input
                      type="number"
                      className="input"
                      aria-label={t('eng.correction.radius')}
                      min={0.1}
                      max={5}
                      step={0.1}
                      value={Number.isFinite(radiusM) ? radiusM : ''}
                      disabled={locked || !p.onPinRadiusChange}
                      aria-invalid={!validRadius}
                      onChange={(e) => {
                        p.onPinRadiusChange?.(e.target.valueAsNumber);
                      }}
                    />
                  </label>
                  <p className="eng-correction-hint">{t('eng.correction.radiusHint')}</p>
                  <ActionRow>
                    <Button
                      disabled={locked}
                      onClick={() => {
                        p.onClearPin();
                        p.onPinModeChange(true);
                      }}
                    >
                      {t('eng.correction.pinMove')}
                    </Button>
                    <Button
                      disabled={!!p.busy || pending}
                      onClick={() => {
                        p.onClearPin();
                        p.onPinModeChange(false);
                        setTargetMode('part');
                      }}
                    >
                      {t('eng.correction.pinRemove')}
                    </Button>
                  </ActionRow>
                </>
              ) : (
                <>
                  <p role="status" className="eng-correction-hint">
                    {t(p.pinMode ? 'eng.correction.pinPicking' : 'eng.correction.pinHint')}
                  </p>
                  {!p.pinMode && (
                    <Button
                      disabled={locked}
                      onClick={() => {
                        p.onPinModeChange(true);
                      }}
                    >
                      {t('eng.correction.pinPlace')}
                    </Button>
                  )}
                </>
              )}
              {p.pinMode && (
                <Button
                  disabled={!!p.busy || pending}
                  onClick={() => {
                    p.onPinModeChange(false);
                    setTargetMode('part');
                  }}
                >
                  {t('eng.correction.pinCancel')}
                </Button>
              )}
            </div>
          )}
          {target && (
            <Button
              variant="quiet"
              disabled={!!p.busy}
              onClick={() => {
                p.onFocusTarget(target);
              }}
            >
              {t('eng.correction.showTarget')}
            </Button>
          )}
          <label className="eng-correction-field" htmlFor={`${id}-comment`}>
            {t('eng.correction.comment')}
            <textarea
              id={`${id}-comment`}
              className="input"
              aria-label={t('eng.correction.comment')}
              rows={3}
              aria-describedby={`${id}-comment-help`}
              value={comment}
              maxLength={TEXT_LIMIT}
              disabled={locked}
              placeholder={t('eng.correction.commentPlaceholder')}
              onChange={(e) => {
                setComment(e.target.value);
              }}
            />
          </label>
          <p id={`${id}-comment-help`} className="eng-correction-hint">
            {t('eng.correction.commentHint')}
          </p>
          {p.evidenceOptions.length > 0 && (
            <details className="eng-correction-evidence">
              <summary>
                {selectedEvidence.length
                  ? t('eng.correction.evidenceSelected', { count: selectedEvidence.length })
                  : t('eng.correction.evidenceOptional')}
              </summary>
              <p className="eng-correction-hint">{t('eng.correction.evidenceHint')}</p>
              <div className="eng-correction-evidence-list">
                {p.evidenceOptions.map((item) => (
                  <label key={item.id} className="eng-correction-evidence-item">
                    <input
                      type="checkbox"
                      checked={selectedEvidence.includes(item.id)}
                      disabled={
                        locked ||
                        (!selectedEvidence.includes(item.id) &&
                          selectedEvidence.length >= EVIDENCE_LIMIT)
                      }
                      onChange={(e) => {
                        setEvidenceIds(
                          e.target.checked
                            ? [...selectedEvidence, item.id]
                            : selectedEvidence.filter((v) => v !== item.id),
                        );
                      }}
                    />
                    {item.thumbnail && <img src={item.thumbnail} alt="" loading="lazy" />}
                    <span>
                      {item.label}
                      <small>
                        {item.id}
                        {item.kind
                          ? ` (${EVIDENCE_KINDS[item.kind] ? t(EVIDENCE_KINDS[item.kind]) : item.kind})`
                          : ''}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            </details>
          )}
          <ActionRow>
            <Button
              disabled={locked || !target || !comment.trim() || comment.length > TEXT_LIMIT}
              onClick={() => {
                if (target)
                  void perform(
                    () =>
                      p.onCreate({
                        target,
                        comment: comment.trim(),
                        evidenceIds: selectedEvidence,
                      }),
                    () => {
                      setComment('');
                      setEvidenceIds([]);
                      setNotice('eng.correction.saved');
                    },
                  );
              }}
            >
              {t('eng.correction.save')}
            </Button>
            {p.onDiscardDraft && (
              <Button
                variant="quiet"
                disabled={locked || (!comment && !validPin && evidenceIds.length === 0)}
                onClick={p.onDiscardDraft}
              >
                {t('eng.correction.discard')}
              </Button>
            )}
          </ActionRow>
        </div>
      </details>

      {((p.error?.length ?? 0) > 0 || actionError !== '') && (
        <p role="alert" className="eng-correction-error">
          {actionError ? actionError : p.error}
        </p>
      )}
      {(notice !== null || !!p.busy || pending) && (
        <p role="status" className="eng-correction-hint">
          {p.busy || pending ? t('eng.correction.busy') : notice && t(notice)}
        </p>
      )}

      <div className="eng-correction-section">
        <ActionRow>
          <h3>{t('eng.correction.requests')}</h3>
          <Chip kind="tag">{formatCount(p.requests.length)}</Chip>
        </ActionRow>
        {p.requests.length === 0 ? (
          <EmptyState title={t('eng.correction.empty')} body={t('eng.correction.emptyBody')} />
        ) : (
          <>
            <ul className="eng-correction-queue">
              {p.requests.map((request) => (
                <li key={request.id} data-selected={request.id === selected?.id}>
                  <ActionRow>
                    <Button
                      variant="quiet"
                      pressed={request.id === selected?.id}
                      onClick={() => {
                        p.onSelectRequest(request.id);
                      }}
                    >
                      {targetLabel(request.target, t)}
                    </Button>
                    <Chip kind="status">{t(`eng.correction.status.${request.status}`)}</Chip>
                  </ActionRow>
                  <p>{request.comment}</p>
                </li>
              ))}
            </ul>
            <Button
              disabled={locked || queued.length === 0}
              onClick={() => void perform(() => p.onSend(queued.map((request) => request.id)))}
            >
              {queued.length
                ? t('eng.correction.send', { count: queued.length })
                : t('eng.correction.noneToSend')}
            </Button>
            <p className="eng-correction-hint">{t('eng.correction.sendHint')}</p>
          </>
        )}
      </div>

      {selected && (
        <div className="eng-correction-section" aria-label={t('eng.correction.selectedRequest')}>
          <ActionRow>
            <h3>{targetLabel(selected.target, t)}</h3>
            <Chip kind="status">{t(`eng.correction.status.${selected.status}`)}</Chip>
          </ActionRow>
          <p className="eng-correction-comment">{selected.comment}</p>
          {selected.target.kind === 'pin' && <Position position={selected.target.position} />}
          {selected.target.kind === 'pin' && (
            <p className="eng-correction-hint">
              {t('eng.correction.permittedRadius', {
                radius: formatNumber(selected.target.radiusM ?? 2, 1),
              })}
            </p>
          )}
          <Button
            variant="quiet"
            onClick={() => {
              p.onFocusTarget(selected.target);
            }}
          >
            {t('eng.correction.showRequest')}
          </Button>
          {selected.evidenceIds.length > 0 && (
            <p className="eng-correction-hint">
              {t('eng.correction.evidence', {
                labels: selected.evidenceIds
                  .map((ref) => p.evidenceOptions.find((item) => item.id === ref)?.label ?? ref)
                  .join(', '),
              })}
            </p>
          )}
          {selected.error && (
            <p role="alert" className="eng-correction-error">
              {selected.error}
            </p>
          )}
          {proposal ? (
            <>
              <h4>{t('eng.correction.review')}</h4>
              <ViewSwitch
                label={t('eng.correction.compare')}
                value={p.view}
                onChange={p.onViewChange}
                items={[
                  { value: 'before', label: t('eng.correction.before') },
                  {
                    value: 'after',
                    label: t('eng.correction.after'),
                    disabled: p.proposalReady === false || stale,
                  },
                ]}
              />
              <p className="eng-correction-hint">
                {t(p.view === 'before' ? 'eng.correction.beforeHint' : 'eng.correction.afterHint')}
              </p>
              {p.proposalReady === false && (
                <p role="status" className="eng-correction-hint">
                  {t('eng.correction.preparing')}
                </p>
              )}
              <p className="eng-correction-comment">{proposal.explanation}</p>
              <ul className="eng-correction-changes">
                {proposal.changes.map((change) => (
                  <li key={change.partId}>
                    <Chip kind="status">{t(`eng.correction.change.${change.kind}`)}</Chip>
                    <Button
                      variant="quiet"
                      onClick={() => {
                        p.onFocusTarget({
                          kind: 'part',
                          partId: change.partId,
                          label: change.label,
                        });
                      }}
                    >
                      {change.label}
                      {change.detail ? `: ${change.detail}` : ''}
                    </Button>
                  </li>
                ))}
              </ul>
              {stale && (
                <p role="alert" className="eng-correction-error">
                  {t('eng.correction.stale')}
                </p>
              )}
              {activeProposal && (
                <ActionRow>
                  <Button
                    variant="primary"
                    disabled={
                      locked ||
                      stale ||
                      p.proposalReady === false ||
                      p.view !== 'after' ||
                      proposal.changes.length === 0
                    }
                    onClick={() => void perform(() => p.onAccept(proposal.id))}
                  >
                    {t('eng.correction.accept')}
                  </Button>
                  <Button
                    disabled={locked || stale}
                    onClick={() => void perform(() => p.onReject(proposal.id))}
                  >
                    {t('eng.correction.reject')}
                  </Button>
                </ActionRow>
              )}
              {activeProposal && p.view === 'before' && !stale && (
                <p className="eng-correction-hint">{t('eng.correction.viewAfter')}</p>
              )}
            </>
          ) : (
            <EmptyState
              title={t(
                selected.status === 'accepted'
                  ? 'eng.correction.accepted'
                  : selected.status === 'submitted'
                    ? 'eng.correction.waiting'
                    : 'eng.correction.noProposal',
              )}
            />
          )}
          {selected.replies && selected.replies.length > 0 && (
            <ul className="eng-correction-replies">
              {selected.replies.map((entry) => (
                <li key={entry.id}>
                  {entry.author && <b>{entry.author}</b>}
                  <p>{entry.text}</p>
                </li>
              ))}
            </ul>
          )}
          <label className="eng-correction-field" htmlFor={`${id}-reply`}>
            {t('eng.correction.reply')}
            <textarea
              id={`${id}-reply`}
              className="input"
              aria-label={t('eng.correction.reply')}
              rows={2}
              maxLength={TEXT_LIMIT}
              disabled={locked}
              value={reply}
              onChange={(e) => {
                setReplies({ ...replies, [selected.id]: e.target.value });
              }}
            />
          </label>
          <Button
            disabled={locked || !reply.trim() || reply.length > TEXT_LIMIT}
            onClick={() =>
              void perform(
                () => p.onReply(selected.id, reply.trim()),
                () => {
                  setReplies({ ...replies, [selected.id]: '' });
                  setNotice('eng.correction.replySaved');
                },
              )
            }
          >
            {t('eng.correction.replySave')}
          </Button>
        </div>
      )}
    </section>
  );
}
