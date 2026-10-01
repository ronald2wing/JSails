/**
 * Blog admin settings and menu pages: curated, structured administration
 * replacing the former raw-JSON textarea resources.
 *
 * `settingsAdminPage(repository, path?)`, `menusAdminPage(repository,
 * path?)`, and `revisionsAdminPage(repository, path?)` each return an
 * {@link AdminPage} mounted by {@link blogAdmin}; the descriptors are inert
 * until {@link adminPlugin} mounts them. The pages are deliberately thin over
 * the injected {@link ContentRepository}: they read and write only the
 * repository contract and never reach into its storage.
 *
 * The settings page curates five keys — `site.title` (required), `site.tagline`,
 * `site.postsPerPage` (a bounded integer), `site.timezone`, and `site.social`
 * (a JSON-safe object of platform → URL) — read through `listSettings`/
 * `getSetting` and written through `setSetting`. The menus page manages a
 * single `primary` location: an ordered, flat `MenuItem[]` with contiguous
 * `sortOrder`, plus add/update/delete/move-up/move-down actions. The revisions
 * page lists a post/page's recorded revisions newest-first and restores a
 * selected snapshot onto the entry.
 *
 * Every mutation is `action`-dispatched; an unknown action, an empty label or
 * href, a non-integer/out-of-range index, a non-integer posts-per-page, a
 * non-JSON-safe social value, or an off-site URL scheme yields a value-free 400
 * (`adminBadRequestResponse`) that never echoes the submitted input, matching
 * the repository's error style.
 */

import { h, type ComponentChild } from 'preact';

import {
  adminBadRequestResponse,
  adminNotFoundResponse,
  adminRedirectResponse,
  defineAdminPage,
  renderAdminDocumentWithTheme,
  type AdminPage,
  type AdminPagePostContext,
  type AdminPageRenderContext,
} from '@jsails/admin';
import type {
  ContentRepository,
  JsonValue,
  MenuItem,
  PageSnapshot,
  PostSnapshot,
  Revision,
} from './content/index.js';
import { pageSnapshotSchema, postSnapshotSchema } from './content/index.js';

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Navigation group shared by the two pages, matching the theme-admin page. */
const PAGE_GROUP = 'Content';

/** The notice `?notice=` values rendered as a status line after a save. */
const SAVED_NOTICE = 'saved';

/** Build the action path (`<base>/<slug>`) for a panel base path. */
function pagePath(base: string, slug: string): string {
  return base === '' || base === '/' ? `/${slug}` : `${base}/${slug}`;
}

/** Coerce a form value into a trimmed string (non-strings become ''). */
function toString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

/** Settings page slug and label. */
const SETTINGS_SLUG = 'settings';
const SETTINGS_LABEL = 'Settings';

/** The five curated setting keys, in render order. */
const SITE_KEYS = [
  'site.title',
  'site.tagline',
  'site.postsPerPage',
  'site.timezone',
  'site.social',
] as const;

const DEFAULT_POSTS_PER_PAGE = 10;
const MAX_POSTS_PER_PAGE = 200;
const DEFAULT_TIMEZONE = 'UTC';

/**
 * Options for {@link settingsAdminPage} and {@link menusAdminPage}. The path
 * defaults to the panel's own base path when omitted.
 */
export interface BlogAdminPageOptions {
  /** The repository persisting settings (or the `primary` menu). */
  readonly repository: ContentRepository;
  /** The page path under the panel base path. Defaults to `context.path`. */
  readonly path?: string;
}

/**
 * Build the settings {@link AdminPage}: a curated form over the five site keys.
 * Mounted by {@link blogAdmin}; also usable directly where a standalone page is
 * wanted.
 */
export function settingsAdminPage(options: BlogAdminPageOptions): AdminPage {
  const { repository } = options;
  return defineAdminPage({
    slug: SETTINGS_SLUG,
    label: SETTINGS_LABEL,
    group: PAGE_GROUP,
    render: (context) => renderSettingsPage(context, repository, options.path),
    handlePost: (context) => handleSettingsPost(context, repository, options.path),
  });
}

/** Read a curated setting, coercing absent/mistyped values to a safe default. */
async function readSetting(
  repository: ContentRepository,
  key: string,
): Promise<JsonValue | undefined> {
  const setting = await repository.getSetting(key);
  return setting?.value;
}

/** Coerce a setting value to a string (defaulting to ''). */
function settingString(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** Coerce a setting value to the posts-per-page integer (defaulting). */
function settingPostsPerPage(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : DEFAULT_POSTS_PER_PAGE;
}

/** Coerce a setting value to a social object of string values (defaulting to {}). */
function settingSocial(value: JsonValue | undefined): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const social: Record<string, string> = {};
  for (const [platform, href] of Object.entries(value)) {
    if (typeof href !== 'string') {
      return {};
    }
    social[platform] = href;
  }
  return social;
}

/** Resolve the five curated site values from the repository. */
async function readSite(repository: ContentRepository): Promise<{
  title: string;
  tagline: string;
  postsPerPage: number;
  timezone: string;
  social: Record<string, string>;
}> {
  const [title, tagline, postsPerPage, timezone, social] = await Promise.all(
    SITE_KEYS.map((key) => readSetting(repository, key)),
  );
  const timezoneValue = settingString(timezone);
  return {
    title: settingString(title),
    tagline: settingString(tagline),
    postsPerPage: settingPostsPerPage(postsPerPage),
    timezone: timezoneValue === '' ? DEFAULT_TIMEZONE : timezoneValue,
    social: settingSocial(social),
  };
}

/** Render the full settings document: a curated form over the five site keys. */
async function renderSettingsPage(
  context: AdminPageRenderContext,
  repository: ContentRepository,
  path?: string,
): Promise<string> {
  const site = await readSite(repository);
  const notice = context.url.searchParams.get('notice') === SAVED_NOTICE ? 'Settings saved.' : null;
  const actionPath = pagePath(path ?? context.path, SETTINGS_SLUG);

  const body: ComponentChild[] = [
    h('h1', null, SETTINGS_LABEL),
    ...(notice === null ? [] : [h('p', { role: 'status' }, notice)]),
    h(
      'form',
      { method: 'post', action: actionPath },
      h('input', { type: 'hidden', name: '_csrf', value: context.session.csrfToken }),
      h('input', { type: 'hidden', name: 'action', value: 'save' }),
      h('div', null, h('label', null, 'Site title'), textInput('site.title', site.title, true)),
      h('div', null, h('label', null, 'Tagline'), textInput('site.tagline', site.tagline, false)),
      h(
        'div',
        null,
        h('label', null, 'Posts per page'),
        h('input', {
          type: 'number',
          name: 'site.postsPerPage',
          value: String(site.postsPerPage),
          min: '1',
          max: String(MAX_POSTS_PER_PAGE),
        }),
      ),
      h('div', null, h('label', null, 'Timezone'), textInput('site.timezone', site.timezone, true)),
      h(
        'div',
        null,
        h('label', null, 'Social (JSON object of platform to URL)'),
        h('textarea', { name: 'site.social' }, socialText(site.social)),
      ),
      h('button', { type: 'submit' }, 'Save settings'),
    ),
  ];

  return renderAdminDocumentWithTheme(
    {
      title: SETTINGS_LABEL,
      theme: context.theme,
      themeCustomization: context.themeCustomization,
      themeTokens: context.themeTokens,
    },
    ...body,
  );
}

/** A single text field with the given name, value, and requirement. */
function textInput(name: string, value: string, required: boolean): ComponentChild {
  return h('input', { type: 'text', name, value, ...(required ? { required: true } : {}) });
}

/** Serialize the social object for the textarea (JSON, or '' when empty). */
function socialText(social: Record<string, string>): string {
  return Object.keys(social).length === 0 ? '' : JSON.stringify(social, null, 2);
}

/** Parse the posts-per-page field as a bounded integer, or `null` when invalid. */
function parsePostsPerPage(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_POSTS_PER_PAGE ? parsed : null;
}

/** Parse the social textarea as a JSON-safe object of string values, or `null`. */
function parseSocial(value: unknown): Record<string, string> | null {
  const raw = toString(value);
  if (raw === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const social: Record<string, string> = {};
  for (const [platform, href] of Object.entries(parsed)) {
    if (typeof href !== 'string') {
      return null;
    }
    social[platform] = href;
  }
  return social;
}

/** Handle the settings `POST`: validate and persist the five curated keys. */
async function handleSettingsPost(
  context: AdminPagePostContext,
  repository: ContentRepository,
  path?: string,
): Promise<Response> {
  if (context.body['action'] !== 'save') {
    return adminBadRequestResponse();
  }

  const title = toString(context.body['site.title']);
  if (title === '') {
    return adminBadRequestResponse();
  }
  const timezone = toString(context.body['site.timezone']);
  if (timezone === '') {
    return adminBadRequestResponse();
  }
  const postsPerPage = parsePostsPerPage(context.body['site.postsPerPage']);
  if (postsPerPage === null) {
    return adminBadRequestResponse();
  }
  const social = parseSocial(context.body['site.social']);
  if (social === null) {
    return adminBadRequestResponse();
  }

  await repository.setSetting('site.title', title);
  await repository.setSetting('site.tagline', toString(context.body['site.tagline']));
  await repository.setSetting('site.postsPerPage', postsPerPage);
  await repository.setSetting('site.timezone', timezone);
  await repository.setSetting('site.social', social);

  return adminRedirectResponse(
    `${pagePath(path ?? context.path, SETTINGS_SLUG)}?notice=${SAVED_NOTICE}`,
  );
}

// ---------------------------------------------------------------------------
// Menus page
// ---------------------------------------------------------------------------

/** Menus page slug and label. */
const MENUS_SLUG = 'menus';
const MENUS_LABEL = 'Menus';

/** The single menu location the page manages. */
const PRIMARY_LOCATION = 'primary';
/** The name assigned to the primary menu when the page creates it. */
const PRIMARY_NAME = 'Primary';

/** The POST actions the page accepts. */
const MENU_ACTIONS = ['add', 'update', 'delete', 'move-up', 'move-down'] as const;

/** Build the menus {@link AdminPage}: ordered rows over the `primary` menu. */
export function menusAdminPage(options: BlogAdminPageOptions): AdminPage {
  const { repository } = options;
  return defineAdminPage({
    slug: MENUS_SLUG,
    label: MENUS_LABEL,
    group: PAGE_GROUP,
    render: (context) => renderMenusPage(context, repository, options.path),
    handlePost: (context) => handleMenusPost(context, repository, options.path),
  });
}

/**
 * Resolve the `primary` menu, creating it (name `Primary`, empty items) when it
 * does not yet exist. Used only on mutation paths, so reads never create.
 */
async function resolvePrimaryMenu(repository: ContentRepository): Promise<{
  readonly id: string;
  readonly items: readonly MenuItem[];
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

/** True when an href has no scheme, or an allowed `http:`/`https:` scheme. */
function hrefAllowed(href: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href);
  if (scheme === null) {
    return true;
  }
  const schemeName = scheme[1]!.toLowerCase();
  return schemeName === 'http' || schemeName === 'https';
}

/**
 * Parse a submitted label/href into a menu item (no children/sort), or `null`
 * when the label or href is empty or the href uses an off-site scheme.
 */
function parseMenuItem(value: unknown, rawHref: unknown): { label: string; href: string } | null {
  const label = toString(value);
  const href = toString(rawHref);
  if (label === '' || href === '' || !hrefAllowed(href)) {
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
function contiguousItems(items: readonly { label: string; href: string }[]): MenuItem[] {
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
  repository: ContentRepository,
  path?: string,
): Promise<string> {
  const menus = await repository.listMenus();
  const menu = menus.find((entry) => entry.location === PRIMARY_LOCATION);
  const items = menu?.items ?? [];
  const notice = context.url.searchParams.get('notice') === SAVED_NOTICE ? 'Menu saved.' : null;
  const actionPath = pagePath(path ?? context.path, MENUS_SLUG);

  const body: ComponentChild[] = [
    h('h1', null, MENUS_LABEL),
    ...(notice === null ? [] : [h('p', { role: 'status' }, notice)]),
    h(
      'form',
      { method: 'post', action: actionPath },
      h('input', { type: 'hidden', name: '_csrf', value: context.session.csrfToken }),
      h('input', { type: 'hidden', name: 'action', value: 'add' }),
      h('div', null, h('label', null, 'Label'), h('input', { type: 'text', name: 'label' })),
      h('div', null, h('label', null, 'Href'), h('input', { type: 'text', name: 'href' })),
      h('button', { type: 'submit' }, 'Add item'),
    ),
  ];

  if (items.length === 0) {
    body.push(h('p', null, 'No menu items yet.'));
  } else {
    body.push(h('h2', null, 'Items'));
    for (const [index, item] of [...items].sort((a, b) => a.sortOrder - b.sortOrder).entries()) {
      body.push(menuItemForm(actionPath, context, index, item.label, item.href));
    }
  }

  return renderAdminDocumentWithTheme(
    {
      title: MENUS_LABEL,
      theme: context.theme,
      themeCustomization: context.themeCustomization,
      themeTokens: context.themeTokens,
    },
    ...body,
  );
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
    h('input', { type: 'hidden', name: '_csrf', value: context.session.csrfToken }),
    h('input', { type: 'hidden', name: 'index', value: String(index) }),
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
  repository: ContentRepository,
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
    if (added === null) {
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

  await repository.updateMenu(menu.id, { items: contiguousItems(items) });

  return adminRedirectResponse(
    `${pagePath(path ?? context.path, MENUS_SLUG)}?notice=${SAVED_NOTICE}`,
  );
}

// ---------------------------------------------------------------------------
// Revisions page
// ---------------------------------------------------------------------------

/** Revisions page slug and label. */
const REVISIONS_SLUG = 'revisions';
const REVISIONS_LABEL = 'Revisions';

/** A revision entry type, narrowed to the two content collections. */
type RevisionEntryType = 'post' | 'page';

/** The restore POST action the page accepts. */
const RESTORE_ACTION = 'restore';

/** The `?notice=` value rendered after a successful restore. */
const RESTORED_NOTICE = 'restored';

/** Narrow a query/body value to a supported entry type, or `null`. */
function toEntryType(value: unknown): RevisionEntryType | null {
  return value === 'post' || value === 'page' ? value : null;
}

/**
 * The entry id query value, or `null` when absent/blank. Ids are opaque, so the
 * only validation is presence; existence is checked against the repository.
 */
function toEntryId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return id === '' ? null : id;
}

/** True when the entry type/id query pair names a known post or page. */
async function entryExists(
  repository: ContentRepository,
  entryType: RevisionEntryType,
  entryId: string,
): Promise<boolean> {
  return entryType === 'post'
    ? (await repository.getPost(entryId)) !== undefined
    : (await repository.getPage(entryId)) !== undefined;
}

/** Resolve a revision by id within the (type, entry) scope. */
async function findRevision(
  repository: ContentRepository,
  entryType: RevisionEntryType,
  entryId: string,
  revisionId: string,
): Promise<Revision | undefined> {
  const revisions = await repository.listRevisions(entryType, entryId);
  return revisions.find((revision) => revision.id === revisionId);
}

/** Build the revisions {@link AdminPage}: list + restore over post/page revisions. */
export function revisionsAdminPage(options: BlogAdminPageOptions): AdminPage {
  const { repository } = options;

  return defineAdminPage({
    slug: REVISIONS_SLUG,
    label: REVISIONS_LABEL,
    group: PAGE_GROUP,
    render: (context) => renderRevisionsPage(context, repository, options.path),
    handleGet: (context) => guardRevisionsGet(context, repository),
    handlePost: (context) => handleRevisionsPost(context, repository, options.path),
  });
}

/**
 * Validate the `GET` query before `render` runs: a present-but-unknown
 * `entryType` is a value-free 400, and a valid type whose `entryId` names no
 * existing entry is a value-free 404. Without query params the page renders the
 * lookup form.
 */
async function guardRevisionsGet(
  context: AdminPageRenderContext,
  repository: ContentRepository,
): Promise<Response | undefined> {
  const rawType = context.url.searchParams.get('entryType');
  if (rawType === null) {
    return undefined;
  }
  const entryType = toEntryType(rawType);
  if (entryType === null) {
    return adminBadRequestResponse();
  }
  const entryId = toEntryId(context.url.searchParams.get('entryId'));
  if (entryId === null || !(await entryExists(repository, entryType, entryId))) {
    return adminNotFoundResponse();
  }
  return undefined;
}

/** Render the revisions document: a lookup form plus the scoped revision list. */
async function renderRevisionsPage(
  context: AdminPageRenderContext,
  repository: ContentRepository,
  path?: string,
): Promise<string> {
  const entryType = toEntryType(context.url.searchParams.get('entryType'));
  const entryId = toEntryId(context.url.searchParams.get('entryId'));
  const scoped = entryType !== null && entryId !== null;
  const revisions = scoped
    ? [...(await repository.listRevisions(entryType, entryId))].reverse()
    : [];
  const notice =
    context.url.searchParams.get('notice') === RESTORED_NOTICE ? 'Revision restored.' : null;
  const actionPath = pagePath(path ?? context.path, REVISIONS_SLUG);

  const body: ComponentChild[] = [
    h('h1', null, REVISIONS_LABEL),
    ...(notice === null ? [] : [h('p', { role: 'status' }, notice)]),
    h(
      'form',
      { method: 'get', action: actionPath },
      h(
        'div',
        null,
        h('label', null, 'Entry type'),
        h(
          'select',
          { name: 'entryType' },
          h('option', { value: 'post', selected: entryType === 'post' }, 'Post'),
          h('option', { value: 'page', selected: entryType === 'page' }, 'Page'),
        ),
      ),
      h(
        'div',
        null,
        h('label', null, 'Entry id'),
        h('input', { type: 'text', name: 'entryId', value: entryId ?? '' }),
      ),
      h('button', { type: 'submit' }, 'List revisions'),
    ),
  ];

  if (!scoped) {
    body.push(h('p', null, 'Choose an entry to list its revisions.'));
  } else if (revisions.length === 0) {
    body.push(h('p', null, 'No revisions recorded for this entry.'));
  } else {
    body.push(h('h2', null, 'Revisions'));
    for (const revision of revisions) {
      body.push(revisionRow(actionPath, context, entryType, entryId, revision));
    }
  }

  return renderAdminDocumentWithTheme(
    {
      title: REVISIONS_LABEL,
      theme: context.theme,
      themeCustomization: context.themeCustomization,
      themeTokens: context.themeTokens,
    },
    ...body,
  );
}

/** One revision row: timestamp plus a restore button posting its revision id. */
function revisionRow(
  actionPath: string,
  context: AdminPageRenderContext,
  entryType: RevisionEntryType,
  entryId: string,
  revision: Revision,
): ComponentChild {
  return h(
    'form',
    { method: 'post', action: actionPath },
    h('input', { type: 'hidden', name: '_csrf', value: context.session.csrfToken }),
    h('input', { type: 'hidden', name: 'action', value: RESTORE_ACTION }),
    h('input', { type: 'hidden', name: 'entryType', value: entryType }),
    h('input', { type: 'hidden', name: 'entryId', value: entryId }),
    h('input', { type: 'hidden', name: 'revisionId', value: revision.id }),
    h('span', null, snapshotTitle(revision.snapshot)),
    h('span', null, revision.createdAt),
    h('button', { type: 'submit' }, 'Restore'),
  );
}

/** The snapshot's `title` when present and a string, else the empty string. */
function snapshotTitle(snapshot: JsonValue): string {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return '';
  }
  const title = snapshot['title'];
  return typeof title === 'string' ? title : '';
}

/** Handle the restore `POST`: validate the snapshot and re-apply it to the entry. */
async function handleRevisionsPost(
  context: AdminPagePostContext,
  repository: ContentRepository,
  path?: string,
): Promise<Response> {
  if (context.body['action'] !== RESTORE_ACTION) {
    return adminBadRequestResponse();
  }

  const entryType = toEntryType(context.body['entryType']);
  const entryId = toEntryId(context.body['entryId']);
  if (entryType === null || entryId === null) {
    return adminBadRequestResponse();
  }
  if (!(await entryExists(repository, entryType, entryId))) {
    return adminNotFoundResponse();
  }

  const revisionId = toEntryId(context.body['revisionId']);
  if (revisionId === null) {
    return adminBadRequestResponse();
  }
  // The revision is looked up within the (type, entry) scope, so a snapshot can
  // never be restored into a different entry type or id than it was recorded
  // against.
  const revision = await findRevision(repository, entryType, entryId, revisionId);
  if (revision === undefined) {
    return adminNotFoundResponse();
  }

  if (!(await restoreSnapshot(repository, entryType, entryId, revision.snapshot))) {
    return adminBadRequestResponse();
  }

  return adminRedirectResponse(
    `${pagePath(path ?? context.path, REVISIONS_SLUG)}?entryType=${encodeURIComponent(
      entryType,
    )}&entryId=${encodeURIComponent(entryId)}&notice=${RESTORED_NOTICE}`,
  );
}

/**
 * Validate a snapshot against the entry's snapshot schema and apply it. Returns
 * `false` (never throws) when the snapshot is not a valid content snapshot, so
 * the caller maps it to a value-free 400.
 */
async function restoreSnapshot(
  repository: ContentRepository,
  entryType: RevisionEntryType,
  entryId: string,
  snapshot: JsonValue,
): Promise<boolean> {
  if (entryType === 'post') {
    const parsed = postSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) {
      return false;
    }
    const post: PostSnapshot = parsed.data;
    await repository.updatePost(entryId, {
      title: post.title,
      slug: post.slug,
      excerpt: post.excerpt,
      blocks: post.blocks,
      ...(post.editor === undefined ? {} : { editor: post.editor }),
      ...(post.native === undefined ? {} : { native: post.native }),
      categoryIds: [...post.categoryIds],
      tagIds: [...post.tagIds],
      featuredMediaId: post.featuredMediaId,
    });
    return true;
  }

  const parsed = pageSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    return false;
  }
  const page: PageSnapshot = parsed.data;
  await repository.updatePage(entryId, {
    title: page.title,
    slug: page.slug,
    blocks: page.blocks,
    parentId: page.parentId,
    sortOrder: page.sortOrder,
  });
  return true;
}
