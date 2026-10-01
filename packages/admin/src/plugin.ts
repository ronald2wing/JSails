/**
 * Admin plugin: turns a frozen {@link AdminPanel} descriptor into a first-party
 * {@link JsailsPlugin} named `admin`.
 *
 * This module is the assembly seam: `adminPlugin(panel)` returns the plugin via
 * `definePlugin`; its `setup` resolves the concrete session resolver, collects
 * every contribution (the panel's own `pages`, `resources`, `widgets`, and
 * `notices` plus anything each `adminPlugins` entry registers through its
 * builder), then registers, through the plugin's registrar and under
 * `panel.path`, the dashboard, the global search page, each page's routes,
 * each resource's CRUD and action routes, and the catch-all 404, each an
 * `admin` surface behind the panel's session gate (`routes/panel-registrar.ts`).
 * Route registration itself lives under `routes/`: `pages.ts` (dashboard,
 * search, pages, catch-all),
 * `resources/` (CRUD), `actions.ts` (confirm-then-run actions), and
 * `relations.ts` (relation managers); the allowlisted list-query parsing lives
 * in `list-query.ts`.
 *
 * The plugin is ORM-free and never touches the filesystem or network until a
 * request reaches a route that needs it.
 */

import { diagnosticsToken } from 'jsails/diagnostics';
import {
  definePlugin,
  type JsailsPlugin,
  type ServiceRegistrar,
  type ServiceToken,
} from 'jsails/extensions';
import { themeToken, type ThemeResolution } from '@jsails/theme';

import type { AdminNavigationItem, AdminPluginBuilder } from './admin-plugin.js';
import {
  hasShape,
  NAVIGATION_ITEM_SHAPE,
  PAGE_SHAPE,
  RESOURCE_SHAPE,
  resolveRequires,
  type DescriptorShape,
} from './descriptor-shape.js';
import { describeAdminFailure } from './error-report.js';
import { AdminDefinitionError } from './errors.js';
import type { AdminPage } from './page.js';
import type { AdminPanel } from './panel.js';
import type { Resource } from './resource/index.js';
import { collectRelationOwners } from './routes/actions.js';
import { registerAdminNotFound, registerAdminRoutes, type Contributions } from './routes/pages.js';
import { panelRegistrar } from './routes/panel-registrar.js';
import { registerResourceRoutes } from './routes/resources/index.js';

/**
 * Build the `admin` plugin from a frozen panel descriptor. The panel is
 * captured by reference; contribution collection and route registration are
 * deferred to `setup`, and the application compiles the registered routes
 * when it assembles.
 *
 * The plugin requires the panel's `auth` service when the panel is built from
 * `auth` (rather than a `resolveSession` callback), and every service a page
 * in `pages` or an `adminPlugins` entry declares in its `requires`, so their
 * providers run first and a missing one fails at boot with a value-free error
 * instead of on the first request. `setup` then derives the concrete resolver
 * from the auth service and routes the resolved panel, so every route reads
 * `panel.resolveSession` unchanged; a page an admin plugin contributes whose
 * own `requires` names a service nothing registered fails setup.
 */
export function adminPlugin(panel: AdminPanel): JsailsPlugin {
  return definePlugin({
    name: 'admin',
    requires: panelRequires(panel),
    setup({ services, routes }) {
      const resolvedPanel = resolvePanel(panel, services);
      const contributions = collectContributions(resolvedPanel);
      assertPageServices(contributions.pages, services);
      const owners = collectRelationOwners(contributions.resources);
      const registrar = panelRegistrar(routes, resolvedPanel);
      registerAdminRoutes(registrar, contributions);
      for (const resource of contributions.resources) {
        registerResourceRoutes(registrar, resource, owners);
      }
      registerAdminNotFound(registrar);
    },
  });
}

/**
 * The services the panel declares it reads, each once, in declaration order.
 * A hand-built page or plugin descriptor's `requires` is checked here too.
 */
function panelRequires(panel: AdminPanel): readonly ServiceToken<unknown>[] {
  return [
    ...new Set([
      ...(panel.auth === undefined ? [] : [panel.auth]),
      ...(panel.pages ?? []).flatMap(
        (page) => resolveRequires(page.requires, 'invalid_page', 'admin page') ?? [],
      ),
      ...(panel.adminPlugins ?? []).flatMap(
        (plugin) => resolveRequires(plugin.requires, 'invalid_admin_plugin', 'admin plugin') ?? [],
      ),
    ]),
  ];
}

/** Refuse a collected page whose declared service was never registered. */
function assertPageServices(pages: readonly AdminPage[], services: ServiceRegistrar): void {
  for (const page of pages) {
    const requires = resolveRequires(page.requires, 'invalid_contribution', 'admin page') ?? [];
    if (requires.some((token) => !services.has(token))) {
      throw new AdminDefinitionError(
        'missing_service',
        "an admin page requires a service no plugin provided; declare it in the admin plugin's requires",
      );
    }
  }
}

/**
 * Derive a concrete session resolver when the panel was built from `auth`,
 * attach the theme-token service when the `theme` plugin is present, and,
 * when the panel has no `onError`, report failures to the `diagnostics`
 * service (an `exception` entry) as well as stderr when that service exists.
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

  const diagnostics = panel.onError === undefined ? services.tryGet(diagnosticsToken) : undefined;
  if (diagnostics !== undefined) {
    resolved = {
      ...resolved,
      onError: (error, context) => {
        const line = describeAdminFailure(error, context);
        diagnostics.record({
          type: 'exception',
          data: {
            source: 'admin',
            surface: context.surface,
            ...(context.operation === undefined ? {} : { operation: context.operation }),
            ...(context.slug === undefined ? {} : { slug: context.slug }),
            message: line,
          },
        });
        console.error(line);
      },
    };
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
