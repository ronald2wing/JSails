/**
 * Route path resolution shared by the page and API registrars.
 *
 * A route answers its bare manifest path(s) plus locale-prefixed aliases when
 * `i18n.locales` is configured. Both registrars must agree on that set, so the
 * expansion lives here rather than in either route module.
 */

import { localePrefixPaths, routeToHonoPaths, type RouteManifestEntry } from '../routing/routes.js';

/** Locale routing options resolved from the app's i18n config. */
export interface LocaleRouteOptions {
  readonly locales: readonly string[];
  readonly defaultLocale?: string;
}

/** Every Hono path a route answers, including locale-prefixed aliases. */
export function resolveRoutePaths(
  entry: RouteManifestEntry,
  localeOptions?: LocaleRouteOptions,
): readonly string[] {
  const bare = routeToHonoPaths(entry);
  if (localeOptions === undefined || localeOptions.locales.length === 0) return bare;
  return [...bare, ...localePrefixPaths(entry, localeOptions.locales, localeOptions.defaultLocale)];
}
