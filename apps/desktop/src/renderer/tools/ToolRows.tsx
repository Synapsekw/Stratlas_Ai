/**
 * The registry's tools as the Tools tab lists them (UI revision W8): a row per tool with its icon,
 * name, hint and key, pressed while it is on; a tool that cannot start here is greyed out with the
 * reason where its hint would be. The rows look like the Measure catalogue's (one vocabulary).
 */
import { ariaKeys, Row, shortcutHint, useT } from '@aio/ui';
import { availability, nameKeyOf, runTool, type ToolCtx, type ToolDef } from './registry';
import '../workspace/workbench/benches/measureBench.css';

const never = () => false;

/** A tool's state and its press (start, or stop when it is on and can stop). */
export function useToolPress(def: ToolDef, ctx: ToolCtx) {
  // each row and tile is keyed by its tool, so the hook it calls is always the same one
  const useOn = def.useOn ?? never;
  const on = useOn(ctx);
  const can = availability(def, ctx);
  return {
    on,
    can,
    press: () => {
      if (on && def.stop) def.stop(ctx);
      else runTool(def, ctx);
    },
  };
}

function ToolRow({ def, ctx }: { def: ToolDef; ctx: ToolCtx }) {
  const t = useT();
  const { on, can, press } = useToolPress(def, ctx);
  const name = t(nameKeyOf(def, on));
  const hint = can === true ? (def.hintKey ? t(def.hintKey) : '') : t(can.reason);
  return (
    <Row
      kind="tree"
      as="li"
      className="meb-row"
      selected={on}
      icon={def.icon}
      label={
        <button
          type="button"
          className="meb-tool"
          data-testid={`tool-${def.id}`}
          aria-pressed={def.useOn ? on : undefined}
          aria-keyshortcuts={def.shortcutId ? ariaKeys(def.shortcutId) : undefined}
          // greyed out with its reason under the name, still reached by Tab (an on tool can always
          // be put away)
          aria-disabled={can !== true && !on ? true : undefined}
          onClick={() => {
            if (can === true || on) press();
          }}
        >
          <span className="meb-name">{name}</span>
          {hint && <span className="meb-hint">{hint}</span>}
        </button>
      }
      {...(def.shortcutId ? { count: shortcutHint(def.shortcutId) } : {})}
    />
  );
}

/** A group's tools in the Tools tab, each a row. */
export function ToolRows({ tools, ctx }: { tools: readonly ToolDef[]; ctx: ToolCtx }) {
  const t = useT();
  if (tools.length === 0) return null;
  return (
    <ul className="meb-list tool-rows" aria-label={t('toolReg.list')}>
      {tools.map((d) => (
        <ToolRow key={d.id} def={d} ctx={ctx} />
      ))}
    </ul>
  );
}
