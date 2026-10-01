/**
 * The "Insert" menu: a menu button in the toolbar (`aria-haspopup="menu"`,
 * `aria-expanded`) and its `role="menu"` of block insertions (divider, image,
 * gallery, embed, call to action).
 *
 * Opening the menu (click, Enter, Space, ArrowDown or ArrowUp) moves focus to
 * its first (or, for ArrowUp, last) item; ArrowUp and ArrowDown cycle the
 * items, Home and End jump, Escape closes and returns focus to the button,
 * and Tab or a click elsewhere closes it. Every block can always be
 * inserted (after the block holding the selection), so no item is ever
 * disabled. Arrow keys inside the menu stop at the menu, so the toolbar's
 * roving focus does not take them.
 */

/** One item of the menu. */
export interface BlockMenuItem {
  readonly label: string;
  readonly run: () => void;
}

/** The menu button and its menu. */
export interface BlockMenu {
  readonly button: HTMLButtonElement;
  readonly menu: HTMLElement;
  close(): void;
  destroy(): void;
}

let menuCount = 0;

/** Create the insert menu over `items`. */
export function createBlockMenu(items: readonly BlockMenuItem[]): BlockMenu {
  menuCount += 1;
  const id = `rich-text-insert-menu-${String(menuCount)}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = `${id}-button`;
  button.textContent = 'Insert';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', id);

  const menu = document.createElement('div');
  menu.id = id;
  menu.className = 'rich-text-editor-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-labelledby', button.id);
  menu.hidden = true;

  const entries = items.map((item) => {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.tabIndex = -1;
    entry.setAttribute('role', 'menuitem');
    entry.textContent = item.label;
    entry.addEventListener('click', () => {
      close(false);
      item.run();
    });
    menu.append(entry);
    return entry;
  });

  const focusEntry = (index: number): void => {
    const count = entries.length;
    entries[((index % count) + count) % count]?.focus();
  };

  const open = (first: boolean): void => {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    focusEntry(first ? 0 : entries.length - 1);
  };

  function close(restoreFocus: boolean): void {
    if (menu.hidden) {
      return;
    }
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) {
      button.focus();
    }
  }

  button.addEventListener('click', () => {
    if (menu.hidden) {
      open(true);
    } else {
      close(true);
    }
  });
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      open(event.key === 'ArrowDown');
    }
  });
  menu.addEventListener('keydown', (event) => {
    const index = entries.indexOf(event.target as HTMLButtonElement);
    switch (event.key) {
      case 'ArrowDown':
        focusEntry(index + 1);
        break;
      case 'ArrowUp':
        focusEntry(index - 1);
        break;
      case 'Home':
        focusEntry(0);
        break;
      case 'End':
        focusEntry(entries.length - 1);
        break;
      case 'Escape':
        close(true);
        break;
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  });
  const onOutside = (event: Event): void => {
    const target = event.target as Node | null;
    if (target !== null && !menu.contains(target) && !button.contains(target)) {
      close(false);
    }
  };
  document.addEventListener('mousedown', onOutside);

  return {
    button,
    menu,
    close: () => {
      close(false);
    },
    destroy() {
      document.removeEventListener('mousedown', onOutside);
    },
  };
}
