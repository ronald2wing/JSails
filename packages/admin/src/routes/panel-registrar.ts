/**
 * How the panel registers its routes: every route is a registrar route
 * (`routes.add`) of surface kind `admin` that accepts the session cookie
 * only, whose access is the panel's session gate.
 *
 * {@link panelRegistrar} wraps the plugin's registrar for one panel. Each
 * route's access resolves the session through the panel's `resolveSession`
 * and admits it only when it is a browser (cookie) session that
 * `panel.authorize` allows with exactly `true` (`assertAdminSession`), and,
 * for a contributed page's routes, that the page's own `authorize` allows
 * too. Core's access chain runs that check, after refusing an unsafe request
 * from another origin, before the handler runs or a body byte is read; a
 * denial is core's uniform answer (401 without a session, 403 with one),
 * sent `no-store` and without cookies. Checks that depend on a record (a
 * resource's `view` of one id, an action's visibility) stay in the handlers.
 *
 * A `POST` route declares the form it reads: `form` up to its `maxBodyBytes`
 * (the panel default is 1 MiB), so a resource whose file fields accept
 * larger uploads states a cap that admits them.
 */

import type { Session } from 'jsails';
import type { HttpRoutes, RouteAccess, RouteContext } from 'jsails/kernel';

import { reportAdminError } from '../error-report.js';
import { assertAdminSession } from '../guards.js';
import type { AdminPage } from '../page.js';
import type { AdminPanel } from '../panel.js';

/** The form cap of a panel `POST` route that states none: 1 MiB. */
export const ADMIN_FORM_BYTES: number = 1024 * 1024;

/** A panel route's handler: the route's request context in, the answer out. */
export type AdminRouteHandler = (context: RouteContext) => Promise<Response>;

/** What one panel route states beyond its path and handler. */
export interface AdminRouteOptions {
  /** The contributed page the route serves: its own `authorize` joins the access. */
  readonly page?: AdminPage;
  /** Milliseconds the route has to answer (`0`: none); absent, the app's deadline. */
  readonly timeoutMs?: number;
  /** The largest form a `POST` route reads, in bytes; absent, {@link ADMIN_FORM_BYTES}. */
  readonly maxBodyBytes?: number;
}

/** Registers one panel's routes. */
export interface PanelRegistrar {
  readonly panel: AdminPanel;
  get(path: string, handler: AdminRouteHandler, options?: AdminRouteOptions): void;
  post(path: string, handler: AdminRouteHandler, options?: AdminRouteOptions): void;
}

/** The registrar of `panel`'s routes over the plugin's `routes`. */
export function panelRegistrar(routes: HttpRoutes, panel: AdminPanel): PanelRegistrar {
  const sessionGate = panelAccess(panel);
  const accessOf = (page: AdminPage | undefined): RouteAccess =>
    page === undefined ? sessionGate : panelAccess(panel, page);
  return {
    panel,
    get(path, handler, options = {}) {
      routes.add({
        methods: ['GET'],
        path,
        access: accessOf(options.page),
        surface: 'admin',
        credentials: ['cookie'],
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        handler,
      });
    },
    post(path, handler, options = {}) {
      routes.add({
        methods: ['POST'],
        path,
        access: accessOf(options.page),
        surface: 'admin',
        credentials: ['cookie'],
        body: { kind: 'form', maxBytes: options.maxBodyBytes ?? ADMIN_FORM_BYTES },
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        handler,
      });
    },
  };
}

/**
 * The access of a panel route: an admitted admin session, and, for a page's
 * routes, the page's own allowance.
 */
function panelAccess(panel: AdminPanel, page?: AdminPage): RouteAccess {
  return async (context) => {
    const session = await assertAdminSession(panel, context.request);
    if (session === null) return false;
    return page === undefined || (await pageAllowed(panel, page, session));
  };
}

/**
 * Run a page's own `authorize` (deny when it declares none). Only an exact
 * `true` allows; a throw denies and is reported.
 */
export async function pageAllowed(
  panel: AdminPanel,
  page: AdminPage,
  session: Session,
): Promise<boolean> {
  if (page.authorize === undefined) {
    return false;
  }
  try {
    return (await page.authorize({ session, slug: page.slug })) === true;
  } catch (error) {
    reportAdminError(panel, error, { surface: 'page', slug: page.slug, operation: 'authorize' });
    return false;
  }
}
