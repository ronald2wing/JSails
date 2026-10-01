/**
 * Request-time theme resolution for the public surface.
 *
 * The app builds one theme registry in `jsails.app.js` and hands it to
 * `blogThemeAdmin`, which persists the chosen active theme as the `theme.active`
 * setting through the shared `ContentRepository`. This helper closes the loop
 * for the *public* pages: `loadThemeCss` reads that persisted setting on a live
 * request and returns the active theme's serialized CSS custom properties, so
 * the admin selection visibly reaches `/blog` and every other page that opts in.
 *
 * It never throws outward: a static export has no services and no database, a
 * fresh app has no `theme.active` yet, and the blog plugin may not even be
 * installed (the admin/saas web shapes ship this file without `@jsails/blog`).
 * Every one of those cases degrades to the registry's default theme rather than
 * failing the request, so a page can always render.
 */

import type { RequestContext } from 'jsails';
import { blogRepositoryToken } from '@jsails/blog';
import {
  builtinThemePackages,
  createThemeRegistry,
  renderThemeTemplate,
  type ThemePackage,
  type ThemePackageRegistry,
} from '@jsails/theme';

/** The setting key `blogThemeAdmin` persists the active theme name under. */
const ACTIVE_THEME_SETTING_KEY = 'theme.active';

/**
 * The registry every variant seeds identically from the built-in first-party
 * theme packages (`neutral` default, `night` dark). Building it here — rather
 * than importing the app config's instance — keeps public pages independent of
 * the app wiring and lets the default render without any service lookup.
 */
const defaultRegistry: ThemePackageRegistry = createThemeRegistry({
  packages: builtinThemePackages,
});

/**
 * Resolve the active theme's CSS for one request. Live requests activate the
 * persisted `theme.active` name; static exports, a missing repository, an
 * absent/unknown setting, and any lookup failure all fall back to the default
 * theme. The returned string is `:root` + per-theme `[data-theme]` CSS ready to
 * inline in the document `<head>`.
 */
/** The active blog theme package, with parent inheritance already resolved. */
export async function loadTheme(context: RequestContext): Promise<ThemePackage> {
  if (context.renderMode === 'static' || context.services === undefined) {
    return defaultRegistry.resolveActive()!;
  }
  try {
    const repository = context.services.tryGet(blogRepositoryToken);
    const setting =
      repository === undefined ? undefined : await repository.getSetting(ACTIVE_THEME_SETTING_KEY);
    if (setting !== undefined && typeof setting.value === 'string') {
      // A stale/unknown name makes `activate` throw; the enclosing try/catch
      // turns that into the default theme rather than a failed request.
      return defaultRegistry.activate(setting.value).resolveActive()!;
    }
  } catch {
    // Any failure (missing plugin, closed registry, database error) degrades to
    // the default theme; the page must still render.
  }
  return defaultRegistry.resolveActive()!;
}

/** Header/footer HTML for a themed blog request. */
export interface ThemeChrome {
  readonly header?: string;
  readonly footer?: string;
}

/** Render the active theme's header/footer with the starter's trusted slots. */
export function renderThemeChrome(theme: ThemePackage): ThemeChrome {
  const nav = '<a href="/blog">Blog</a><a href="/">Home</a><a href="/about">About</a>';
  const header =
    theme.layouts.header === undefined
      ? undefined
      : renderThemeTemplate(theme.layouts.header, {
          siteName: 'JSails',
          navigation: nav,
          actions: '<a href="/dashboard">Dashboard</a><a href="/login">Sign in</a>',
        });
  const footer =
    theme.layouts.footer === undefined
      ? undefined
      : renderThemeTemplate(theme.layouts.footer, {
          copyright: 'JSails — a blog built with Jello Elementor.',
          navigation: nav,
        });
  return {
    ...(header === undefined ? {} : { header }),
    ...(footer === undefined ? {} : { footer }),
  };
}

/** Token CSS plus the active theme's own scoped CSS. */
function themeCss(theme: ThemePackage): string {
  return `${defaultRegistry.activate(theme.name).toCss()}\n${theme.css}`;
}

/** Resolve the active theme's CSS for one request. */
export async function loadThemeCss(context: RequestContext): Promise<string> {
  return themeCss(await loadTheme(context));
}
