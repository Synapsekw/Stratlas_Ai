import { z } from 'zod';

export const ToolRisk = z.enum(['read', 'navigate', 'write', 'send']);
export const ToolScope = z.enum(['app', 'project', 'window']);
export const WindowKind = z.enum([
  'scene3d',
  'map',
  'video',
  'photo',
  'pointcloud',
  'report',
  'issues',
]);
/** `local` is an OpenAI-compatible endpoint on this machine (for example Ollama); it needs no key. */
export const AiProvider = z.enum(['anthropic', 'openai', 'google', 'local']);
export const AiTask = z.enum(['chat', 'vision', 'report', 'extract', 'build']);

/** Metadata for an agent tool. The executable `run` lives in @aio/ai and the owning package. */
export const ToolMeta = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{2,63}$/, 'Tool names are lower snake_case'),
  description: z.string().min(10),
  scope: ToolScope,
  risk: ToolRisk,
  windows: z.array(WindowKind).optional(),
});

export type ToolRisk = z.infer<typeof ToolRisk>;
export type ToolScope = z.infer<typeof ToolScope>;
export type WindowKind = z.infer<typeof WindowKind>;
export type AiProvider = z.infer<typeof AiProvider>;
export type AiTask = z.infer<typeof AiTask>;
export type ToolMeta = z.infer<typeof ToolMeta>;

/** Write and send actions always need the person's approval. */
export const needsApproval = (risk: ToolRisk): boolean => risk === 'write' || risk === 'send';
