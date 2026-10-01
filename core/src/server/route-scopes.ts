/**
 * Extension request scopes applied around framework-served routes.
 *
 * An extension registers a {@link RequestScope} through
 * `configureRequestScope`; `createApp` composes every registered scope into
 * one {@link RouteScopeRunner} and applies it to each route kind it serves:
 * the page and API chains (right after the lifecycle signals settle the
 * session), the server-components transport handlers, and every route an HTTP
 * extension hook registers. The global middleware chain cannot do this: it
 * runs only inside page and API chains, after `authorize`, so an ambient value
 * set there never reached the component transport or hook routes.
 *
 * The runner is applied per route, never through a catch-all `app.use`, so a
 * request no route claims (a public file, a 404, the health probe) pays for no
 * scope. It runs at most once per request: a hook route nested under another
 * scoped handler, or a page chain reached through one, passes straight through.
 *
 * Hook routes are scoped by wrapping each handler the hook adds to the router
 * while it runs. Handlers a hook adds with `app.use` stay unwrapped: they are
 * middleware in front of every later route, and wrapping them would scope
 * requests no route claims. A handler a hook keeps a reference to and
 * registers after it returns is not scoped.
 */

import type { Hono } from 'hono';

import type { HttpExtensionHook, RequestScope } from '../extensions/extension.js';
import { JsailsError } from '../errors/jsails-error.js';
import type { AppContext, AppEnv } from './env.js';
import { ensureRequestSession } from './request-pipeline.js';

/** The typed Hono app used throughout the server assembly. */
type App = Hono<AppEnv>;

/** Stable failure codes carried by {@link RequestScopeError}. */
export type RequestScopeErrorCode = 'missing_next' | 'invalid_next';

/** A request scope did not call `next()` exactly once. */
export class RequestScopeError extends JsailsError {
  constructor(readonly code: RequestScopeErrorCode) {
    super(
      code === 'missing_next'
        ? 'a request scope returned without calling next()'
        : 'a request scope called next() more than once',
    );
  }
}

/**
 * Run `inner` inside every registered scope, outermost first, and return what
 * `inner` returned. With no scopes, or when this request is already scoped, it
 * calls `inner` directly.
 */
export type RouteScopeRunner = <T>(c: AppContext, inner: () => Promise<T>) => Promise<T>;

/** Validate the `requestScopes` option: an array of functions. */
export function resolveRequestScopes(value: unknown): readonly RequestScope[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError('requestScopes must be an array of functions');
  }
  for (const scope of value) {
    if (typeof scope !== 'function') {
      throw new TypeError('requestScopes entries must be functions');
    }
  }
  return Object.freeze([...(value as readonly RequestScope[])]);
}

/** Compose `scopes` (registration order, first outermost) into one runner. */
export function createRouteScopeRunner(scopes: readonly RequestScope[]): RouteScopeRunner {
  return async <T>(c: AppContext, inner: () => Promise<T>): Promise<T> => {
    if (scopes.length === 0 || c.var.requestScoped === true) return inner();
    c.set('requestScoped', true);
    await ensureRequestSession(c);
    let result: T | undefined;
    const enter = async (index: number): Promise<void> => {
      const scope = scopes[index];
      if (scope === undefined) {
        result = await inner();
        return;
      }
      let called = false;
      await scope(c, () => {
        if (called) return Promise.reject(new RequestScopeError('invalid_next'));
        called = true;
        return enter(index + 1);
      });
      if (!called) throw new RequestScopeError('missing_next');
    };
    await enter(0);
    // Every scope called `next()` (or `enter` threw), so `inner` ran and set it.
    return result as T;
  };
}

/** A Hono handler as the router stores it: `(c, next) => result`. */
type RouterHandler = (c: AppContext, next: () => Promise<void>) => unknown;

/**
 * Run `hook` against `app` with every non-`use` handler it registers wrapped in
 * `runScopes`. The router and `app.use` are restored whatever the hook does.
 */
export async function runScopedHook(
  app: App,
  hook: HttpExtensionHook,
  runScopes: RouteScopeRunner,
): Promise<void> {
  const router = app.router;
  const add = router.add;
  const use = app.use;
  let insideUse = 0;
  router.add = (method, path, entry) => {
    if (insideUse > 0) return add.call(router, method, path, entry);
    const [handler, route] = entry;
    const original = handler as RouterHandler;
    const scoped: RouterHandler = (c, next) => runScopes(c, async () => original(c, next));
    return add.call(router, method, path, [scoped as typeof handler, route]);
  };
  app.use = ((...args: Parameters<App['use']>) => {
    insideUse += 1;
    try {
      use(...args);
    } finally {
      insideUse -= 1;
    }
    return app;
  }) as App['use'];
  try {
    await hook(app);
  } finally {
    router.add = add;
    app.use = use;
  }
}
