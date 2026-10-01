/**
 * Admin resource list rendering: the paginated, sortable, filterable,
 * searchable list table for a resource descriptor.
 *
 * `renderListPage(...)` renders the search/filter form, the table (with its
 * optional bulk-selection wrapper), and the pager. Every dynamic value — cell
 * text, filter labels, headers — is emitted as a text child or attribute so
 * Preact owns all escaping; `colors` values are author-supplied (trusted)
 * styling hooks. Cell formatting is shared with the form module via
 * `cell-format.ts`.
 *
 * The module is ORM-free and performs no I/O. It is consumed by the route
 * handlers under `../routes/resources/`, never by the `@jsails/admin` public
 * surface.
 */

import { h, type ComponentChild } from 'preact';
import { DEFAULT_PAGE_SIZE } from 'jsails/api';

import type { AdminAction } from '../actions.js';
import { panelDocumentOptions, renderAdminDocumentWithTheme } from '../document.js';
import { hiddenInput } from '../forms.js';
import { buildListQuery, type ListState } from '../list-query.js';
import { renderNotice } from '../notices.js';
import type { AdminPanel } from '../panel.js';
import { recordId } from './access.js';
import { renderFormattedValue } from './cell-format.js';
import type { ResourceColumn } from './columns.js';
import type { Resource } from './resource-descriptor.js';

/** Render the paginated, sortable, filterable, searchable list table. */
export async function renderListPage(
  panel: AdminPanel,
  resource: Resource,
  result: {
    readonly rows: readonly Record<string, unknown>[];
    readonly total: number;
  },
  state: ListState,
  notice: string | undefined,
): Promise<string> {
  const root = `${panel.path}/${resource.slug}`;
  const totalPages = result.total === 0 ? 0 : Math.ceil(result.total / state.pageSize);
  const heading = h('h1', null, resource.label);
  const headerActions = resource.actions?.header ?? [];
  const rowActions = resource.actions?.row ?? [];
  const bulkActions = resource.actions?.bulk ?? [];

  const body: ComponentChild[] = [heading];
  if (notice !== undefined) {
    body.push(renderNotice(notice));
  }
  if (resource.save !== undefined) {
    body.push(h('a', { href: `${root}/new${buildListQuery(state)}` }, `New ${resource.label}`));
  }
  for (const action of headerActions) {
    body.push(
      h('a', { href: `${root}/actions/${action.name}${buildListQuery(state)}` }, action.label),
    );
  }
  body.push(renderFiltersForm(resource, state));
  body.push(await renderTable(resource, result.rows, rowActions, bulkActions, state, root));

  if (result.rows.length === 0) {
    body.push(h('p', null, 'No records.'));
  }

  body.push(
    h(
      'p',
      null,
      h('span', null, `Page ${state.page} of ${Math.max(totalPages, 1)} (${result.total} total)`),
      ...(state.page > 1
        ? [
            ' ',
            h(
              'a',
              { href: `${root}${buildListQuery({ ...state, page: state.page - 1 })}` },
              'Previous',
            ),
          ]
        : []),
      ...(state.page < totalPages
        ? [
            ' ',
            h(
              'a',
              { href: `${root}${buildListQuery({ ...state, page: state.page + 1 })}` },
              'Next',
            ),
          ]
        : []),
    ),
  );
  body.push(h('a', { href: panel.path }, 'Back to dashboard'));

  return renderAdminDocumentWithTheme(
    panelDocumentOptions(panel, `${panel.title} - ${resource.label}`),
    ...body,
  );
}

/** Render the search + select-filter form (a GET that resets the page). */
function renderFiltersForm(resource: Resource, state: ListState): ComponentChild {
  const filterable = resource.columns.filter((column) => column.filter !== undefined);
  const hasSearchable = resource.columns.some((column) => column.searchable === true);
  if (!hasSearchable && filterable.length === 0) return null;

  const children: ComponentChild[] = [];
  if (hasSearchable) {
    children.push(
      h('input', {
        type: 'text',
        name: 'search',
        value: state.search ?? '',
        placeholder: 'Search',
      }),
    );
  }
  for (const column of filterable) {
    const selected = state.filters[column.name] ?? '';
    children.push(
      h(
        'select',
        { name: `f_${column.name}` },
        h('option', { value: '' }, column.label),
        ...(column.filter ?? []).map((option) =>
          h(
            'option',
            { value: option.value, ...(option.value === selected ? { selected: true } : {}) },
            option.label,
          ),
        ),
      ),
    );
  }
  // Preserve sort/direction across a filter change.
  if (state.sort !== undefined) {
    children.push(hiddenInput('sort', state.sort));
    children.push(hiddenInput('direction', state.direction));
  }
  children.push(h('button', { type: 'submit' }, 'Apply'));
  return h('form', { method: 'get', action: '' }, ...children);
}

/** Render the table, wrapped in a bulk-selection form when bulk actions exist. */
async function renderTable(
  resource: Resource,
  rows: readonly Record<string, unknown>[],
  rowActions: readonly AdminAction[],
  bulkActions: readonly AdminAction[],
  state: ListState,
  root: string,
): Promise<ComponentChild> {
  const hasActionsColumn = resource.get !== undefined || rowActions.length > 0;
  const hasBulkColumn = bulkActions.length > 0;

  const headerCells: ComponentChild[] = [];
  if (hasBulkColumn) {
    headerCells.push(h('th', null, 'Select'));
  }
  for (const column of resource.columns) {
    headerCells.push(renderColumnHeader(column, state, root));
  }
  if (hasActionsColumn) {
    headerCells.push(h('th', null, 'Actions'));
  }

  // Relation columns resolve labels through user code (typically one query
  // each), so every cell on the page is resolved concurrently rather than one
  // row at a time; the row order of the rendered table is unchanged.
  const valueCells = await Promise.all(
    rows.map((row) => Promise.all(resource.columns.map((column) => renderCellValue(column, row)))),
  );
  const bodyRows: ComponentChild[] = [];
  rows.forEach((row, index) => {
    const id = recordId(row);
    const cells: ComponentChild[] = [];
    if (hasBulkColumn) {
      cells.push(
        h(
          'td',
          null,
          id === undefined ? '' : h('input', { type: 'checkbox', name: 'ids', value: id }),
        ),
      );
    }
    for (const value of valueCells[index] ?? []) {
      cells.push(h('td', null, value));
    }
    if (hasActionsColumn) {
      cells.push(h('td', null, renderRowActions(resource, id, rowActions, state, root)));
    }
    bodyRows.push(h('tr', null, ...cells));
  });

  const table = h(
    'table',
    null,
    h('thead', null, h('tr', null, ...headerCells)),
    h('tbody', null, ...bodyRows),
  );

  if (!hasBulkColumn) return table;

  const bulkButtons = bulkActions.map((action) =>
    h(
      'button',
      { type: 'submit', formaction: `${root}/actions/${action.name}`, name: action.name },
      action.label,
    ),
  );
  return h('form', { method: 'get', action: root }, ...stateHiddens(state), ...bulkButtons, table);
}

/** Hidden inputs carrying the full list state through a bulk-selection form. */
function stateHiddens(state: ListState): ComponentChild[] {
  const inputs: ComponentChild[] = [];
  if (state.page !== 1) inputs.push(hiddenInput('page', String(state.page)));
  if (state.pageSize !== DEFAULT_PAGE_SIZE) {
    inputs.push(hiddenInput('pageSize', String(state.pageSize)));
  }
  if (state.sort !== undefined) inputs.push(hiddenInput('sort', state.sort));
  if (state.sort !== undefined && state.direction !== 'asc') {
    inputs.push(hiddenInput('direction', state.direction));
  }
  if (state.search !== undefined) inputs.push(hiddenInput('search', state.search));
  for (const [name, value] of Object.entries(state.filters)) {
    inputs.push(hiddenInput(`f_${name}`, value));
  }
  return inputs;
}

/** Render a column header: a sort link when sortable, a plain label otherwise. */
function renderColumnHeader(
  column: ResourceColumn,
  state: ListState,
  root: string,
): ComponentChild {
  if (column.sortable !== true) {
    return h('th', null, column.label);
  }
  const isSorted = state.sort === column.name;
  const nextDirection: 'asc' | 'desc' = isSorted && state.direction === 'asc' ? 'desc' : 'asc';
  const nextState: ListState = { ...state, page: 1, sort: column.name, direction: nextDirection };
  const indicator = isSorted ? (state.direction === 'asc' ? ' ↑' : ' ↓') : '';
  return h(
    'th',
    null,
    h('a', { href: `${root}${buildListQuery(nextState)}` }, column.label, indicator),
  );
}

/** Render a row's action links: the Edit link plus each row action. */
function renderRowActions(
  resource: Resource,
  id: string | undefined,
  rowActions: readonly AdminAction[],
  state: ListState,
  root: string,
): ComponentChild {
  const links: ComponentChild[] = [];
  if (resource.get !== undefined && id !== undefined) {
    links.push(h('a', { href: `${root}/${id}${buildListQuery(state)}` }, 'Edit'));
  }
  for (const action of rowActions) {
    if (id === undefined) continue;
    links.push(
      h(
        'a',
        { href: `${root}/${id}/actions/${action.name}${buildListQuery(state)}` },
        action.label,
      ),
    );
  }
  if (links.length === 0) return '';
  return h('span', null, ...intersperse(links, ' '));
}

/** Insert a separator node between elements. */
function intersperse(
  nodes: readonly ComponentChild[],
  separator: ComponentChild,
): ComponentChild[] {
  const out: ComponentChild[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    if (i > 0) out.push(separator);
    out.push(nodes[i]);
  }
  return out;
}

/** Resolve a single cell's markup: relation columns await their labels, others format the value. */
async function renderCellValue(
  column: ResourceColumn,
  row: Record<string, unknown>,
): Promise<ComponentChild> {
  if (column.type === 'relation') {
    return renderRelationCell(column, row);
  }
  return renderFormattedValue(row[column.name], column);
}

/** Render a relation column's resolved labels; a resolver failure renders empty. */
async function renderRelationCell(
  column: ResourceColumn,
  row: Record<string, unknown>,
): Promise<ComponentChild> {
  const resolve = column.resolve;
  if (resolve === undefined) {
    return '';
  }
  let labels: readonly string[];
  try {
    labels = (await resolve(row)) ?? [];
  } catch {
    labels = [];
  }
  if (labels.length === 0) {
    return '';
  }
  return h('ul', { class: 'admin-relation' }, ...labels.map((label) => h('li', null, label)));
}
