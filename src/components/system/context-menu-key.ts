import type { KeyboardEvent } from 'react';

/**
 * Open a right-click menu from the keyboard. Shift+F10 or the Menu key on a
 * focused element sends it a `contextmenu` event at its centre, as a
 * right-click would. Macs have no Menu key and their browsers do not map
 * Shift+F10, so without this a right-click menu has no keyboard path there.
 */
export function openContextMenuFromKeyboard(event: KeyboardEvent) {
  const menuKey =
    event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
  if (!menuKey || !(event.target instanceof HTMLElement)) return;
  event.preventDefault();
  const box = event.target.getBoundingClientRect();
  event.target.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    }),
  );
}
