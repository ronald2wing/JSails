/**
 * Blog menus admin page: structured administration of the `primary` menu
 * location.
 *
 * The page manages one ordered, flat `MenuItem[]` with contiguous `sortOrder`
 * through `add`/`update`/`delete`/`move-up`/`move-down` actions. An unknown
 * action, an empty label or href, an off-site href scheme, an out-of-range
 * index, an add past `BLOG_MENU_MAX_ITEMS`, or a stored menu the repository
 * no longer accepts (an item that predates the href policy) yields a
 * value-free 400 that never echoes the submitted input. The href
 * check is the model's own menu link policy (`isAllowedMenuHref`), so the page
 * and every other repository writer refuse the same values.
 */

import { h, type ComponentChild } from 'preact';

import {
  actionForm,
  adminBadRequestResponse,
  adminRedirectResponse,
  csrfInput,
  defineAdminPage,
  hiddenInput,
  panelDocumentOptions,
  renderAdminDocumentWithTheme,
  renderNotice,
  type AdminPage,
  type AdminPagePostContext,
  type AdminPageRenderContext,
} from '@jsails/admin';

import {
  BLOG_MENU_MAX_ITEMS,
  BlogContentError,
  isAllowedMenuHref,
  type BlogMenuItem,
  type BlogRepository,
} from '../cms/index.js';
import { BLOG_PRIMARY_MENU_LOCATION } from '../plugin.js';
import { invalidateCached, PRIMARY_MENU_CACHE_KEY } from '../read-cache.js';
import {
  BLOG_PAGE_GROUP,
  SAVED_NOTICE,
  blogPagePath,
  formString,
  type BlogAdminPageOptions,
} from './page-frame.js';

/** Menus page slug and label. */
const MENUS_SLUG = 'menus';
const MENUS_LABEL = 'Menus';

/** The single menu location the page manages: the one the public header renders. */
const PRIMARY_LOCATION = BLOG_PRIMARY_MENU_LOCATION;
/** The name assigned to the primary menu when the page creates it. */
const PRIMARY_NAME = 'Primary';

/** The POST actions the page accepts. */
const MENU_ACTIONS = ['add', 'update', 'delete', 'move-up', 'move-down'] as const;

/** Build the menus {@link AdminPage}: ordered rows over the `primary` menu. */
export function defineBlogMenusAdminPage(options: BlogAdminPageOptions): AdminPage {
  const { repository } = options;
  return defineAdminPage({
    slug: MENUS_SLUG,
    label: MENUS_LABEL,
    group: BLOG_PAGE_GROUP,
    render: (context) => renderMenusPage(context, repository, options.path),
    handlePost: (context) => handleMenusPost(context, repository, options.path),
  });
}

/**
 * Resolve the `primary` menu, creating it (name `Primary`, empty items) when it
 * does not yet exist. Used only on mutation paths, so reads never create.
 */
async function resolvePrimaryMenu(repository: BlogRepository): Promise<{
  readonly id: string;
  readonly items: readonly BlogMenuItem[];
}> {
  const menus = await repository.listMenus();
  const existing = menus.find((menu) => menu.location === PRIMARY_LOCATION);
  if (existing !== undefined) {
    return { id: existing.id, items: existing.items };
  }
  const created = await repository.createMenu({
    name: PRIMARY_NAME,
    location: PRIMARY_LOCATION,
    items: [],
  });
  return { id: created.id, items: created.items };
}

/**
 * Parse a submitted label/href into a menu item (no children/sort), or `null`
 * when the label or href is empty or the href uses an off-site scheme.
 */
function parseMenuItem(value: unknown, rawHref: unknown): { label: string; href: string } | null {
  const label = formString(value);
  const href = formString(rawHref);
  if (label === '' || href === '' || !isAllowedMenuHref(href)) {
    return null;
  }
  return { label, href };
}

/** Parse a submitted form index against the current length, or `null`. */
function parseItemIndex(value: unknown, length: number): number | null {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed < length ? parsed : null;
}

/** Re-stamp a flat item tuple list into a `MenuItem[]` with contiguous sort order. */
function contiguousItems(items: readonly { label: string; href: string }[]): BlogMenuItem[] {
  return items.map((item, index) => ({
    label: item.label,
    href: item.href,
    sortOrder: index,
    children: [],
  }));
}

/** Render the menus document: the add form plus one editable row per item. */
async function renderMenusPage(
  context: AdminPageRenderContext,
  repository: BlogRepository,
  path?: string,
): Promise<string> {
  const menus = await repository.listMenus();
  const menu = menus.find((entry) => entry.location === PRIMARY_LOCATION);
  const items = menu?.items ?? [];
  const notice = context.url.searchParams.get('notice') === SAVED_NOTICE ? 'Menu saved.' : null;
  const actionPath = blogPagePath(path ?? context.path, MENUS_SLUG);

  const body: ComponentChild[] = [
    h('h1', null, MENUS_LABEL),
    ...(notice === null ? [] : [renderNotice(notice)]),
    actionForm({
      path: actionPath,
      csrf: context.session.csrfToken,
      action: 'add',
      label: 'Add item',
      controls: [
        h('div', null, h('label', null, 'Label'), h('input', { type: 'text', name: 'label' })),
        h('div', null, h('label', null, 'Href'), h('input', { type: 'text', name: 'href' })),
      ],
    }),
  ];

  if (items.length === 0) {
    body.push(h('p', null, 'No menu items yet.'));
  } else {
    body.push(h('h2', null, 'Items'));
    for (const [index, item] of [...items].sort((a, b) => a.sortOrder - b.sortOrder).entries()) {
      body.push(menuItemForm(actionPath, context, index, item.label, item.href));
    }
  }

  return renderAdminDocumentWithTheme(panelDocumentOptions(context, MENUS_LABEL), ...body);
}

/** One editable item form: label/href inputs plus the four row actions. */
function menuItemForm(
  actionPath: string,
  context: AdminPageRenderContext,
  index: number,
  label: string,
  href: string,
): ComponentChild {
  return h(
    'form',
    { method: 'post', action: actionPath },
    csrfInput(context.session.csrfToken),
    hiddenInput('index', String(index)),
    h(
      'div',
      null,
      h('label', null, 'Label'),
      h('input', { type: 'text', name: 'label', value: label }),
    ),
    h(
      'div',
      null,
      h('label', null, 'Href'),
      h('input', { type: 'text', name: 'href', value: href }),
    ),
    h('button', { type: 'submit', name: 'action', value: 'update' }, 'Save'),
    h('button', { type: 'submit', name: 'action', value: 'move-up' }, 'Move up'),
    h('button', { type: 'submit', name: 'action', value: 'move-down' }, 'Move down'),
    h('button', { type: 'submit', name: 'action', value: 'delete' }, 'Delete'),
  );
}

/** Handle the menus `POST`: dispatch the action and persist the re-ordered items. */
async function handleMenusPost(
  context: AdminPagePostContext,
  repository: BlogRepository,
  path?: string,
): Promise<Response> {
  const action = context.body['action'];
  if (
    typeof action !== 'string' ||
    !MENU_ACTIONS.includes(action as (typeof MENU_ACTIONS)[number])
  ) {
    return adminBadRequestResponse();
  }

  const menu = await resolvePrimaryMenu(repository);
  const items: { label: string; href: string }[] = menu.items.map((item) => ({
    label: item.label,
    href: item.href,
  }));

  if (action === 'add') {
    const added = parseMenuItem(context.body['label'], context.body['href']);
    if (added === null || items.length >= BLOG_MENU_MAX_ITEMS) {
      return adminBadRequestResponse();
    }
    items.push(added);
  } else {
    const index = parseItemIndex(context.body['index'], items.length);
    if (index === null) {
      return adminBadRequestResponse();
    }
    if (action === 'update') {
      const updated = parseMenuItem(context.body['label'], context.body['href']);
      if (updated === null) {
        return adminBadRequestResponse();
      }
      items[index] = updated;
    } else if (action === 'delete') {
      items.splice(index, 1);
    } else if (action === 'move-up' && index > 0) {
      [items[index - 1], items[index]] = [items[index]!, items[index - 1]!];
    } else if (action === 'move-down' && index < items.length - 1) {
      [items[index + 1], items[index]] = [items[index]!, items[index + 1]!];
    }
  }

  try {
    await repository.updateMenu(menu.id, { items: contiguousItems(items) });
  } catch (error) {
    // The repository re-validates the whole menu, so a stored item that predates
    // the href policy fails every action on it: an editor fault, not a server one.
    if (error instanceof BlogContentError && error.code === 'invalid_input') {
      return adminBadRequestResponse();
    }
    throw error;
  }
  invalidateCached(repository, PRIMARY_MENU_CACHE_KEY);

  return adminRedirectResponse(
    `${blogPagePath(path ?? context.path, MENUS_SLUG)}?notice=${SAVED_NOTICE}`,
  );
}
