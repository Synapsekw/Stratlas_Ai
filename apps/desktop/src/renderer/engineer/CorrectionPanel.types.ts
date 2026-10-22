/** Presentation contract. Coordinates displayed here are project-local metres. */
export type CorrectionTargetView =
  | { kind: 'part'; partId: string; label: string }
  | { kind: 'pin'; position: [number, number, number]; layerId?: string; radiusM?: number }
  | { kind: 'model' };

export interface CorrectionEvidenceView {
  id: string;
  label: string;
  kind?: string;
  thumbnail?: string;
}

export interface CorrectionRequestView {
  id: string;
  target: CorrectionTargetView;
  comment: string;
  evidenceIds: string[];
  status: 'open' | 'submitted' | 'proposed' | 'accepted' | 'rejected' | 'stale';
  replies?: { id: string; text: string; author?: string }[];
  error?: string;
}

export interface CorrectionProposalView {
  id: string;
  requestId: string;
  explanation: string;
  changes: {
    partId: string;
    label: string;
    kind: 'added' | 'changed' | 'removed';
    detail?: string;
  }[];
  stale?: boolean;
}

type Action = void | Promise<void>;

export interface CorrectionComposerDraft {
  targetMode: 'part' | 'pin';
  comment: string;
  evidenceIds: string[];
  replies: Record<string, string>;
}

export interface CorrectionPanelProps {
  /** Optional controlled draft, retained by the app while moving between workbench tabs. */
  draft?: CorrectionComposerDraft;
  onDraftChange?: (patch: Partial<CorrectionComposerDraft>) => void;
  onDiscardDraft?: () => void;
  parts: { id: string; label: string }[];
  selectedPartId?: string;
  pin?: { position: [number, number, number]; layerId?: string };
  pinMode: boolean;
  pinRadiusM?: number;
  evidenceOptions: CorrectionEvidenceView[];
  requests: CorrectionRequestView[];
  selectedRequestId?: string;
  proposal?: CorrectionProposalView;
  view: 'before' | 'after';
  sourceVisible?: boolean;
  onSourceVisibleChange?: (visible: boolean) => void;
  busy?: boolean;
  /** Why the panel is busy, shown as the reason Send is off. */
  busyReason?: 'saving' | 'modelling' | 'sending';
  readOnly?: boolean;
  /** Why the AI cannot be asked right now (already translated), with an optional fix. */
  blocker?: { message: string; fix?: { label: string; onClick: () => void } };
  /** Shown under the pin picker when a pin will only be kept as a view hint. */
  pinNote?: string;
  /** The model has no measured scale yet, so the review notes sizes are model units. */
  scaleProvisional?: boolean;
  /** Set false while the proposed geometry has not finished loading in the scene. */
  proposalReady?: boolean;
  error?: string;
  onSelectPart: (id: string) => void;
  onPinModeChange: (enabled: boolean) => void;
  onPinRadiusChange?: (radiusM: number) => void;
  onClearPin: () => void;
  /**
   * Saves the typed correction; with `send` the parent also hands it, together with every
   * waiting (`open`) request, to the AI. No target means the whole model.
   */
  onSubmit: (request: {
    target?: CorrectionTargetView;
    comment: string;
    evidenceIds: string[];
    send: boolean;
  }) => Action;
  onSelectRequest: (id: string) => void;
  onSend: (ids: string[]) => Action;
  onViewChange: (view: 'before' | 'after') => void;
  onFocusTarget: (target: CorrectionTargetView) => void;
  onAccept: (proposalId: string) => Action;
  onReject: (proposalId: string) => Action;
  onReply: (requestId: string, text: string) => Action;
  /** Sends a rejected or proposed request back to the AI, with an optional new reply. */
  onResend: (requestId: string, reply?: string) => Action;
}
