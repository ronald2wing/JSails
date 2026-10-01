/**
 * Admin plugin: turns a frozen {@link AdminPanel} descriptor into a first-party
 * {@link JsailsPlugin} named `admin`.
 *
 * This module is the assembly seam: `adminPlugin(panel)` returns the plugin via
 * `definePlugin`; its `setup` resolves the concrete session resolver, collects
 * every contribution (the panel's own `pages`, `resources`, `widgets`, and
 * `notices` plus anything each `adminPlugins` entry registers through its
 * builder), then wires the trusted HTTP hook that mounts, under `panel.path`,
 * the dashboard, the global search page, each page's routes, each resource's
 * CRUD and action routes, and the catch-all 404. Route registration itself
 * lives under `routes/`: `pages.ts` (dashboard, search, pages, catch-all),
 * `resources/` (CRUD), `actions.ts` (confirm-then-run actions), and
 * `relations.ts` (relation managers); the allowlisted list-query parsing lives
 * in `list-query.ts`.
 *
 * The plugin is ORM-free and never touches the filesystem or network until a
 * request reaches a route that needs it.
 */

import { definePlugin, type JsailsPlugin, type ServiceRegistrar } from 'jsails/extensions';
import { themeToken, type ThemeResolution } from '@jsails/theme';

import type { AdminNavigationItem, AdminPluginBuilder } from './admin-plugin.js';
import {
  hasShape,
  NAVIGATION_ITEM_SHAPE,
  PAGE_SHAPE,
  RESOURCE_SHAPE,
  type DescriptorShape,
} from './descriptor-shape.js';
import { AdminDefinitionError } from './errors.js';
import type { AdminPage } from './page.js';
import type { AdminPanel } from './panel.js';
import type { Resource } from './resource/index.js';
import { registerAdminNotFound, registerAdminRoutes, type Contributions } from './routes/pages.js';
import { registerResourceRoutes } from './routes/resources/index.js';

/**
 * Build the `admin` plugin from a frozen panel descriptor. The panel is
 * captured by reference; contribution collection and route registration are
 * deferred to `setup` so nothing is mounted until the application assembles
 * the extension's HTTP hooks.
 *
 * When the panel is built from `auth` (rather than a `resolveSession` callback)
 * the plugin declares `requires: [panel.auth]`, so the `auth` plugin must be
 * declared earlier; the extension runner fails with a value-free error
 * otherwise. `setup` then derives the concrete resolver from the auth service
 * and routes the resolved panel, so every route reads `panel.resolveSession`
 * unchanged.
 */
export function adminPlugin(panel: AdminPanel): JsailsPlugin {
  return definePlugin({
    name: 'admin',
    requires: panel.auth === undefined ? [] : [panel.auth],
    setup({ services, configureHttp }) {
      const resolvedPanel = resolvePanel(panel, services);
      const contributions = collectContributions(resolvedPanel);
      configureHttp((app) => {
        registerAdminRoutes(app, resolvedPanel, contributions);
        for (const resource of contributions.resources) {
          registerResourceRoutes(app, resolvedPanel, resource);
        }
        registerAdminNotFound(app, resolvedPanel);
      });
    },
  });
}

/**
 * Derive a concrete session resolver when the panel was built from `auth`,
 * and attach the theme-token service when the `theme` plugin is present.
 *
 * A panel built with a `resolveSession` callback keeps it; a panel built with
 * `auth` resolves the service from the registry (guaranteed by `requires`) and
 * wraps its `resolveSession`. A panel with neither cannot occur
 * (`defineAdminPanel` enforces exactly one) but fails closed anyway.
 */
function resolvePanel(panel: AdminPanel, services: ServiceRegistrar): AdminPanel {
  let resolved = panel;

  if (panel.resolveSession === undefined) {
    const auth = panel.auth;
    if (auth === undefined) {
      throw new AdminDefinitionError(
        'invalid_panel',
        'admin panel is missing both resolveSession and auth',
      );
    }
    const service = services.get(auth);
    resolved = {
      ...resolved,
      resolveSession: (request) => service.resolveSession(request),
    };
  }

  // The theme service is optional: without it the document renderer falls
  // back to the hardcoded light/dark base. Its full stylesheet (active `:root`
  // plus per-named-theme `[data-theme]` blocks) is emitted by the renderer,
  // while `themeCustomization.css`/`tokens` stay the app's own raw overrides.
  const themeService: ThemeResolution | undefined = services.tryGet(themeToken);
  if (themeService !== undefined) {
    resolved = { ...resolved, themeTokens: themeService };
  }

  return resolved;
}

/** Collect panel + plugin contributions and enforce slug uniqueness. */
function collectContributions(panel: AdminPanel): Contributions {
  const pages: AdminPage[] = [...(panel.pages ?? [])];
  const resources: Resource[] = [...(panel.resources ?? [])];
  const navItems: AdminNavigationItem[] = [];

  for (const plugin of panel.adminPlugins ?? []) {
    const builder: AdminPluginBuilder = {
      addPage(page) {
        assertContribution(page, PAGE_SHAPE, 'admin page contributions must be page descriptors');
        pages.push(page);
      },
      addNavigationItem(item) {
        assertContribution(
          item,
          NAVIGATION_ITEM_SHAPE,
          'admin navigation contributions must be navigation items',
        );
        navItems.push(item);
      },
      addResource(resource) {
        assertContribution(
          resource,
          RESOURCE_SHAPE,
          'admin resource contributions must be resource descriptors',
        );
        resources.push(resource);
      },
    };
    plugin.register(builder);
  }

  assertUniqueSlugs(pages, resources);
  return { pages, resources, navItems };
}

/** Reject a structurally invalid contribution with a value-free error. */
function assertContribution(value: unknown, shape: DescriptorShape, message: string): void {
  if (!hasShape(value, shape)) {
    throw new AdminDefinitionError('invalid_contribution', message);
  }
}

/** Reject a slug shared by two pages, two resources, or a page and a resource (one path). */
function assertUniqueSlugs(pages: readonly AdminPage[], resources: readonly Resource[]): void {
  const seen = new Set<string>();
  for (const slug of [...pages.map((page) => page.slug), ...resources.map((r) => r.slug)]) {
    if (seen.has(slug)) {
      throw new AdminDefinitionError(
        'duplicate_name',
        'admin page and resource slugs must be unique',
      );
    }
    seen.add(slug);
  }
}
