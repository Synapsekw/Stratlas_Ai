import { t, type MessageKey } from '@aio/ui';

/** Group op kinds for the preview: issues, comments, approvals... */
export function kindGroups(byKind: Record<string, number>): [MessageKey, number][] {
  const groups = new Map<MessageKey, number>();
  for (const [kind, n] of Object.entries(byKind)) {
    const head = kind.split('.')[0] ?? '';
    const key: MessageKey =
      head === 'issue'
        ? 'team.kind.issue'
        : head === 'comment'
          ? 'team.kind.comment'
          : head === 'approval'
            ? 'team.kind.approval'
            : head === 'assign'
              ? 'team.kind.assign'
              : head === 'blob'
                ? 'team.kind.blob'
                : ['member', 'device', 'policy', 'project'].includes(head)
                  ? 'team.kind.team'
                  : 'team.kind.other';
    groups.set(key, (groups.get(key) ?? 0) + n);
  }
  return [...groups.entries()];
}

/** Check a new passphrase: null when fine (or not encrypting). */
export function passphraseProblem(encrypt: boolean, pass: string, again: string): string | null {
  if (!encrypt) return null;
  if (pass.length < 8) return t('team.export.passShort');
  if (pass !== again) return t('team.export.passMismatch');
  return null;
}
