import { useId, useRef, useState, type HTMLAttributes } from 'react';
import type {
  CorrectionComposerDraft,
  CorrectionPanelProps,
  CorrectionTargetView,
} from './CorrectionPanel.types';
import { Button, Chip, EmptyState } from './CorrectionPanel.ui';
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
const STATUS = {
  open: 'Queued',
  submitted: 'Sent to AI',
  proposed: 'Ready to review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  stale: 'Needs a new proposal',
  failed: 'Needs attention',
};
function targetLabel(target: CorrectionTargetView): string {
  return target.kind === 'part' ? target.label : 'Location pin';
}
function Position({ position }: { position: [number, number, number] }) {
  return (
    <p className="eng-correction-coordinates">
      Project-local metres: X {position[0].toFixed(3)}, Y {position[1].toFixed(3)}, Z{' '}
      {position[2].toFixed(3)}
    </p>
  );
}

/** Content only. The parent owns model selection, scene rendering, persistence and AI delivery. */
export function CorrectionPanel(p: CorrectionPanelProps) {
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
  const [notice, setNotice] = useState('');
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
    setNotice('');
    try {
      await action();
      success();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : 'The action could not be saved. Try again.',
      );
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
      aria-label="Model corrections"
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
            {p.sourceVisible ? 'Hide source cloud' : 'Show source cloud'}
          </Button>
        </ActionRow>
      )}
      <details
        key={p.selectedRequestId ?? 'compose'}
        className="eng-correction-composer"
        aria-label="New correction request"
        open={!selected}
      >
        <summary>
          <h3>Request a correction</h3>
        </summary>
        <div className="eng-correction-section">
          <p className="eng-correction-hint">
            Choose a part or mark a missing item in the scene. The model stays visible while you
            review.
          </p>
          {p.readOnly && (
            <p role="status" className="eng-correction-hint">
              This model is read-only. Open an editable modelling run to request changes.
            </p>
          )}
          <ViewSwitch
            label="Correction target"
            value={targetMode}
            onChange={changeMode}
            items={[
              { value: 'part', label: 'Selected part', disabled: locked },
              { value: 'pin', label: 'Location pin', disabled: locked },
            ]}
          />
          {targetMode === 'part' ? (
            <label className="eng-correction-field">
              Part to correct
              <select
                className="input"
                aria-label="Part to correct"
                value={p.selectedPartId ?? ''}
                disabled={locked || p.parts.length === 0}
                onChange={(e) => {
                  p.onSelectPart(e.target.value);
                }}
              >
                <option value="">Select a part in the model</option>
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
                    Correction radius (m)
                    <input
                      type="number"
                      className="input"
                      aria-label="Correction radius (m)"
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
                  <p className="eng-correction-hint">
                    Changes must stay within this distance of the pin. Choose 0.1 to 5 metres.
                  </p>
                  <ActionRow>
                    <Button
                      disabled={locked}
                      onClick={() => {
                        p.onClearPin();
                        p.onPinModeChange(true);
                      }}
                    >
                      Move pin
                    </Button>
                    <Button
                      disabled={!!p.busy || pending}
                      onClick={() => {
                        p.onClearPin();
                        p.onPinModeChange(false);
                        setTargetMode('part');
                      }}
                    >
                      Remove pin
                    </Button>
                  </ActionRow>
                </>
              ) : (
                <>
                  <p role="status" className="eng-correction-hint">
                    {p.pinMode
                      ? 'Click a surface on the model or point cloud to place a pin. Empty space cannot be pinned.'
                      : 'Choose Place pin, then click a surface on the model or point cloud.'}
                  </p>
                  {!p.pinMode && (
                    <Button
                      disabled={locked}
                      onClick={() => {
                        p.onPinModeChange(true);
                      }}
                    >
                      Place pin
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
                  Cancel picking
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
              Show target in scene
            </Button>
          )}
          <label className="eng-correction-field" htmlFor={`${id}-comment`}>
            Describe the discrepancy
            <textarea
              id={`${id}-comment`}
              className="input"
              aria-label="Describe the discrepancy"
              rows={3}
              aria-describedby={`${id}-comment-help`}
              value={comment}
              maxLength={TEXT_LIMIT}
              disabled={locked}
              placeholder="What is wrong, and what should change?"
              onChange={(e) => {
                setComment(e.target.value);
              }}
            />
          </label>
          <p id={`${id}-comment-help`} className="eng-correction-hint">
            Be specific about the visible difference. Saving keeps this request in the project;
            sending to AI is a separate action.
          </p>
          {p.evidenceOptions.length > 0 && (
            <details className="eng-correction-evidence">
              <summary>
                Source evidence
                {selectedEvidence.length ? ` (${selectedEvidence.length} selected)` : ' (optional)'}
              </summary>
              <p className="eng-correction-hint">
                Attach the source photos or views that show the discrepancy.
              </p>
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
                        {item.kind ? ` (${item.kind})` : ''}
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
                      setNotice('Request saved. Send it to AI when the review is ready.');
                    },
                  );
              }}
            >
              Save request
            </Button>
            {p.onDiscardDraft && (
              <Button
                variant="quiet"
                disabled={locked || (!comment && !validPin && evidenceIds.length === 0)}
                onClick={p.onDiscardDraft}
              >
                Discard draft
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
      {(notice !== '' || !!p.busy || pending) && (
        <p role="status" className="eng-correction-hint">
          {p.busy || pending ? 'Saving or preparing the correction…' : notice}
        </p>
      )}

      <div className="eng-correction-section">
        <ActionRow>
          <h3>Saved requests</h3>
          <Chip kind="tag">{p.requests.length}</Chip>
        </ActionRow>
        {p.requests.length === 0 ? (
          <EmptyState
            title="Save a request above to begin a review."
            body="Your original model stays unchanged until you accept a correction."
          />
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
                      {targetLabel(request.target)}
                    </Button>
                    <Chip kind="status">{STATUS[request.status]}</Chip>
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
                ? `Send ${queued.length} ${queued.length === 1 ? 'request' : 'requests'} to AI`
                : 'No requests waiting to send'}
            </Button>
            <p className="eng-correction-hint">
              AI proposes changes for review. Sending requests does not accept a correction.
            </p>
          </>
        )}
      </div>

      {selected && (
        <div className="eng-correction-section" aria-label="Selected correction request">
          <ActionRow>
            <h3>{targetLabel(selected.target)}</h3>
            <Chip kind="status">{STATUS[selected.status]}</Chip>
          </ActionRow>
          <p className="eng-correction-comment">{selected.comment}</p>
          {selected.target.kind === 'pin' && <Position position={selected.target.position} />}
          {selected.target.kind === 'pin' && (
            <p className="eng-correction-hint">
              Permitted correction radius: {selected.target.radiusM ?? 2} m
            </p>
          )}
          <Button
            variant="quiet"
            onClick={() => {
              p.onFocusTarget(selected.target);
            }}
          >
            Show request in scene
          </Button>
          {selected.evidenceIds.length > 0 && (
            <p className="eng-correction-hint">
              Evidence:{' '}
              {selected.evidenceIds
                .map((ref) => p.evidenceOptions.find((item) => item.id === ref)?.label ?? ref)
                .join(', ')}
            </p>
          )}
          {selected.error && (
            <p role="alert" className="eng-correction-error">
              {selected.error}
            </p>
          )}
          {proposal ? (
            <>
              <h4>Review proposed changes</h4>
              <ViewSwitch
                label="Compare correction"
                value={p.view}
                onChange={p.onViewChange}
                items={[
                  { value: 'before', label: 'Before' },
                  { value: 'after', label: 'After', disabled: p.proposalReady === false || stale },
                ]}
              />
              <p className="eng-correction-hint">
                Compare from the same viewpoint in the scene.{' '}
                {p.view === 'before' ? 'Showing the current model.' : 'Showing the proposed model.'}
              </p>
              {p.proposalReady === false && (
                <p role="status" className="eng-correction-hint">
                  Preparing the proposed model. Acceptance is available once it is visible.
                </p>
              )}
              <p className="eng-correction-comment">{proposal.explanation}</p>
              <ul className="eng-correction-changes">
                {proposal.changes.map((change) => (
                  <li key={change.partId}>
                    <Chip kind="status">
                      {change.kind === 'added'
                        ? 'Added'
                        : change.kind === 'removed'
                          ? 'Removed'
                          : 'Changed'}
                    </Chip>
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
                  The model has changed since this proposal was prepared. Ask AI for a new proposal
                  before accepting changes.
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
                    Accept correction
                  </Button>
                  <Button
                    disabled={locked || stale}
                    onClick={() => void perform(() => p.onReject(proposal.id))}
                  >
                    Reject correction
                  </Button>
                </ActionRow>
              )}
              {activeProposal && p.view === 'before' && !stale && (
                <p className="eng-correction-hint">
                  View After to review the change before accepting.
                </p>
              )}
            </>
          ) : (
            <EmptyState
              title={
                selected.status === 'accepted'
                  ? 'This correction was accepted into the model.'
                  : selected.status === 'submitted'
                    ? 'Waiting for an AI proposal. The current model is unchanged.'
                    : 'A proposed model will appear here when AI returns a correction.'
              }
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
            Reply to this request
            <textarea
              id={`${id}-reply`}
              className="input"
              aria-label="Reply to this request"
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
                  setNotice('Reply saved. Send it to AI when you are ready.');
                },
              )
            }
          >
            Save reply
          </Button>
        </div>
      )}
    </section>
  );
}
