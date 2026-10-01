/**
 * Feature-flags admin page: a listing of every global flag with an
 * activate/deactivate toggle, rendered as an {@link AdminPage} inside the admin
 * panel.
 *
 * The page reads and writes through the same {@link FeatureStore} the app hands
 * `flagsPlugin({ store })`, so the admin and the runtime service never diverge.
 * Only the global scope is managed — scoped flags are app-specific and must be
 * toggled through application code; the page says so.
 *
 * The descriptor is inert until the admin panel mounts it and performs no I/O
 * until the page renders or a toggle is submitted.
 */

import { h, type ComponentChild } from 'preact';

import {
  actionForm,
  adminBadRequestResponse,
  adminNotFoundResponse,
  adminRedirectResponse,
  adminServerErrorResponse,
  defineAdminPage,
  hiddenInput,
  panelDocumentOptions,
  renderAdminDocumentWithTheme,
  renderNotice,
  type AdminPage,
  type AdminPagePostContext,
  type AdminPageRenderContext,
} from '@jsails/admin';
import { createFeatureFlags, type FeatureFlags, type FeatureStore } from '../flags.js';

/** Options for {@link defineFlagsAdminPage}. */
export interface FlagsAdminPageOptions {
  /** The store backing the app's `flagsPlugin`; never recreated by the page. */
  readonly store: FeatureStore;
  /**
   * Optional override for the panel base path used by links and redirects.
   * Defaults to the path the panel supplies at request time (`context.path`).
   */
  readonly path?: string;
}

const FLAG_ACTIVATED = 'flag_activated';
const FLAG_DEACTIVATED = 'flag_deactivated';

/** Fixed, value-free notice messages keyed by the only codes this page emits. */
const NOTICE_MESSAGES: ReadonlyMap<string, string> = new Map([
  [FLAG_ACTIVATED, 'Flag activated.'],
  [FLAG_DEACTIVATED, 'Flag deactivated.'],
]);

/** Define the frozen admin-page descriptor (slug `flags`) for the feature-flags surface. */
export function defineFlagsAdminPage(options: FlagsAdminPageOptions): AdminPage {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('defineFlagsAdminPage requires an options object');
  }
  if (
    options.store === null ||
    typeof options.store !== 'object' ||
    typeof options.store.all !== 'function'
  ) {
    throw new TypeError('defineFlagsAdminPage requires a feature store');
  }

  const flags = createFeatureFlags(options.store);
  const basePath = (context: AdminPageRenderContext): string => options.path ?? context.path;

  return defineAdminPage({
    slug: 'flags',
    label: 'Feature Flags',
    render: (context) => renderFlagsPage(context, flags, basePath(context)),
    handlePost: (context) => handleFlagsPost(context, flags, basePath(context)),
  });
}

/** Render the flags page: heading, notice, scope note, table, and back link. */
async function renderFlagsPage(
  context: AdminPageRenderContext,
  flags: FeatureFlags,
  path: string,
): Promise<string> {
  const notice = NOTICE_MESSAGES.get(context.url.searchParams.get('notice') ?? '');
  const body: ComponentChild[] = [];
  if (notice !== undefined) {
    body.push(renderNotice(notice));
  }
  body.push(await renderFlagList(flags, context.session.csrfToken, path));
  body.push(h('a', { href: path }, 'Back to dashboard'));

  return renderAdminDocumentWithTheme(panelDocumentOptions(context, 'Feature Flags'), ...body);
}

/** Render the heading, scope note, and flag table (or the empty state). */
async function renderFlagList(
  flags: FeatureFlags,
  csrf: string,
  path: string,
): Promise<ComponentChild> {
  const entries = Object.entries(await flags.all()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  return h(
    'div',
    null,
    h('h1', null, 'Feature Flags'),
    h(
      'p',
      { class: 'admin-flags-scope-note' },
      'Flags shown below are global only. Scoped flags (per-user, per-tenant) must be toggled through application code.',
    ),
    entries.length === 0
      ? h('p', null, 'No global flags configured.')
      : renderFlagsTable(entries, csrf, `${path}/flags`),
  );
}

function renderFlagsTable(
  entries: readonly (readonly [string, boolean])[],
  csrf: string,
  action: string,
): ComponentChild {
  return h(
    'table',
    null,
    h(
      'thead',
      null,
      h('tr', null, h('th', null, 'Flag'), h('th', null, 'Status'), h('th', null, 'Actions')),
    ),
    h('tbody', null, ...entries.map(([key, active]) => renderFlagRow(key, active, csrf, action))),
  );
}

/** Render one flag row: name, active/inactive status, and a toggle form. */
function renderFlagRow(key: string, active: boolean, csrf: string, action: string): ComponentChild {
  return h(
    'tr',
    null,
    h('td', null, h('code', null, key)),
    h(
      'td',
      null,
      h(
        'span',
        { class: active ? 'admin-badge' : 'admin-badge admin-badge-inactive' },
        active ? 'active' : 'inactive',
      ),
    ),
    h(
      'td',
      null,
      actionForm({
        path: action,
        csrf,
        label: active ? 'Deactivate' : 'Activate',
        controls: [hiddenInput('flag_key', key), hiddenInput('flag_active', String(!active))],
      }),
    ),
  );
}

/** Handle the page POST: toggle a single, already-known global flag. */
async function handleFlagsPost(
  context: AdminPagePostContext,
  flags: FeatureFlags,
  path: string,
): Promise<Response> {
  const key = context.body['flag_key'];
  const activeValue = context.body['flag_active'];
  if (key === undefined || key === '' || (activeValue !== 'true' && activeValue !== 'false')) {
    return adminBadRequestResponse();
  }
  const active = activeValue === 'true';

  // Only toggle flags the store already knows, so the form cannot mint new keys.
  if (!Object.hasOwn(await flags.all(), key)) {
    return adminNotFoundResponse();
  }

  try {
    if (active) {
      await flags.activate(key);
    } else {
      await flags.deactivate(key);
    }
  } catch {
    return adminServerErrorResponse();
  }

  return adminRedirectResponse(
    `${path}/flags?notice=${active ? FLAG_ACTIVATED : FLAG_DEACTIVATED}`,
  );
}
