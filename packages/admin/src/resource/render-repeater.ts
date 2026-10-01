/**
 * Admin repeater rendering: the bounded list of item rows behind a `repeater`
 * field, in either of its two shapes — a plain repeater (scalar item fields) or
 * a formset (full sub-fields, including file uploads).
 *
 * Item inputs are named `<field>[<index>].<item>` so the CRUD handler can lift
 * them back into an array (`liftRepeaters`), and the Add/Remove buttons submit
 * `_repeater_add` / `_repeater_remove` intents that re-render the form without
 * saving (`repeater-intent.ts`). The module is ORM-free and performs no I/O.
 */

import { h, type ComponentChild } from 'preact';
import { isRecord } from 'jsails/plugin-sdk';

import { DEFAULT_MAX_REPEATER_ITEMS, type ResourceField } from './field-types.js';
import {
  inputValue,
  isCheckedValue,
  renderFileInput,
  renderScalarInput,
  type FormRenderState,
  type ScalarInputField,
} from './form-inputs.js';
import { rawRepeaterItemCount, repeaterItemKey } from './repeater-keys.js';

/** An item field of either repeater shape. */
type RepeaterItemField = ScalarInputField & { readonly name: string; readonly label: string };

/** Render a repeater or formset: one row per item plus an Add button under the bound. */
export function renderRepeater(field: ResourceField, state: FormRenderState): ComponentChild {
  const config = field.formset ?? field.repeater!;
  const itemFields: readonly RepeaterItemField[] = config.fields;
  const maxItems = config.maxItems ?? DEFAULT_MAX_REPEATER_ITEMS;
  const count = repeaterItemCount(field.name, maxItems, state);
  const items: ComponentChild[] = [];
  for (let index = 0; index < count; index += 1) {
    items.push(renderRepeaterItem(field.name, itemFields, index, state));
  }
  const children: ComponentChild[] = [h('fieldset', null, ...items)];
  if (count < maxItems) {
    children.push(
      h(
        'button',
        { type: 'submit', name: '_repeater_add', value: field.name },
        field.formset === undefined ? 'Add item' : 'Add row',
      ),
    );
  }
  return h('div', { class: 'admin-repeater' }, ...children);
}

/** Render one item row: each item field (label, input, error) plus a Remove button. */
function renderRepeaterItem(
  fieldName: string,
  itemFields: readonly RepeaterItemField[],
  index: number,
  state: FormRenderState,
): ComponentChild {
  const children: ComponentChild[] = itemFields.map((itemField) => {
    const name = repeaterItemKey(fieldName, index, itemField.name);
    const id = `field-${name}`;
    const error = state.errors[`${fieldName}.${index}.${itemField.name}`];
    return h(
      'div',
      null,
      h('label', { htmlFor: id }, itemField.label),
      renderItemInput(fieldName, itemField, index, state, name, id),
      ...(error === undefined ? [] : [h('p', { role: 'alert' }, error)]),
    );
  });
  children.push(
    h(
      'button',
      { type: 'submit', name: '_repeater_remove', value: `${fieldName}.${index}` },
      'Remove',
    ),
  );
  return h('div', { class: 'admin-repeater-item' }, ...children);
}

/** Render one item input; only formset sub-fields can be file uploads. */
function renderItemInput(
  fieldName: string,
  itemField: RepeaterItemField,
  index: number,
  state: FormRenderState,
  name: string,
  id: string,
): ComponentChild {
  if (isFileField(itemField)) {
    // The flat item name lets the upload handler map the part back to its row.
    return renderFileInput({ ...itemField, name }, state, id);
  }
  return renderScalarInput(
    itemField,
    name,
    id,
    inputValue(repeaterItemRaw(fieldName, itemField.name, index, state)),
    repeaterItemChecked(fieldName, itemField.name, index, state),
  );
}

/** A formset sub-field of type `file` (a plain repeater item type never is). */
function isFileField(itemField: RepeaterItemField): itemField is ResourceField {
  return itemField.type === 'file';
}

/** Count the rendered items from submitted values, then the record (at least one). */
function repeaterItemCount(fieldName: string, maxItems: number, state: FormRenderState): number {
  const submitted = rawRepeaterItemCount(fieldName, state.values);
  if (submitted > 0) {
    return Math.min(submitted, maxItems);
  }
  const stored = state.record?.[fieldName];
  if (Array.isArray(stored)) {
    return Math.min(Math.max(stored.length, 1), maxItems);
  }
  return 1;
}

/** The raw submitted/record value for one item field, preferring submitted data. */
function repeaterItemRaw(
  fieldName: string,
  itemName: string,
  index: number,
  state: FormRenderState,
): unknown {
  const name = repeaterItemKey(fieldName, index, itemName);
  if (Object.hasOwn(state.values, name)) {
    return state.values[name];
  }
  const items = state.record?.[fieldName];
  if (Array.isArray(items)) {
    const item: unknown = items[index];
    if (isRecord(item)) {
      return item[itemName];
    }
  }
  return undefined;
}

/** Resolve an item field's checkbox checked state, preferring submitted data. */
function repeaterItemChecked(
  fieldName: string,
  itemName: string,
  index: number,
  state: FormRenderState,
): boolean {
  const name = repeaterItemKey(fieldName, index, itemName);
  if (Object.hasOwn(state.values, name)) {
    return isCheckedValue(state.values[name]);
  }
  return repeaterItemRaw(fieldName, itemName, index, state) === true;
}
