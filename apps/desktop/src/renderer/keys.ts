/** True when a key press belongs to a text field, an editable element or an open dialog. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.closest('[role="dialog"]') !== null
  );
}

/**
 * Space plays and pauses unless it activates a control that needs it: a text field, a tree row,
 * an option, a checkbox or radio, a menu item, a tab or anything inside a dialog. On an ordinary
 * button (a stage tool just clicked) Space still plays, as in every video editor.
 */
export function spaceIsPlayPause(target: EventTarget | null): boolean {
  if (isTyping(target)) return false;
  if (!(target instanceof HTMLElement)) return true;
  const role = target.getAttribute('role');
  if (
    role &&
    ['treeitem', 'option', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'slider'].includes(
      role,
    )
  )
    return false;
  return !(target instanceof HTMLInputElement);
}
