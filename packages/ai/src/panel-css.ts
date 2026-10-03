/** AgentPanel styles on the Mission tokens (packages/ui tokens.css). Hoisted once by React. */
export const PANEL_CSS = `
.aio-agent { display: flex; flex-direction: column; min-height: 0; height: 100%; background: var(--bg-1); color: var(--fg-1); font: 400 var(--t-13)/1.5 var(--f-ui); }
.aio-agent .ag-h { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 8px 0 12px; border-bottom: 1px solid var(--line-soft); flex: none; }
.aio-agent .ag-h h3 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: var(--t-13); font-weight: 600; color: var(--fg-0); }
.aio-agent .ag-bind { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 6px; border-radius: 3px; background: var(--bg-2); border: 1px solid var(--line); font-size: var(--t-11); color: var(--fg-1); min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.aio-agent .ag-h .acts { margin-left: auto; display: flex; gap: 2px; }
.aio-agent .ag-log { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; scrollbar-width: thin; }
.aio-agent .ag-msg { white-space: pre-wrap; overflow-wrap: anywhere; }
.aio-agent .ag-msg.user { align-self: flex-end; max-width: 88%; background: var(--bg-3); color: var(--fg-0); padding: 8px 10px; border-radius: 8px 8px 2px 8px; }
.aio-agent .ag-ctx { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.aio-agent .ag-tag { display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 6px; border-radius: 3px; border: 1px solid var(--line); font: 400 var(--t-11)/1 var(--f-mono); color: var(--fg-2); white-space: nowrap; }
.aio-agent .ag-who { display: flex; align-items: center; gap: 6px; font-size: var(--t-11); color: var(--fg-3); margin-bottom: 4px; }
.aio-agent .ag-who b { color: var(--fg-1); font-weight: 500; }
.aio-agent .ag-err { color: var(--danger); font-size: var(--t-12); }
.aio-agent .ag-stopped { color: var(--fg-3); font-size: var(--t-12); }
.aio-agent .steps { border: 1px solid var(--line-soft); border-radius: var(--r-4); margin: 6px 0; overflow: hidden; white-space: normal; }
.aio-agent .step { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 6px 8px; font-size: var(--t-12); }
.aio-agent .step + .step, .aio-agent .approve + .step { border-top: 1px solid var(--line-soft); }
.aio-agent .step .si { width: 16px; height: 16px; display: grid; place-items: center; color: var(--fg-3); }
.aio-agent .step.done .si { color: var(--acc); }
.aio-agent .step.awaiting .si { color: var(--s3); }
.aio-agent .step.error .si, .aio-agent .step.rejected .si { color: var(--danger); }
.aio-agent .step.awaiting, .aio-agent .approve { background: oklch(0.84 0.14 92 / 0.06); }
.aio-agent .step code { font: 400 11.5px/1.3 var(--f-mono); color: var(--fg-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.aio-agent .step.undone code, .aio-agent .step.cancelled code, .aio-agent .step.rejected code { color: var(--fg-3); text-decoration: line-through; }
.aio-agent .step .sr { font: 400 var(--t-11)/1 var(--f-mono); color: var(--fg-3); white-space: nowrap; display: flex; align-items: center; gap: 6px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.aio-agent .approve { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--line-soft); align-items: center; }
.aio-agent .approve .note { font-size: var(--t-11); color: var(--fg-2); margin-right: auto; }
.aio-agent .ag-btn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: var(--r-4); border: 1px solid var(--line); background: var(--bg-2); color: var(--fg-1); font: 500 var(--t-12)/1 var(--f-ui); cursor: pointer; transition: background 120ms var(--ease), border-color 120ms var(--ease); }
.aio-agent .ag-btn:hover { background: var(--bg-3); border-color: var(--line-strong); }
.aio-agent .ag-btn:focus-visible, .aio-agent .ag-sug:focus-visible { outline: 2px solid var(--acc); outline-offset: 1px; }
.aio-agent .ag-btn.primary { background: var(--acc); border-color: var(--acc); color: var(--acc-ink); }
.aio-agent .ag-btn.primary:hover { background: var(--acc-strong); }
.aio-agent .ag-btn.ghost { background: none; border-color: transparent; color: var(--fg-2); }
.aio-agent .ag-btn.ghost:hover { background: var(--bg-2); color: var(--fg-0); }
.aio-agent .ag-btn.ghost[aria-pressed='true'] { color: var(--acc); background: var(--acc-a12); }
.aio-agent .ag-btn.icon { width: 24px; padding: 0; justify-content: center; }
.aio-agent .ag-btn:disabled { opacity: 0.45; cursor: default; }
.aio-agent .ag-btn.sm { height: 22px; font-size: var(--t-11); }
.aio-agent .ag-empty { margin: auto 0; display: grid; gap: 10px; }
.aio-agent .ag-empty p { margin: 0; color: var(--fg-2); font-size: var(--t-12); }
.aio-agent .ag-sug { text-align: left; padding: 8px 10px; border: 1px solid var(--line-soft); border-radius: var(--r-4); background: none; color: var(--fg-1); font: 400 var(--t-12)/1.4 var(--f-ui); cursor: pointer; }
.aio-agent .ag-sug:hover { background: var(--bg-2); border-color: var(--line); color: var(--fg-0); }
.aio-agent .ag-off { margin: auto 0; border: 1px solid var(--line-soft); border-radius: var(--r-4); padding: 12px; display: grid; gap: 8px; }
.aio-agent .ag-off b { color: var(--fg-0); font-weight: 600; }
.aio-agent .ag-off p { margin: 0; font-size: var(--t-12); color: var(--fg-2); }
.aio-agent .ag-off ol { margin: 0; padding-left: 18px; font-size: var(--t-12); color: var(--fg-2); }
.aio-agent .ag-in { border-top: 1px solid var(--line-soft); padding: 8px 10px 10px; display: grid; gap: 6px; flex: none; }
.aio-agent .ag-box { border: 1px solid var(--line); border-radius: var(--r-4); background: var(--bg-0); padding: 8px 8px 6px 10px; display: grid; gap: 6px; }
.aio-agent .ag-box:focus-within { border-color: var(--acc); }
.aio-agent .ag-box textarea { border: 0; background: none; resize: none; outline: none; height: 36px; font: 400 var(--t-13)/1.4 var(--f-ui); color: var(--fg-0); padding: 0; }
.aio-agent .ag-box textarea::placeholder { color: var(--fg-3); }
.aio-agent .ag-row { display: flex; align-items: center; gap: 6px; font-size: var(--t-11); color: var(--fg-3); min-width: 0; }
.aio-agent .ag-row .sp { flex: 1; }
.aio-agent .ag-mono { font-family: var(--f-mono); font-variant-numeric: tabular-nums; }
.aio-agent .typing { display: inline-flex; gap: 3px; padding: 4px 0; }
.aio-agent .typing i { width: 4px; height: 4px; border-radius: 50%; background: var(--fg-3); animation: aio-agent-blink 1.2s infinite; }
.aio-agent .typing i:nth-child(2) { animation-delay: 0.2s; }
.aio-agent .typing i:nth-child(3) { animation-delay: 0.4s; }
@keyframes aio-agent-blink { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .aio-agent .typing i { animation: none; } }
`;
