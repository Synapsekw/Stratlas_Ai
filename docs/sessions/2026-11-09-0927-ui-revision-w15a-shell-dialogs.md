---
type: session
date: 2026-11-09-0927
branch: refactor/shell-dialogs
status: complete
related: [docs/plans/2026-10-30-ui-revision.md]
---

# UI revision W15a: shell dialogs and menus on the shared parts

## What changed

- The shell and library dialogs now use the shared `Dialog`: confirm, layer properties, package export, remove and empty trash, unlock, the re-read confirm, cover, delete project, move to folder, the classes delete and the tree remove dialog.
- The project card menu, the folder tile menu and the title bar project switcher now use `Menu` and `MenuAt`: arrow keys, type-ahead, Escape, and focus back on the trigger.
- Review fixes:
  - a right-click menu closes when a scroll moves its card;
  - export hides its close control while it runs;
  - unlock cannot be dismissed while the package is opening;
  - the menu key opens a card's menu under the card.
- `dialogs-a11y.spec.ts` checks the focus trap and Escape for the shell confirm and Delete project. 128 e2e tests across 33 specs pass the CI way.

## Why

Wave 3 of the UI revision puts every dialog and menu on one shared part, so focus, Escape and keyboard behave the same everywhere.

## How to test

1. Projects screen: click the dots on a card. Arrow keys move through the menu, Escape closes it and focus returns to the dots. Right-click the card: the same menu opens at the pointer, and scrolling the list closes it.
2. Pick Delete. Cancel has focus, Tab stays inside the dialog, Escape cancels.
3. Right-click a folder tile, then Rename. The name is selected and Enter saves.
4. Click the project name in the title bar. The switcher lists each project, and the arrow keys work.
5. In a project, delete an antenna or empty the trash. The confirm keeps focus inside it, and Escape cancels.

## Open threads

- The dead `.proj-menu`, `.dmenu` and `.dlg` rules in `styles.css` are left for W18.
- The re-read confirm's test ids are now `reread-confirm-yes` and `reread-confirm-cancel`.

## Next session entry point

W19 rebases onto this, because it shares `a11y.spec.ts` and `dialog.css`. Then W20 and W18 follow.
