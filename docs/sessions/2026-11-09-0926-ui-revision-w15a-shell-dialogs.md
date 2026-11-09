---
type: session
date: 2026-11-09-0926
branch: refactor/shell-dialogs
status: complete
related: [plans/2026-10-30-ui-revision.md]
---

# UI revision W15a: shell dialogs and menus

## What changed

- This PR moves the shell and library dialogs onto the shared `Dialog`: the shell confirm, Layer properties, Package export, removal, empty trash, unlock, re-read confirm, change thumbnail, delete project, move to folder, folder name, rename project and delete class.
- The project card menu (dots and right-click), the folder tile menu and the title bar project switcher now use `Menu` and `MenuAt`, so arrows, type-ahead and Escape work the same as in every other menu.
- New `dialogs-a11y.spec.ts` checks: the shell confirm and Delete project trap focus, Escape cancels.
- Decisions: dialogs keep their old widths; a footer spacer rule lives in `dialog.css`; the re-read buttons are `reread-confirm-yes` and `reread-confirm-cancel`; the dots menu follows its card on scroll, while the pointer menu closes when the card moves; dead CSS is left for W18.

## Why

Wave 3 puts every modal and menu on one set of primitives, so focus, Escape and stacking match.

## How to test

1. On Projects, click a card's dots: arrows move through the menu, Escape closes it and focus goes back to the dots. Right-click a card and the same menu opens at the pointer; scroll the list and it closes.
2. Choose Delete: Cancel has focus, Tab stays inside the dialog, Escape cancels.
3. Right-click a folder tile, then Rename: the name is selected and Enter saves.
4. Click the project name in the title bar: each project shows its customer under it.
5. Open Reports, then Export package: the dialog is wide, and Escape closes it.

## Open threads

- W18 deletes the dead `.proj-menu`, `.dmenu` and `.dlg` rules.

## Next session entry point

W18 token ratchet.
