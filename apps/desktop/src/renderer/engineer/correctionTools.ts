import { registerRendererTool, ToolError, type ToolRunResult } from '@aio/ai';
import type { CorrectionProposalInput } from '@aio/schema';
import type { CorrectionSession } from './correctionSession';

export interface CorrectionToolHost {
  session: CorrectionSession;
  cloudRoute(): Promise<boolean>;
  permissions(): { photos: boolean; scans: boolean; drawings: boolean };
  readEvidence(imageId: string): Promise<string>;
}
let active: CorrectionToolHost | null = null;
let submitted: {
  host: CorrectionToolHost;
  ids: string[];
  scope: ReturnType<CorrectionSession['submission']>;
  content: string;
} | null = null;

export function setCorrectionSession(host: CorrectionToolHost | null): void {
  active = host;
  submitted = null;
}
function open(): CorrectionToolHost {
  if (!active) throw new ToolError('Open an editable engineering model to review corrections.');
  return active;
}
async function permitted(
  host: CorrectionToolHost,
  scope: ReturnType<CorrectionSession['submission']>,
): Promise<void> {
  if (!(await host.cloudRoute())) return;
  const allowed = host.permissions();
  for (const kind of ['photos', 'scans', 'drawings'] as const) {
    if (scope.required[kind] && !allowed[kind])
      throw new ToolError(
        `This project keeps ${kind} local. Allow cloud AI for ${kind} in project settings or choose a local model before submitting corrections.`,
      );
  }
}
/** Called only by the person's Send action. Includes exact text/geometry in the normal send preview. */
export async function prepareCorrectionSubmission(ids: string[]): Promise<string> {
  const host = open();
  const scope = host.session.submission(ids);
  await permitted(host, scope);
  const latest = host.session.submission(ids);
  if (
    host !== active ||
    scope.model !== latest.model ||
    scope.projectId !== latest.projectId ||
    scope.runId !== latest.runId ||
    JSON.stringify(scope.data) !== JSON.stringify(latest.data)
  )
    throw new ToolError('The correction requests changed. Review and send them again.');
  const content = JSON.stringify(scope.data);
  submitted = { host, ids: [...ids], scope, content };
  return content;
}
async function checked(requestId?: string) {
  const host = open();
  const s = submitted;
  if (s?.host !== host)
    throw new ToolError('A person must select correction requests and press Send to AI first.');
  if (requestId && !s.ids.includes(requestId))
    throw new ToolError('This correction request was not submitted.');
  const now = host.session.submission(s.ids);
  if (
    now.projectId !== s.scope.projectId ||
    now.runId !== s.scope.runId ||
    now.model !== s.scope.model ||
    JSON.stringify(now.data) !== s.content
  )
    throw new ToolError('The correction requests or model changed. Review and send them again.');
  await permitted(host, now);
  if (host !== active || s !== submitted)
    throw new ToolError('The open project changed. Submit again.');
  const latest = host.session.submission(s.ids);
  if (
    latest.model !== s.scope.model ||
    latest.projectId !== s.scope.projectId ||
    latest.runId !== s.scope.runId ||
    JSON.stringify(latest.data) !== s.content
  )
    throw new ToolError('The correction requests or model changed. Review and send them again.');
  return { host, scope: now };
}
function safe(action: (raw: unknown) => Promise<ToolRunResult>) {
  return async (raw: unknown): Promise<ToolRunResult> => {
    try {
      return await action(raw);
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(
        e instanceof Error ? e.message.slice(0, 1200) : 'The correction could not be saved.',
      );
    }
  };
}
export function registerCorrectionTools(): void {
  registerRendererTool(
    'list_model_corrections',
    safe(async () => ({
      result: (await checked()).scope.data,
      summary: 'Submitted model correction requests',
    })),
  );
  registerRendererTool(
    'propose_model_correction',
    safe(async (raw) => {
      const input = raw as { requestId: string; proposal: CorrectionProposalInput };
      const { host } = await checked(input.requestId);
      const result = await host.session.propose(input.requestId, input.proposal);
      return { result, summary: 'Correction proposal ready for Before/After review' };
    }),
  );
  registerRendererTool(
    'view_model_correction_evidence',
    safe(async (raw) => {
      const input = raw as { requestId: string; imageId: string };
      const { host, scope } = await checked(input.requestId);
      const r = scope.data.requests.find((r) => r.id === input.requestId);
      if (
        !r?.evidence?.some(
          (e) =>
            e.ref === input.imageId &&
            (e.kind === 'photo' || e.kind === 'cloud' || e.kind === 'mesh'),
        )
      )
        throw new ToolError('Choose an image attached to this submitted correction request.');
      const image = await host.readEvidence(input.imageId);
      await checked(input.requestId);
      return {
        result: { image, imageId: input.imageId },
        summary: 'Prepared correction evidence image',
      };
    }),
  );
}
