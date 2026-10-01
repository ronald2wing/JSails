/**
 * The formatting toolbar: a `role="toolbar"` holding the block-type select,
 * the mark, link, list and indent buttons, the insert menu button, and undo
 * and redo.
 *
 * - One tab stop: the toolbar keeps a roving `tabindex`, and Left, Right,
 *   Home and End move focus between its controls (the select keeps Up and
 *   Down for its own options). Alt-F10 in the editor focuses the toolbar and
 *   Escape in the toolbar returns to the editor.
 * - Every toggle carries `aria-pressed`; a control whose command does not
 *   apply at the selection is `aria-disabled` rather than `disabled`, so it
 *   stays reachable, and does nothing.
 * - A button press keeps the editor's selection (mousedown does not take
 *   focus), and focus returns to the editor after a command runs.
 * - Shortcuts are shown in each button's title and stated in
 *   `aria-keyshortcuts`.
 *
 * The toolbar reads the editor state on every update (a plugin view in
 * `rich-text-editor.ts` calls {@link Toolbar.update}).
 */

import { redo, undo } from 'prosemirror-history';
import type { Command, EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import type { InlineMark, ListStyle } from 'jsails/rich-text';

import {
  BLOCK_TYPES,
  activeBlockType,
  activeListStyle,
  canLink,
  activeLinkHref,
  indentCommand,
  isInlineMarkActive,
  outdentCommand,
  setBlockTypeCommand,
  toggleListCommand,
  toggleMarkCommand,
  type BlockTypeValue,
} from './commands.js';

/** The toolbar of one editor. */
export interface Toolbar {
  readonly element: HTMLElement;
  /** Refresh pressed and enabled states from `state`. */
  update(state: EditorState): void;
  /** Move focus to the toolbar's current control. */
  focus(): void;
}

/** What the toolbar asks its editor to do beyond running a command. */
export interface ToolbarActions {
  /** Open the link dialog for the selection. */
  readonly openLinkDialog: () => void;
  /** The insert menu's button, placed in the toolbar's focus order. */
  readonly insertButton: HTMLElement;
}

interface ButtonSpec {
  readonly label: string;
  readonly keys?: string;
  /** The command the button runs, also asked whether it applies. */
  readonly command?: Command;
  readonly run?: () => void;
  readonly enabled?: (state: EditorState) => boolean;
  /** Present for a toggle: whether it is pressed at `state`. */
  readonly pressed?: (state: EditorState) => boolean;
}

/** True on Apple platforms, where Mod is Command. */
function isApple(): boolean {
  return /Mac|iP(hone|[oa]d)/.test(globalThis.navigator?.platform ?? '');
}

/** `Mod-Shift-b` as a title suffix (`Ctrl+Shift+B`) and as `aria-keyshortcuts` (`Control+Shift+B`). */
function describeKeys(keys: string): { readonly title: string; readonly aria: string } {
  const apple = isApple();
  const parts = keys.split('-');
  const title = parts
    .map((part) =>
      part === 'Mod' ? (apple ? 'Cmd' : 'Ctrl') : part.length === 1 ? part.toUpperCase() : part,
    )
    .join('+');
  const aria = parts
    .map((part) =>
      part === 'Mod' ? (apple ? 'Meta' : 'Control') : part.length === 1 ? part.toUpperCase() : part,
    )
    .join('+');
  return { title, aria };
}

const MARK_BUTTONS: readonly { mark: InlineMark; label: string; keys: string }[] = [
  { mark: 'bold', label: 'Bold', keys: 'Mod-b' },
  { mark: 'italic', label: 'Italic', keys: 'Mod-i' },
  { mark: 'strike', label: 'Strikethrough', keys: 'Mod-Shift-s' },
  { mark: 'code', label: 'Inline code', keys: 'Mod-e' },
];

const LIST_BUTTONS: readonly { style: ListStyle; label: string; keys: string }[] = [
  { style: 'unordered', label: 'Bulleted list', keys: 'Mod-Shift-8' },
  { style: 'ordered', label: 'Numbered list', keys: 'Mod-Shift-7' },
  { style: 'task', label: 'Task list', keys: 'Mod-Shift-9' },
];

/** Create the toolbar for `view`, labelled as the formatting controls of `editorId`. */
export function createToolbar(
  view: EditorView,
  editorId: string,
  actions: ToolbarActions,
): Toolbar {
  const element = document.createElement('div');
  element.className = 'rich-text-editor-toolbar';
  element.setAttribute('role', 'toolbar');
  element.setAttribute('aria-label', 'Formatting');
  element.setAttribute('aria-controls', editorId);

  const run = (command: Command): void => {
    command(view.state, view.dispatch, view);
    view.focus();
  };

  const select = document.createElement('select');
  select.className = 'rich-text-editor-block-type';
  select.setAttribute('aria-label', 'Block type');
  const mixed = document.createElement('option');
  mixed.value = '';
  mixed.textContent = 'Mixed';
  mixed.disabled = true;
  mixed.hidden = true;
  select.append(mixed);
  for (const type of BLOCK_TYPES) {
    const option = document.createElement('option');
    option.value = type.value;
    option.textContent = type.label;
    select.append(option);
  }
  select.addEventListener('change', () => {
    if (select.value !== '') {
      run(setBlockTypeCommand(select.value as BlockTypeValue));
    }
    // A conversion that did not apply leaves the state alone, so no plugin
    // update resets the select.
    update(view.state);
  });

  const specs: ButtonSpec[] = [
    ...MARK_BUTTONS.map(({ mark, label, keys }) => ({
      label,
      keys,
      command: toggleMarkCommand(mark),
      pressed: (state: EditorState) => isInlineMarkActive(state, mark),
    })),
    {
      label: 'Link',
      keys: 'Mod-k',
      run: actions.openLinkDialog,
      enabled: canLink,
      pressed: (state: EditorState) => activeLinkHref(state) !== undefined,
    },
    ...LIST_BUTTONS.map(({ style, label, keys }) => ({
      label,
      keys,
      command: toggleListCommand(style),
      pressed: (state: EditorState) => activeListStyle(state) === style,
    })),
    { label: 'Outdent', keys: 'Mod-[', command: outdentCommand },
    { label: 'Indent', keys: 'Mod-]', command: indentCommand },
  ];
  const historySpecs: ButtonSpec[] = [
    { label: 'Undo', keys: 'Mod-z', command: undo },
    { label: 'Redo', keys: 'Mod-Shift-z', command: redo },
  ];

  const buttons = new Map<HTMLButtonElement, ButtonSpec>();
  const makeButton = (spec: ButtonSpec): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = spec.label;
    if (spec.keys !== undefined) {
      const keys = describeKeys(spec.keys);
      button.title = `${spec.label} (${keys.title})`;
      button.setAttribute('aria-keyshortcuts', keys.aria);
    }
    if (spec.pressed !== undefined) {
      button.setAttribute('aria-pressed', 'false');
    }
    // Keep the editor's selection: a press must not move focus off the text.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-disabled') === 'true') {
        return;
      }
      if (spec.run !== undefined) {
        spec.run();
      } else if (spec.command !== undefined) {
        run(spec.command);
      }
    });
    buttons.set(button, spec);
    return button;
  };

  const controls: HTMLElement[] = [
    select,
    ...specs.map(makeButton),
    actions.insertButton,
    ...historySpecs.map(makeButton),
  ];
  let current = 0;
  const setCurrent = (index: number): void => {
    current = index;
    controls.forEach((control, position) => {
      control.tabIndex = position === index ? 0 : -1;
    });
  };
  setCurrent(0);
  element.append(...controls);

  element.addEventListener('focusin', (event) => {
    const index = controls.indexOf(event.target as HTMLElement);
    if (index >= 0) {
      setCurrent(index);
    }
  });
  element.addEventListener('keydown', (event) => {
    const count = controls.length;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (current + 1) % count;
        break;
      case 'ArrowLeft':
        next = (current - 1 + count) % count;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      case 'Escape':
        event.preventDefault();
        view.focus();
        return;
      default:
        return;
    }
    event.preventDefault();
    setCurrent(next);
    controls[next]?.focus();
  });

  function update(state: EditorState): void {
    const block = activeBlockType(state);
    select.value = block ?? '';
    // Never `disabled`, which would drop the select out of the roving focus;
    // a change that does not apply leaves the document as it is.
    if (BLOCK_TYPES.some((type) => setBlockTypeCommand(type.value)(state))) {
      select.removeAttribute('aria-disabled');
    } else {
      select.setAttribute('aria-disabled', 'true');
    }
    for (const [button, spec] of buttons) {
      const enabled =
        spec.enabled?.(state) ?? (spec.command === undefined ? true : spec.command(state));
      if (enabled) {
        button.removeAttribute('aria-disabled');
      } else {
        button.setAttribute('aria-disabled', 'true');
      }
      if (spec.pressed !== undefined) {
        button.setAttribute('aria-pressed', spec.pressed(state) ? 'true' : 'false');
      }
    }
  }

  return {
    element,
    update,
    focus() {
      controls[current]?.focus();
    },
  };
}
