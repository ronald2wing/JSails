/**
 * Admin resource form rendering: the shared create/edit form (also used for a
 * 422 re-render) for a resource descriptor.
 *
 * `renderFormPage(...)` renders the read-only infolist, the form element
 * (hidden CSRF/back tokens, fields, a submit button), any inline relation
 * manager tables, and the Back link. Every field value and label is emitted as
 * a text child or attribute so Preact owns all escaping.
 *
 * The module is ORM-free and performs no I/O. It is consumed by the route
 * handlers under `../routes/resources/`, never by the `@jsails/admin` public
 * surface.
 */

import { h, type ComponentChild } from 'preact';

import { panelDocumentOptions, renderAdminDocumentWithTheme } from '../document.js';
import { csrfInput, hiddenInput } from '../forms.js';
import type { AdminPanel } from '../panel.js';
import { renderFormattedValue } from './cell-format.js';
import type { ResourceInfolist } from './columns.js';
import type { ResourceField } from './field-types.js';
import {
  fieldChecked,
  fieldValue,
  renderFileInput,
  renderRichTextInput,
  renderScalarInput,
  type FormRenderState,
} from './form-inputs.js';
import { renderRepeater } from './render-repeater.js';
import type { Resource } from './resource-descriptor.js';

/** The shared create/edit form document. */
export function renderFormPage(
  panel: AdminPanel,
  resource: Resource,
  state: FormRenderState,
): string {
  const heading = state.id === null ? `New ${resource.label}` : `Edit ${resource.label}`;
  const body: ComponentChild[] = [h('h1', null, heading)];
  if (resource.infolist !== undefined && state.record !== undefined) {
    body.push(renderInfolist(resource.infolist, state.record));
  }
  body.push(renderForm(resource, state));
  // Render inline relation manager tables below the main form fields.
  // `relationManagerHtml` is produced exclusively by `renderRelationManager`,
  // which server-renders each table through Preact (escaping every cell value
  // in the list renderer). It is therefore the ONLY trusted source for raw
  // HTML injection here — never a caller-supplied string, never a column value.
  if (state.relationManagerHtml !== undefined && state.relationManagerHtml.length > 0) {
    for (const html of state.relationManagerHtml) {
      body.push(
        h('div', {
          class: 'admin-relation-inline',
          dangerouslySetInnerHTML: { __html: html },
        }),
      );
    }
  }
  body.push(
    h(
      'a',
      { href: `${panel.path}/${resource.slug}${state.back === '' ? '' : `?${state.back}`}` },
      'Back to list',
    ),
  );
  return renderAdminDocumentWithTheme(
    panelDocumentOptions(panel, `${panel.title} - ${heading}`),
    ...body,
  );
}

/** Render the form element: hidden CSRF/back tokens, fields, and a submit button. */
function renderForm(resource: Resource, state: FormRenderState): ComponentChild {
  return h(
    'form',
    { method: 'post', action: state.action },
    csrfInput(state.csrf),
    ...(state.back === '' ? [] : [hiddenInput('_back', state.back)]),
    ...resource.fields.map((field) => renderField(field, state)),
    h('button', { type: 'submit' }, 'Save'),
  );
}

/** Render one field: a label, the input, and any validation error. */
function renderField(field: ResourceField, state: FormRenderState): ComponentChild {
  const id = `field-${field.name}`;
  const error = state.errors[field.name];
  return h(
    'div',
    null,
    h('label', { htmlFor: id }, field.label),
    renderFieldInput(field, state, id),
    ...(error === undefined ? [] : [h('p', { role: 'alert' }, error)]),
  );
}

/** Render the input element for a field type. */
function renderFieldInput(
  field: ResourceField,
  state: FormRenderState,
  id: string,
): ComponentChild {
  switch (field.type) {
    case 'repeater':
      return renderRepeater(field, state);
    case 'file':
      return renderFileInput(field, state, id);
    case 'richText':
      return renderRichTextInput(field, state, id);
    default:
      return renderScalarInput(
        field,
        field.name,
        id,
        fieldValue(field, state),
        fieldChecked(field, state),
      );
  }
}

/** Render the read-only detail section shown above the edit form. */
function renderInfolist(
  infolist: ResourceInfolist,
  record: Record<string, unknown>,
): ComponentChild {
  return h(
    'section',
    { class: 'admin-infolist' },
    h('h2', null, infolist.label),
    h(
      'dl',
      null,
      ...infolist.entries.map((entry) =>
        h(
          'div',
          null,
          h('dt', null, entry.label),
          h('dd', null, renderFormattedValue(record[entry.name], entry)),
        ),
      ),
    ),
  );
}
