/**
 * Blog theme administration: an admin-panel surface for activating a first-
 * party theme package against the tenant-free CMS.
 *
 * `blogThemeAdmin(options)` returns an {@link AdminPlugin} (id `blog-themes`)
 * whose `register` contributes a single page (slug `themes`, label `Themes`,
 * group `Content`). The page lists every registered theme package with its
 * name, version, description, and an active badge, and renders one Activate
 * form per non-active theme. The persisted active theme name lives in a
 * setting (default key `theme.active`); `GET` resolves it against the registry
 * (falling back to {@link ThemePackageRegistry.activeName} when the setting is
 * absent, non-string, or names an unknown package), and `POST` persists it and
 * redirects back to the page with a `notice=activated` flash.
 *
 * The page is deliberately thin over the injected {@link ThemePackageRegistry}
 * and {@link ContentRepository}: it owns no theme discovery, no persistence, and
 * no activation semantics beyond what the registry already enforces. The only
 * mutation is `action=activate`; an unknown action, a missing `name`, or a name
 * that is not in the registry yields a value-free 400 that never echoes the
 * submitted input.
 */

import { h, type ComponentChild } from 'preact';

import {
  adminBadRequestResponse,
  adminRedirectResponse,
  defineAdminPage,
  defineAdminPlugin,
  renderAdminDocumentWithTheme,
  type AdminPage,
  type AdminPagePostContext,
  type AdminPageRenderContext,
  type AdminPlugin,
} from '@jsails/admin';
import { type ThemePackage, type ThemePackageRegistry } from '@jsails/theme';
import { type ContentRepository } from './content/index.js';

/** The `notice` query value rendered on `GET` after a successful activation. */
export const THEME_ACTIVATED_NOTICE = 'activated';

/** The default setting key holding the persisted active theme name. */
const DEFAULT_SETTING_KEY = 'theme.active';

/** Page slug, label, and navigation group for the themes admin page. */
const PAGE_SLUG = 'themes';
const PAGE_LABEL = 'Themes';
const PAGE_GROUP = 'Content';

/** Options for {@link blogThemeAdmin}. */
export interface BlogThemeAdminOptions {
  /** The registry listing and activating theme packages. */
  readonly registry: ThemePackageRegistry;
  /** The repository persisting the active-theme setting. */
  readonly repository: ContentRepository;
  /** The setting key holding the active theme name. Defaults to `theme.active`. */
  readonly settingKey?: string;
  /**
   * The page path under the panel base path. Defaults to the panel's
   * `context.path`.
   */
  readonly path?: string;
}

/** The page path (`<panel>/themes`) for a given base path. */
function pagePath(base: string): string {
  return base === '' || base === '/' ? `/${PAGE_SLUG}` : `${base}/${PAGE_SLUG}`;
}

/**
 * Build the blog theme admin plugin. A single page (slug `themes`) is
 * registered with the plugin id `blog-themes`; the descriptor is inert until
 * `adminPlugin` invokes its `register`.
 */
export function blogThemeAdmin(options: BlogThemeAdminOptions): AdminPlugin {
  const settingKey = options.settingKey ?? DEFAULT_SETTING_KEY;
  return defineAdminPlugin({
    id: 'blog-themes',
    register(builder) {
      builder.addPage(themesPage(options.registry, options.repository, settingKey, options.path));
    },
  });
}

/** Build the themes {@link AdminPage} over the injected registry/repository. */
function themesPage(
  registry: ThemePackageRegistry,
  repository: ContentRepository,
  settingKey: string,
  path?: string,
): AdminPage {
  return defineAdminPage({
    slug: PAGE_SLUG,
    label: PAGE_LABEL,
    group: PAGE_GROUP,
    render: (context) => renderThemesPage(context, registry, repository, settingKey, path),
    handlePost: (context) => handleActivate(context, registry, repository, settingKey, path),
  });
}

/** Resolve the persisted active theme name against the registry, else fall back. */
async function resolveActiveName(
  repository: ContentRepository,
  registry: ThemePackageRegistry,
  settingKey: string,
): Promise<string | undefined> {
  const setting = await repository.getSetting(settingKey);
  if (setting !== undefined && typeof setting.value === 'string' && registry.get(setting.value)) {
    return setting.value;
  }
  return registry.activeName();
}

/** Render the full `GET` document: theme list, active badge, and Activate forms. */
async function renderThemesPage(
  context: AdminPageRenderContext,
  registry: ThemePackageRegistry,
  repository: ContentRepository,
  settingKey: string,
  path?: string,
): Promise<string> {
  const activeName = await resolveActiveName(repository, registry, settingKey);
  const packages = registry.list();
  const notice =
    context.url.searchParams.get('notice') === THEME_ACTIVATED_NOTICE ? 'Theme activated.' : null;
  const actionPath = pagePath(path ?? context.path);

  const body: ComponentChild[] = [
    h('h1', null, PAGE_LABEL),
    ...(notice === null ? [] : [h('p', { role: 'status' }, notice)]),
  ];

  if (packages.length === 0) {
    body.push(h('p', null, 'No themes are registered.'));
  } else {
    body.push(
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, 'Name'),
            h('th', null, 'Version'),
            h('th', null, 'Parent'),
            h('th', null, 'Description'),
            h('th', null, ''),
          ),
        ),
        h(
          'tbody',
          null,
          ...packages.map((pkg: ThemePackage) =>
            themeRow(pkg, pkg.name === activeName, actionPath, context),
          ),
        ),
      ),
    );
  }

  return renderAdminDocumentWithTheme(
    {
      title: PAGE_LABEL,
      theme: context.theme,
      themeCustomization: context.themeCustomization,
      themeTokens: context.themeTokens,
    },
    ...body,
  );
}

/** One table row: name, version, description, and either a badge or an Activate form. */
function themeRow(
  pkg: ThemePackage,
  active: boolean,
  actionPath: string,
  context: AdminPageRenderContext,
): ComponentChild {
  return h(
    'tr',
    null,
    h('td', null, pkg.name),
    h('td', null, pkg.version),
    h('td', null, pkg.parent ?? '—'),
    h('td', null, pkg.description ?? ''),
    h(
      'td',
      null,
      active
        ? h('span', { class: 'admin-badge' }, 'Active')
        : activateForm(actionPath, pkg.name, context),
    ),
  );
}

/** The per-theme Activate form: a CSRF-carrying `action=activate` POST with a hidden name. */
function activateForm(
  actionPath: string,
  name: string,
  context: AdminPageRenderContext,
): ComponentChild {
  return h(
    'form',
    { method: 'post', action: actionPath },
    h('input', { type: 'hidden', name: '_csrf', value: context.session.csrfToken }),
    h('input', { type: 'hidden', name: 'action', value: 'activate' }),
    h('input', { type: 'hidden', name: 'name', value: name }),
    h('button', { type: 'submit' }, 'Activate'),
  );
}

/** Handle the `POST`: persist the requested theme and redirect with a notice. */
async function handleActivate(
  context: AdminPagePostContext,
  registry: ThemePackageRegistry,
  repository: ContentRepository,
  settingKey: string,
  path?: string,
): Promise<Response> {
  if (context.body['action'] !== 'activate') {
    return adminBadRequestResponse();
  }

  const name = context.body['name'];
  if (typeof name !== 'string' || registry.get(name) === undefined) {
    return adminBadRequestResponse();
  }

  await repository.setSetting(settingKey, name);

  return adminRedirectResponse(
    `${pagePath(path ?? context.path)}?notice=${THEME_ACTIVATED_NOTICE}`,
  );
}
