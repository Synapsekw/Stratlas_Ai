import { Tabs, useT, type TabItem } from '@aio/ui';
import { PANEL_TAB_LABEL, PANEL_TABS, type PanelTab } from './tabsModel';

export interface TabBarProps {
  front: PanelTab;
  /** Counts shown beside a tab's name (Project: open issues). */
  counts: Partial<Record<PanelTab, number>>;
  /** Tabs with a live tool or activity in them (a dot). */
  live: ReadonlySet<PanelTab>;
  onShow: (tab: PanelTab) => void;
}

/**
 * The right panel's four fixed tabs (D2): Selection, Tools, Layers & display, Project, always in
 * this order on one row. No pin, no close and no "More tabs": they share the row at every width.
 */
export function TabBar({ front, counts, live, onShow }: TabBarProps) {
  const t = useT();
  const items: TabItem<PanelTab>[] = PANEL_TABS.map((id) => {
    const count = counts[id];
    return {
      id,
      label: t(PANEL_TAB_LABEL[id]),
      ...(count !== undefined && count > 0 ? { count } : {}),
      ...(live.has(id) ? { live: true } : {}),
    };
  });
  return (
    <div className="wb-bar wb-bar-fixed">
      <Tabs items={items} value={front} onChange={onShow} label={t('wb.label')} idPrefix="wb" />
    </div>
  );
}
