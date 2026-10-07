/**
 * Agent tools of the review workflow (M9 stream T3): specs only, shared by main (offered to the
 * model) and the renderer. Executors: `collab-tools.ts`.
 *
 * Decision 6: the agent may list work, show a thread, comment and ask for an approval, never
 * approve. There is no approve tool, and main refuses to start if any tool could approve.
 */
import { z } from 'zod';
import type { ToolSpec } from './tools';

const IssueRef = z.string().min(1).max(40).describe('Issue code or id, e.g. F03');
const PersonRef = z
  .string()
  .min(1)
  .max(80)
  .describe('A team member by name, first name or initials, e.g. Omar or OS');

export const collabToolInputs = {
  list_my_work: z
    .object({
      person: PersonRef.optional().describe('Whose work; default the person using the app'),
      list: z
        .enum(['all', 'assigned', 'mentions', 'awaiting'])
        .default('all')
        .describe('Assigned to them, mentions of them, or awaiting their approval'),
    })
    .strict(),
  show_thread: z.object({ issue: IssueRef }).strict(),
  add_comment: z
    .object({
      issue: IssueRef,
      text: z.string().trim().min(1).max(4000).describe('The comment; @Name mentions a member'),
      visibility: z
        .enum(['team', 'client'])
        .default('team')
        .describe('team: members only; client: the customer can see it too'),
    })
    .strict(),
  request_approval: z
    .object({
      issue: IssueRef,
      person: PersonRef.describe('The reviewer asked to approve'),
      note: z.string().max(1000).optional(),
      due: z.iso.date().optional().describe('Due date, YYYY-MM-DD'),
    })
    .strict(),
} as const;

export type CollabToolName = keyof typeof collabToolInputs;

export const COLLAB_TOOL_SPECS: ToolSpec[] = [
  {
    meta: {
      name: 'list_my_work',
      description:
        'List the review work of a team member (default: the person using the app): issues and items assigned to them, comments that mention them, and work awaiting their approval.',
      scope: 'project',
      risk: 'read',
    },
    input: collabToolInputs.list_my_work,
  },
  {
    meta: {
      name: 'show_thread',
      description:
        'Select an issue and show its comment thread and approvals; flies to the latest saved view of the thread when there is one.',
      scope: 'project',
      risk: 'navigate',
    },
    input: collabToolInputs.show_thread,
    undoable: true,
  },
  {
    meta: {
      name: 'add_comment',
      description:
        'Add a comment to an issue thread, optionally mentioning members with @Name. The person approves the comment before it is posted.',
      scope: 'project',
      risk: 'write',
    },
    input: collabToolInputs.add_comment,
  },
  {
    meta: {
      name: 'request_approval',
      description:
        'Ask a reviewer to approve an issue: assigns it to them with an optional due date and comments mentioning them. You can never approve anything yourself: only a person approves, in the app.',
      scope: 'project',
      risk: 'write',
    },
    input: collabToolInputs.request_approval,
  },
];
