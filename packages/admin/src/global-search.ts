/**
 * Admin global search: a server-rendered page that searches across every
 * resource with at least one `searchable` column.
 *
 * `renderGlobalSearch(panel, resources, session, term)` queries each eligible
 * resource's `list` callback with the search term, then filters the returned
 * rows to those the resource's own `authorize` allows for the current session.
 * Only resources the session may `list` — and only rows it may `view` — are
 * returned; a resource whose `list` throws is skipped (and reported through
 * the panel's `onError`) rather than failing the whole page. The term is
 * trimmed and length-clamped and rendered as an escaped value; an empty term
 * renders the form without querying anything. Resources are queried
 * concurrently and each one's row gates run concurrently, keeping the
 * resource and row order of the declaration and the list result.
 *
 * The module is ORM-free and performs no I/O beyond invoking the resource's
 * already-trusted callbacks.
 */

import { h, type ComponentChild } from 'preact';
import type { Session } from 'jsails';

import { panelDocumentOptions, renderAdminDocumentWithTheme } from './document.js';
import { reportAdminError } from './error-report.js';
import type { AdminPanel } from './panel.js';
import { recordId, resourceAllowed } from './resource/access.js';
import type { Resource } from './resource/index.js';

/** Maximum characters accepted from a search query. */
const MAX_QUERY_LENGTH = 200;

/** Rows fetched per resource for the search results. */
const RESULTS_PER_RESOURCE = 10;

/** A resource plus its authorized matching rows. */
interface SearchGroup {
  readonly resource: Resource;
  readonly rows: readonly Record<string, unknown>[];
}

/**
 * Render the full global-search document. The term is clamped; resources and
 * rows the session is not authorized for are never included.
 */
export async function renderGlobalSearch(
  panel: AdminPanel,
  resources: readonly Resource[],
  session: Session,
  term: string,
): Promise<string> {
  const query = term.trim().slice(0, MAX_QUERY_LENGTH);
  const searched =
    query === ''
      ? []
      : await Promise.all(
          resources
            .filter((resource) => resource.columns.some((column) => column.searchable === true))
            .map((resource) => searchResource(panel, resource, session, query)),
        );
  const groups = searched.filter((group): group is SearchGroup => group !== null);
  return renderAdminDocumentWithTheme(
    panelDocumentOptions(panel, `${panel.title} - Search`),
    h('main', null, ...renderSearchBody(panel, query, groups)),
  );
}

/** One resource's authorized matches, or `null` when it is gated, failing, or empty. */
async function searchResource(
  panel: AdminPanel,
  resource: Resource,
  session: Session,
  query: string,
): Promise<SearchGroup | null> {
  if (!(await resourceAllowed(resource, session, 'list', undefined, { report: panel }))) {
    return null;
  }
  let rows: readonly Record<string, unknown>[];
  try {
    const result = await resource.list({
      session,
      page: 1,
      pageSize: RESULTS_PER_RESOURCE,
      search: query,
    });
    rows = result.rows;
  } catch (error) {
    reportAdminError(panel, error, { surface: 'search', slug: resource.slug, operation: 'list' });
    return null;
  }
  const allowed = await Promise.all(
    rows.map(async (row) => {
      const id = recordId(row);
      return id !== undefined && resourceAllowed(resource, session, 'view', id, { report: panel });
    }),
  );
  const authorized = rows.filter((_row, index) => allowed[index] === true);
  return authorized.length === 0 ? null : { resource, rows: authorized };
}

/** The page body: a search form, the grouped results, and a dashboard link. */
function renderSearchBody(
  panel: AdminPanel,
  query: string,
  groups: readonly SearchGroup[],
): ComponentChild[] {
  const children: ComponentChild[] = [h('h1', null, 'Search'), renderSearchForm(panel.path, query)];
  if (groups.length === 0) {
    children.push(h('p', null, query === '' ? 'Enter a search term.' : 'No results.'));
  } else {
    children.push(...groups.map((group) => renderSearchGroup(panel.path, group)));
  }
  children.push(h('a', { href: panel.path }, 'Back to dashboard'));
  return children;
}

/** The search form: a single `q` input posting back to the search page. */
function renderSearchForm(path: string, query: string): ComponentChild {
  return h(
    'form',
    { method: 'get', action: `${path}/_search` },
    h('input', { type: 'text', name: 'q', value: query }),
    h('button', { type: 'submit' }, 'Search'),
  );
}

/** One resource's results: a heading plus a list of row links. */
function renderSearchGroup(path: string, group: SearchGroup): ComponentChild {
  const items = group.rows.map((row) => {
    const id = recordId(row);
    const label = rowLabel(group.resource, row, id);
    return h(
      'li',
      null,
      h(
        'a',
        {
          href:
            id === undefined
              ? `${path}/${group.resource.slug}`
              : `${path}/${group.resource.slug}/${id}`,
        },
        label,
      ),
    );
  });
  return h('section', null, h('h2', null, group.resource.label), h('ul', null, ...items));
}

/** A stable, escaped label for a search result row. */
function rowLabel(
  resource: Resource,
  row: Record<string, unknown>,
  id: string | undefined,
): string {
  const first = resource.columns[0];
  if (first !== undefined) {
    const value = row[first.name];
    if (value !== null && value !== undefined) return String(value);
  }
  return id ?? '';
}
