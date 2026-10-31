import { MenuAt, useT } from '@aio/ui';

export interface IssueRowMenuProps {
  /** Client pixels of the right-click. */
  x: number;
  y: number;
  /** How many issues the menu acts on. */
  count: number;
  onPlace: () => void;
  onClose: () => void;
}

/** The issue list's right-click menu: actions the app set with `setIssueListActions`. */
export function IssueRowMenu({ x, y, count, onPlace, onClose }: IssueRowMenuProps) {
  const t = useT();
  return (
    <MenuAt
      x={x}
      y={y}
      label={t('place.menu', { count })}
      testId="issue-row-menu"
      onClose={onClose}
      items={[
        {
          id: 'place',
          label: t('place.menu', { count }),
          testId: 'issue-place-on-model',
          onSelect: onPlace,
        },
      ]}
    />
  );
}
