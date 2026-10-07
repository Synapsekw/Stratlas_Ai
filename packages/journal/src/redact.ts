import { readSegment, writeSegmentLine } from './segment';

/**
 * Remove the payload of op `id` from a segment's text (owner redaction). Everything else stays
 * byte for byte: `ph` and the id are untouched, so the chain still verifies, and Verify accepts
 * the missing payload only because an `op.redact` op names it. Null when the op is not in the
 * text or has no payload left.
 */
export function stripPayload(text: string, id: string): string | null {
  const lines = text.split('\n');
  let hit = false;
  for (const l of readSegment(text)) {
    if (!l.ok || l.raw.id !== id || !('payload' in l.raw)) continue;
    const rest = Object.fromEntries(Object.entries(l.raw).filter(([k]) => k !== 'payload'));
    lines[l.line - 1] = writeSegmentLine(rest).slice(0, -1);
    hit = true;
  }
  return hit ? lines.join('\n') : null;
}

/** Roles of a shared project's members from its `member.*` ops, in clock order. */
export function rolesFrom(ops: readonly { raw: Record<string, unknown> }[]): Map<string, string> {
  const roles = new Map<string, string>();
  const sorted = [...ops].sort((a, b) => String(a.raw.hlc).localeCompare(String(b.raw.hlc)));
  for (const { raw } of sorted) {
    const p = raw.payload as Record<string, unknown> | undefined;
    if (!p || typeof p.actor !== 'string') continue;
    if (raw.kind === 'member.add' || raw.kind === 'member.role') {
      if (typeof p.role === 'string') roles.set(p.actor, p.role);
    } else if (raw.kind === 'member.remove') {
      roles.delete(p.actor);
    }
  }
  return roles;
}
