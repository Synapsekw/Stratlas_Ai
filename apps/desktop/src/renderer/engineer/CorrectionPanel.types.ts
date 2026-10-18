/** Presentation contract. Coordinates displayed here are project-local metres. */
export type CorrectionTargetView =
  | { kind: 'part'; partId: string; label: string }
  | { kind: 'pin'; position: [number, number, number]; layerId?: string; radiusM?: number };

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
  status: 'open' | 'submitted' | 'proposed' | 'accepted' | 'rejected' | 'stale' | 'failed';
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
  readOnly?: boolean;
  /** Set false while the proposed geometry has not finished loading in the scene. */
  proposalReady?: boolean;
  error?: string;
  onSelectPart: (id: string) => void;
  onPinModeChange: (enabled: boolean) => void;
  onPinRadiusChange?: (radiusM: number) => void;
  onClearPin: () => void;
  onCreate: (request: {
    target: CorrectionTargetView;
    comment: string;
    evidenceIds: string[];
  }) => Action;
  onSelectRequest: (id: string) => void;
  onSend: (ids: string[]) => Action;
  onViewChange: (view: 'before' | 'after') => void;
  onFocusTarget: (target: CorrectionTargetView) => void;
  onAccept: (proposalId: string) => Action;
  onReject: (proposalId: string) => Action;
  onReply: (requestId: string, text: string) => Action;
}
