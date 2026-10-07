import { useState, type CSSProperties } from 'react';
import type { DateTag } from '@aio/workspace';
import { useT } from '../i18n';
import { Icon } from '../icons/Icon';
import { DatasetTree, VisibilityEye, type DatasetTreeProps } from './DatasetTree';
import { EVERY_DATE, type DateFolder } from './dateModel';

export interface DateTreeProps extends Omit<DatasetTreeProps, 'groups' | 'collapsed' | 'nested'> {
  folders: readonly DateFolder[];
  tags: Readonly<Record<string, DateTag>>;
  focus: string | null;
  onFocus: (capture: string) => void;
}

export function DateTree(props: DateTreeProps) {
  const { folders, tags, focus, onFocus, hidden, ...rest } = props;
  const t = useT();
  const [open, setOpen] = useState<Record<string, boolean>>(() => ({
    [EVERY_DATE]: true,
    ...(focus ? { [focus]: true } : {}),
  }));

  // A new focus opens its folder and collapses the rest. Adjusted during render, not in an effect.
  const [seen, setSeen] = useState(focus);
  if (focus !== seen) {
    setSeen(focus);
    if (focus) setOpen((o) => ({ [EVERY_DATE]: o[EVERY_DATE] ?? true, [focus]: true }));
  }

  return (
    <div className="tree dtree" role="tree" aria-label={t('tree.dates.label')}>
      {folders.map((f) => {
        const expanded = open[f.id] === true;
        const focused = f.id === focus;
        const empty = f.capture !== null && f.layerIds.length === 0;
        const tag = f.capture ? tags[f.capture.id] : undefined;
        const on = f.capture && !focused ? f.layerIds.filter((id) => !hidden[id]).length : 0;
        const toggle = () => {
          setOpen((o) => ({ ...o, [f.id]: !expanded }));
        };
        return (
          <div
            key={f.id}
            role="treeitem"
            aria-expanded={expanded}
            aria-selected={focused}
            className={`dfolder${focused ? ' focused' : ''}${empty ? ' empty' : ''}`}
            data-testid={`date-folder-${f.id}`}
            style={tag ? ({ '--dtag': tag.colour } as CSSProperties) : undefined}
          >
            <div className="dfolder-row">
              <button
                type="button"
                className="dchev"
                aria-label={t(expanded ? 'tree.dates.collapse' : 'tree.dates.expand', {
                  date: f.label,
                })}
                onClick={toggle}
              >
                <Icon name="chev-r" size={12} className="chev" />
              </button>
              <button
                type="button"
                className="dname"
                data-testid={`date-name-${f.id}`}
                aria-current={focused ? 'date' : undefined}
                title={f.capture ? t('tree.dates.focus', { date: f.label }) : undefined}
                onClick={() => {
                  if (f.capture) onFocus(f.capture.id);
                  else toggle();
                }}
              >
                <span className={tag ? 'dtag' : 'dtag every'} aria-hidden="true" />
                <span className="dlbl">{f.label}</span>
                {f.sub && <span className="dsub">{f.sub}</span>}
              </button>
              {on > 0 && (
                <span className="don" data-testid={`date-on-${f.id}`}>
                  {t('tree.dates.on', { count: on })}
                </span>
              )}
              {f.layerIds.length > 0 && props.onSetVisible && (
                <VisibilityEye
                  layerIds={f.layerIds}
                  hidden={hidden}
                  onSet={props.onSetVisible}
                  labels={{
                    all: t('tree.eye.hideDate', { date: f.label }),
                    none: t('tree.eye.showDate', { date: f.label }),
                    mixed: t('tree.eye.showDateMixed', { date: f.label }),
                  }}
                />
              )}
            </div>
            {expanded && empty && <p className="dempty">{t('tree.dates.empty')}</p>}
            {expanded && f.groups.length > 0 && (
              <DatasetTree {...rest} hidden={hidden} groups={f.groups} collapsed={false} nested />
            )}
          </div>
        );
      })}
    </div>
  );
}
