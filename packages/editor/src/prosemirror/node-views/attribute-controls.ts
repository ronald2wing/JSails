/**
 * Form controls bound to one attribute of one node, for the node views of
 * blocks whose values are not text the author types in place (an image's
 * media id and alt text, an embed's URL, a callout's tone).
 *
 * A control commits on `change` (blur, Enter, or a select's choice): the
 * value is checked with the schema's own attribute rule (`acceptsAttribute`)
 * and, when accepted, written with one `setNodeAttribute` transaction; a
 * refused value marks the control `aria-invalid`, shows the field's message
 * (tied by `aria-describedby`), and never reaches the state, whose attribute
 * validation would otherwise throw. Enter commits rather than submitting the
 * app's form around the editor. Controls carry no `name`, so they are never
 * part of a form submission.
 */

import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';

import { acceptsAttribute } from '../schema.js';

/** How a control reads and writes its attribute. */
export interface AttributeControlSpec {
  /** The attribute name. */
  readonly attribute: string;
  readonly label: string;
  /** The message shown for a value the model refuses. */
  readonly invalidMessage: string;
  /** `text` (default), `lines` (a textarea, one list entry per line) or `select`. */
  readonly kind?: 'text' | 'lines' | 'select';
  /** The options of a `select`, as value and label. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
}

/** A rendered control and how to refresh it from a node. */
export interface AttributeControl {
  readonly element: HTMLElement;
  /** The input, textarea or select itself. */
  readonly control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  /** Show `node`'s value, unless the author is editing this control. */
  refresh(node: ProseMirrorNode): void;
}

let controlCount = 0;

function displayValue(spec: AttributeControlSpec, value: unknown): string {
  if (spec.kind === 'lines') {
    return Array.isArray(value) ? value.join('\n') : '';
  }
  return typeof value === 'string' ? value : '';
}

function attributeValue(spec: AttributeControlSpec, text: string): unknown {
  if (spec.kind === 'lines') {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }
  return spec.kind === 'select' ? text : text.trim();
}

/**
 * A labelled control for `spec.attribute` of the node at `getPos()` in
 * `view`, owned by node type `owner`.
 */
export function createAttributeControl(
  view: EditorView,
  owner: string,
  getPos: () => number | undefined,
  node: ProseMirrorNode,
  spec: AttributeControlSpec,
): AttributeControl {
  controlCount += 1;
  const id = `rich-text-attribute-${String(controlCount)}`;
  const element = document.createElement('div');
  element.className = 'rich-text-editor-attribute';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = spec.label;
  let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (spec.kind === 'select') {
    const select = document.createElement('select');
    for (const option of spec.options ?? []) {
      const entry = document.createElement('option');
      entry.value = option.value;
      entry.textContent = option.label;
      select.append(entry);
    }
    control = select;
  } else if (spec.kind === 'lines') {
    control = document.createElement('textarea');
  } else {
    control = Object.assign(document.createElement('input'), { type: 'text' });
  }
  control.id = id;
  control.setAttribute('aria-describedby', `${id}-error`);
  control.value = displayValue(spec, node.attrs[spec.attribute]);
  const error = document.createElement('p');
  error.id = `${id}-error`;
  error.className = 'rich-text-editor-attribute-error';

  const commit = (): void => {
    const pos = getPos();
    if (pos === undefined) {
      return;
    }
    const value = attributeValue(spec, control.value);
    if (!acceptsAttribute(owner, spec.attribute, value)) {
      control.setAttribute('aria-invalid', 'true');
      error.textContent = spec.invalidMessage;
      return;
    }
    control.removeAttribute('aria-invalid');
    error.textContent = '';
    const current = view.state.doc.nodeAt(pos);
    if (
      current !== null &&
      JSON.stringify(current.attrs[spec.attribute]) !== JSON.stringify(value)
    ) {
      view.dispatch(view.state.tr.setNodeAttribute(pos, spec.attribute, value));
    }
  };
  control.addEventListener('change', commit);
  control.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter' && spec.kind !== 'lines') {
      event.preventDefault();
      commit();
    }
  });
  element.append(label, control, error);

  return {
    element,
    control,
    refresh(next) {
      if (control.ownerDocument.activeElement !== control) {
        control.value = displayValue(spec, next.attrs[spec.attribute]);
        control.removeAttribute('aria-invalid');
        error.textContent = '';
      }
    },
  };
}
