const css = `
.clb { display: flex; flex-direction: column; gap: 8px; font: 400 var(--t-12)/1.45 var(--f-ui); color: var(--fg-1); min-width: 0; }
.clb-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line-soft); }
.clb-tab { height: 26px; padding: 0 10px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--fg-3); font: 500 var(--t-12)/1 var(--f-ui); cursor: pointer; }
.clb-tab[aria-selected='true'] { color: var(--fg-0); border-bottom-color: var(--acc); }
.clb-tab:focus-visible, .clb-btn:focus-visible, .clb-input:focus-visible, .clb-link:focus-visible { outline: 2px solid var(--acc); outline-offset: -2px; }
.clb-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.clb-btn { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-4); background: var(--bg-2); color: var(--fg-1); font: 500 var(--t-12)/1 var(--f-ui); cursor: pointer; white-space: nowrap; }
.clb-btn:hover:not(:disabled) { background: var(--bg-3); border-color: var(--line-strong); }
.clb-btn:disabled { opacity: .45; cursor: default; }
.clb-btn.primary, .clb-btn.primary:hover:not(:disabled) { background: var(--acc); border-color: var(--acc); color: var(--acc-ink); }
.clb-btn.ghost { background: transparent; border-color: transparent; }
.clb-btn.on { border-color: var(--acc); color: var(--fg-0); }
.clb-input { height: 24px; padding: 0 8px; border: 1px solid var(--line); border-radius: var(--r-4); background: var(--bg-2); color: var(--fg-0); font: 400 var(--t-12)/1 var(--f-ui); min-width: 0; }
textarea.clb-input { height: auto; min-height: 52px; padding: 6px 8px; line-height: 1.45; resize: vertical; width: 100%; box-sizing: border-box; }
.clb-faint { color: var(--fg-3); font: 400 var(--t-11)/1.35 var(--f-ui); }
.clb-err { color: var(--danger); font: 400 var(--t-12)/1.4 var(--f-ui); }
.clb-ok { color: var(--ok); font: 400 var(--t-12)/1.4 var(--f-ui); }
.clb-tag { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border: 1px solid var(--line); border-radius: var(--r-4); font: 500 var(--t-11)/1 var(--f-ui); color: var(--fg-2); white-space: nowrap; }
.clb-tag.warn { border-color: var(--warn, var(--danger)); color: var(--warn, var(--danger)); }
.clb-tag.good { border-color: var(--ok); color: var(--ok); }
.clb-who { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 3px; border-radius: 11px; background: var(--bg-3); color: var(--fg-1); font: 600 var(--t-11)/1 var(--f-ui); flex: none; }
.clb-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.clb-c { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 2px 8px; }
.clb-c .h { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.clb-c .h b { font-weight: 600; }
.clb-c .t { grid-column: 2; overflow-wrap: anywhere; }
.clb-c .t p { margin: 0; }
.clb-c .t code { font: 400 var(--t-11)/1.3 var(--f-mono); background: var(--bg-3); padding: 0 3px; border-radius: 3px; }
.clb-c .m { color: var(--acc); font-weight: 500; }
.clb-c .a { grid-column: 2; display: flex; gap: 2px; }
.clb-c.reply { margin-left: 30px; }
.clb-c.gone .t { color: var(--fg-3); font-style: italic; }
.clb-link { border: 0; background: transparent; padding: 0; color: var(--acc); font: 500 var(--t-11)/1.2 var(--f-ui); cursor: pointer; }
.clb-pick { display: flex; flex-wrap: wrap; gap: 4px; }
.clb-appr { display: flex; flex-direction: column; gap: 6px; }
.clb-work { display: flex; flex-direction: column; gap: 10px; padding: 10px; min-width: 280px; max-width: 380px; max-height: 60vh; overflow-y: auto; background: var(--bg-1); border: 1px solid var(--line); border-radius: var(--r-6, 6px); box-shadow: 0 8px 24px rgb(0 0 0 / .25); }
.clb-work h4 { margin: 0; font: 600 var(--t-11)/1 var(--f-ui); letter-spacing: .06em; text-transform: uppercase; color: var(--fg-3); }
.clb-work ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.clb-work li button { width: 100%; text-align: start; display: flex; gap: 8px; align-items: baseline; padding: 4px 6px; border: 0; border-radius: var(--r-4); background: transparent; color: var(--fg-1); font: 400 var(--t-12)/1.35 var(--f-ui); cursor: pointer; }
.clb-work li button:hover, .clb-work li button:focus-visible { background: var(--bg-2); outline: none; }
.clb-pop { position: relative; display: inline-flex; }
.clb-pop > .clb-work { position: absolute; top: calc(100% + 4px); inset-inline-end: 0; z-index: 30; }
.clb-sign { display: flex; flex-direction: column; gap: 8px; }
.clb-sign table { border-collapse: collapse; width: 100%; }
.clb-sign th, .clb-sign td { text-align: start; padding: 3px 6px; border-bottom: 1px solid var(--line-soft); font: 400 var(--t-12)/1.35 var(--f-ui); }
.clb-sign th { color: var(--fg-3); font-weight: 500; width: 7em; }
`;

export function CollabStyles() {
  return (
    <style href="aio-collab" precedence="default">
      {css}
    </style>
  );
}
