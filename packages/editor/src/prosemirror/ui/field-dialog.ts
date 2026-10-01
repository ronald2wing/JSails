/**
 * The editor's one dialog: a small inline form of labelled fields, used for
 * the link dialog and for the values an inserted block needs (an image's
 * media id, an embed's URL, a call to action's label and link).
 *
 * It is a non-modal `role="dialog"` placed under the toolbar rather than a
 * `<form>`: the editor usually sits inside the app's own form, and a nested
 * form would submit the wrong form. For the same reason its inputs have no
 * `name` (they are never part of the app's submission) and Enter in a
 * single-line field applies the dialog instead of submitting the app's form.
 *
 * Each field states its own check, which the caller builds from the model's
 * rules (`isLinkHref`, the schema's attribute rules), so a value the document
 * would refuse is reported next to its field, tied by `aria-describedby`,
 * and never applied. Escape or Cancel closes without applying; either way
 * `onClose` runs, which returns focus to the editor.
 */

import { createMediaPicker } from './media-picker.js';

/** One field of the dialog. */
export interface DialogField {
  /** The key of the field's value in the applied values. */
  readonly key: string;
  readonly label: string;
  /** The initial value; empty when absent. */
  readonly value?: string;
  /** A textarea (one entry per line) instead of a single-line input. */
  readonly multiline?: boolean;
  /** The message for a refused value, or `undefined` when the value is accepted. */
  readonly check: (value: string) => string | undefined;
}

/** A button beside Apply and Cancel (the link dialog's Remove). */
export interface DialogAction {
  readonly label: string;
  readonly run: () => void;
}

/** The media picker a dialog field takes its value from. */
export interface DialogPicker {
  readonly url: string;
  /** The field the chosen id goes to. */
  readonly field: string;
  /** `replace` sets the field to the id; `append` adds it as a new line. */
  readonly mode: 'replace' | 'append';
}

/** What {@link FieldDialog.open} shows. */
export interface DialogOptions {
  readonly title: string;
  readonly fields: readonly DialogField[];
  readonly applyLabel: string;
  /** Called with every field's value once all of them pass their checks. */
  readonly onApply: (values: Readonly<Record<string, string>>) => void;
  readonly actions?: readonly DialogAction[];
  readonly picker?: DialogPicker;
}

/** The dialog of one editor. */
export interface FieldDialog {
  readonly element: HTMLElement;
  /** Show `options`, replacing whatever the dialog showed, and focus its first field. */
  open(options: DialogOptions): void;
  /** Close without applying. */
  close(): void;
  isOpen(): boolean;
}

let dialogCount = 0;

/** Create the dialog of one editor; `onClose` runs after every close. */
export function createFieldDialog(onClose: () => void): FieldDialog {
  dialogCount += 1;
  const id = `rich-text-dialog-${String(dialogCount)}`;
  const element = document.createElement('div');
  element.className = 'rich-text-editor-dialog';
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'false');
  element.setAttribute('aria-labelledby', `${id}-title`);
  element.hidden = true;

  const close = (): void => {
    if (element.hidden) {
      return;
    }
    element.hidden = true;
    element.replaceChildren();
    onClose();
  };

  const open = (options: DialogOptions): void => {
    const title = document.createElement('p');
    title.id = `${id}-title`;
    title.className = 'rich-text-editor-dialog-title';
    title.textContent = options.title;

    const controls = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
    const singleLine = new Set<EventTarget>();
    const errors = new Map<string, HTMLElement>();
    const rows = options.fields.map((field, index) => {
      const inputId = `${id}-field-${String(index)}`;
      const row = document.createElement('div');
      row.className = 'rich-text-editor-dialog-field';
      const label = document.createElement('label');
      label.htmlFor = inputId;
      label.textContent = field.label;
      const control =
        field.multiline === true
          ? document.createElement('textarea')
          : Object.assign(document.createElement('input'), { type: 'text' });
      control.id = inputId;
      control.value = field.value ?? '';
      if (field.multiline !== true) {
        singleLine.add(control);
      }
      control.setAttribute('aria-describedby', `${inputId}-error`);
      const error = document.createElement('p');
      error.id = `${inputId}-error`;
      error.className = 'rich-text-editor-dialog-error';
      controls.set(field.key, control);
      errors.set(field.key, error);
      row.append(label, control, error);
      return row;
    });

    const apply = (): void => {
      const values: Record<string, string> = {};
      let firstInvalid: HTMLElement | undefined;
      for (const field of options.fields) {
        const control = controls.get(field.key);
        const error = errors.get(field.key);
        if (control === undefined || error === undefined) {
          continue;
        }
        const value = control.value.trim();
        const message = field.check(value);
        error.textContent = message ?? '';
        if (message === undefined) {
          control.removeAttribute('aria-invalid');
          values[field.key] = value;
        } else {
          control.setAttribute('aria-invalid', 'true');
          firstInvalid ??= control;
        }
      }
      if (firstInvalid !== undefined) {
        firstInvalid.focus();
        return;
      }
      element.hidden = true;
      element.replaceChildren();
      options.onApply(values);
      onClose();
    };

    const buttons = document.createElement('div');
    buttons.className = 'rich-text-editor-dialog-actions';
    const button = (text: string, run: () => void): HTMLButtonElement => {
      const node = document.createElement('button');
      node.type = 'button';
      node.textContent = text;
      node.addEventListener('click', run);
      return node;
    };
    buttons.append(button(options.applyLabel, apply));
    for (const action of options.actions ?? []) {
      buttons.append(
        button(action.label, () => {
          element.hidden = true;
          element.replaceChildren();
          action.run();
          onClose();
        }),
      );
    }
    buttons.append(button('Cancel', close));

    const parts: HTMLElement[] = [title, ...rows];
    const picker = options.picker;
    const target = picker === undefined ? undefined : controls.get(picker.field);
    if (picker !== undefined && target !== undefined) {
      parts.push(
        createMediaPicker({
          url: picker.url,
          onSelect: (item) => {
            const current = target.value.trim();
            target.value =
              picker.mode === 'append' && current !== '' ? `${current}\n${item.id}` : item.id;
            target.focus();
          },
        }),
      );
    }
    parts.push(buttons);
    element.replaceChildren(...parts);
    element.hidden = false;
    element.onkeydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      // Only the dialog's own single-line fields apply on Enter. The decision
      // is by identity, never by the target's ancestors: the dialog sits in
      // the app's markup, and the picker's search box handles its own Enter.
      if (event.key === 'Enter' && event.target !== null && singleLine.has(event.target)) {
        event.preventDefault();
        apply();
      }
    };
    controls.values().next().value?.focus();
  };

  return { element, open, close, isOpen: () => !element.hidden };
}
