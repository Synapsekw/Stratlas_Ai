import { Tabs, useT, type TabItem } from '@aio/ui';
import { overflowOrderFor, type Tab, type TabId } from './tabsModel';

export interface TabBarProps {
  tabs: Tab[];
  front: TabId;
  /** Counts shown beside a tab's name (Issues, Volumes). */
  counts: Partial<Record<TabId, number>>;
  onShow: (id: TabId) => void;
  onPin: (id: TabId, pinned: boolean) => void;
  onClose: (id: TabId) => void;
}

/**
 * The workbench tab bar: the foundation `Tabs` on one row, the tabs that do not fit in its
 * "More tabs" menu in the model's order (fixed first, live last). Only maps the model's tabs to
 * `TabItem`s; the tab, dot, pin, close and overflow are the foundation's.
 */
export function TabBar({ tabs, front, counts, onShow, onPin, onClose }: TabBarProps) {
  const t = useT();
  const items: TabItem<TabId>[] = tabs.map((tab) => {
    const count = counts[tab.id];
    return {
      id: tab.id,
      label: t(`wb.tab.${tab.id}`),
      ...(count !== undefined ? { count } : {}),
      ...(tab.live ? { live: true } : {}),
      ...(tab.id === 'changes' ? { testId: 'tab-changes' } : {}),
      ...(tab.fixed
        ? {}
        : {
            pinned: tab.pinned,
            onPinChange: (on: boolean) => {
              onPin(tab.id, on);
            },
            onClose: () => {
              onClose(tab.id);
            },
          }),
    };
  });
  return (
    <div className="wb-bar">
      <Tabs
        items={items}
        value={front}
        onChange={onShow}
        label={t('wb.label')}
        idPrefix="wb"
        overflow="menu"
        overflowOrder={overflowOrderFor({ tabs })}
      />
    </div>
  );
}
