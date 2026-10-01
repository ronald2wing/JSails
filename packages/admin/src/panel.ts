/**
 * Admin panel descriptor: the immutable configuration for one administration
 * surface.
 *
 * `defineAdminPanel(options)` validates the panel options (base path, title,
 * the trusted session resolver, the default-deny authorization callback, the
 * optional pages/resources, and the optional admin plugins) and returns a
 * frozen {@link AdminPanel} descriptor. The descriptor is inert: it carries
 * callbacks by identity and is only consumed by {@link adminPlugin}, which
 * mounts the actual HTTP surface.
 *
 * The base path is validated eagerly so a malformed path fails at construction
 * time rather than surfacing as a broken Hono route later: it must be an
 * absolute path (leading `/`), must not be `/` or end with `/`, must not use
 * the reserved `/_jsails` namespace, and must not contain a backslash, control
 * characters, or a doubled slash. Every failure raises a value-free
 * {@link AdminDefinitionError} (`invalid_panel`); the invalid path is never
 * echoed.
 *
 * The module is ORM-free: it imports only the session contract plus the page,
 * resource, and admin-plugin descriptor types (all types) and performs no I/O.
 */

import type { Session } from 'jsails';
import type { ServiceToken } from 'jsails/extensions';
import { isRecord } from 'jsails/plugin-sdk';
import { CONTROL_CHARS } from 'jsails/support';
import type { ThemeResolution } from '@jsails/theme';

import type { AdminPlugin } from './admin-plugin.js';
import type { Chart } from './charts.js';
import {
  ADMIN_PLUGIN_SHAPE,
  CARD_SHAPE,
  NOTICE_SHAPE,
  PAGE_SHAPE,
  RESOURCE_SHAPE,
  resolveUniqueList,
} from './descriptor-shape.js';
import { AdminDefinitionError } from './errors.js';
import type { Notice } from './notices.js';
import type { AdminPage } from './page.js';
import type { Resource } from './resource/index.js';
import type { Widget } from './widgets.js';

/** Trusted session resolver for the admin auth gate. */
export type AdminPanelResolveSession = (
  request: Request,
) => Session | null | Promise<Session | null>;

/**
 * The slice of a session service the admin gate consumes. `@jsails/auth`'s
 * `AuthSessionService` satisfies it structurally, so the panel can take that
 * plugin's `authSessionToken` without admin depending on the auth package.
 */
export interface AdminSessionService {
  readonly resolveSession: AdminPanelResolveSession;
}

/**
 * The admin document theme. `'system'` (the default) leaves the browser's own
 * color scheme in control; `'light'` and `'dark'` force a scheme by setting the
 * matching `data-theme` attribute on the document.
 */
export type AdminTheme = 'light' | 'dark' | 'system';

/** The recognized admin themes, in a stable order. */
export const ADMIN_THEMES = Object.freeze(['light', 'dark', 'system'] as const);

/**
 * Default-deny authorization for the admin surface. The request is served only
 * when the callback resolves to exactly `true`; a truthy non-boolean, a throw,
 * or a rejection all deny. It receives the resolved session, which is `null`
 * when the resolver returned nothing or failed.
 */
export type AdminPanelAuthorize = (session: Session | null) => boolean | Promise<boolean>;

/** Options for {@link defineAdminPanel}. */
export interface AdminPanelOptions {
  /** Admin base path; defaults to {@link DEFAULT_ADMIN_PATH}. */
  readonly path?: string;
  /** Admin document title; defaults to {@link DEFAULT_ADMIN_TITLE}. */
  readonly title?: string;
  /**
   * Admin document theme; defaults to {@link DEFAULT_ADMIN_THEME} (`'system'`).
   * Rendered as the document's `data-theme` attribute plus minimal light/dark
   * CSS variables; no client bundle is involved.
   */
  readonly theme?: AdminTheme;
  /**
   * Custom theme CSS / token overrides appended after the default theme CSS so
   * they win on equal specificity. Both `css` and `tokens` are optional; omit
   * the entire object to keep the default theme unchanged.
   */
  readonly themeCustomization?: AdminThemeCustomization;
  /**
   * Trusted session resolver for the auth gate. Exactly one of `resolveSession`
   * or {@link AdminPanelOptions.auth} is required.
   */
  readonly resolveSession?: AdminPanelResolveSession;
  /**
   * Auth session service to derive the session resolver from (the first-party
   * `auth` plugin's `authSessionToken`). Exactly one of `resolveSession`
   * or `auth` is required.
   */
  readonly auth?: ServiceToken<AdminSessionService>;
  /** Default-deny authorization; allow only on an exact `true`. */
  readonly authorize: AdminPanelAuthorize;
  /** Server-rendered page descriptors mounted under the panel path. */
  readonly pages?: readonly AdminPage[];
  /** Admin plugins whose contributions (pages/resources/navigation) are mounted. */
  readonly adminPlugins?: readonly AdminPlugin[];
  /** Resource CRUD descriptors mounted under the panel path. */
  readonly resources?: readonly Resource[];
  /** Dashboard stat-card widgets. */
  readonly widgets?: readonly Widget[];
  /** Dashboard SVG charts. */
  readonly charts?: readonly Chart[];
  /** Notice registry entries rendered from `?_notice=` query parameters. */
  readonly notices?: readonly Notice[];
  /**
   * Client script URLs emitted as `<script type="module" src="...">` in the
   * admin document head, after the style, in order. Each entry is a trusted,
   * non-empty string with no control characters. This is the seam for an
   * application to inject its client bundle (e.g. a rich-text editor island)
   * without the framework shipping one.
   */
  readonly clientScripts?: readonly string[];
}

/**
 * A map of CSS custom-property names to values, serialized into a `:root` rule.
 */
export type AdminThemeTokens = Readonly<Record<string, string>>;

/**
 * Custom theme CSS: a raw CSS string, a token map, or both (both are merged).
 * Custom rules are appended after the default theme CSS so they win on equal
 * specificity. Values are injected verbatim into a `<style>` tag, so a string
 * containing `</style` is a configuration error rather than something the
 * framework escapes: escaping would silently corrupt legitimate CSS and the
 * seam is a trusted config, so a value that can break out of the `<style>` tag
 * is rejected at construction with a value-free error.
 */
export interface AdminThemeCustomization {
  /** Raw CSS appended after the default theme CSS (custom wins on equal specificity). */
  readonly css?: string;
  /** CSS custom properties emitted as a `:root { --name: value; }` rule. */
  readonly tokens?: AdminThemeTokens;
}

/** A frozen, validated panel descriptor consumed by {@link adminPlugin}. */
export interface AdminPanel {
  /** Validated admin base path. */
  readonly path: string;
  /** Admin document title. */
  readonly title: string;
  /** Admin document theme. */
  readonly theme: AdminTheme;
  /** Custom theme CSS / token overrides. */
  readonly themeCustomization?: AdminThemeCustomization;
  /**
   * The resolved theme service (`@jsails/theme`), when the `theme` plugin is
   * present. Its full stylesheet, the `:root` active tokens plus per-named-theme
   * `[data-theme]` blocks, is emitted by the document renderer, so a plugin
   * theme (named themes, `[data-theme]` switching, seed derivation) renders in
   * the admin, not just the two hardcoded light/dark variables.
   */
  readonly themeTokens?: ThemeResolution;
  /** Trusted session resolver for the auth gate; absent when `auth` is set. */
  readonly resolveSession?: AdminPanelResolveSession;
  /** Auth session service the admin plugin resolves its session from, when set. */
  readonly auth?: ServiceToken<AdminSessionService>;
  /** Default-deny authorization; allow only on an exact `true`. */
  readonly authorize: AdminPanelAuthorize;
  /** Page descriptors, frozen when present. */
  readonly pages?: readonly AdminPage[];
  /** Admin plugin descriptors, frozen when present. */
  readonly adminPlugins?: readonly AdminPlugin[];
  /** Resource CRUD descriptors, frozen when present. */
  readonly resources?: readonly Resource[];
  /** Dashboard widgets, frozen when present. */
  readonly widgets?: readonly Widget[];
  /** Dashboard charts, frozen when present. */
  readonly charts?: readonly Chart[];
  /** Notice registry entries, frozen when present. */
  readonly notices?: readonly Notice[];
  /** Client script URLs, frozen when present. */
  readonly clientScripts?: readonly string[];
}

/** Default admin base path when `path` is omitted. */
export const DEFAULT_ADMIN_PATH = '/admin';

/** Default admin document title when `title` is omitted. */
export const DEFAULT_ADMIN_TITLE = 'Admin';

/** Default admin document theme when `theme` is omitted. */
export const DEFAULT_ADMIN_THEME: AdminTheme = 'system';

/** Raise the panel's value-free definition error. */
function invalid(message: string): AdminDefinitionError {
  return new AdminDefinitionError('invalid_panel', message);
}

/**
 * Validate panel options and return a frozen descriptor. Every descriptor
 * list is frozen too, so the descriptor is deeply immutable once returned.
 */
export function defineAdminPanel(options: AdminPanelOptions): AdminPanel {
  if (!isRecord(options)) {
    throw invalid('defineAdminPanel requires an options object');
  }
  const hasResolveSession = options.resolveSession !== undefined;
  const hasAuth = options.auth !== undefined;
  if (hasResolveSession === hasAuth) {
    throw invalid('admin panel requires exactly one of resolveSession or auth');
  }
  if (hasResolveSession && typeof options.resolveSession !== 'function') {
    throw invalid('admin resolveSession must be a function');
  }
  if (hasAuth && !isServiceToken(options.auth)) {
    throw invalid('admin auth must be a service token');
  }
  if (typeof options.authorize !== 'function') {
    throw invalid('admin authorize must be a function');
  }
  const themeCustomization = resolveThemeCustomization(options.themeCustomization);
  const pages = resolveUniqueList<AdminPage>(options.pages, {
    code: 'invalid_panel',
    label: 'admin pages',
    key: 'slug',
    shape: PAGE_SHAPE,
  });
  const adminPlugins = resolveUniqueList<AdminPlugin>(options.adminPlugins, {
    code: 'invalid_panel',
    label: 'admin adminPlugins',
    key: 'id',
    shape: ADMIN_PLUGIN_SHAPE,
  });
  const resources = resolveUniqueList<Resource>(options.resources, {
    code: 'invalid_panel',
    label: 'admin resources',
    key: 'slug',
    shape: RESOURCE_SHAPE,
  });
  const widgets = resolveUniqueList<Widget>(options.widgets, {
    code: 'invalid_panel',
    label: 'admin widgets',
    key: 'name',
    shape: CARD_SHAPE,
  });
  const charts = resolveUniqueList<Chart>(options.charts, {
    code: 'invalid_panel',
    label: 'admin charts',
    key: 'name',
    shape: CARD_SHAPE,
  });
  const notices = resolveUniqueList<Notice>(options.notices, {
    code: 'invalid_panel',
    label: 'admin notices',
    key: 'code',
    shape: NOTICE_SHAPE,
  });
  const clientScripts = resolveClientScripts(options.clientScripts);
  const panel: AdminPanel = {
    path: options.path === undefined ? DEFAULT_ADMIN_PATH : validatePath(options.path),
    title: options.title === undefined ? DEFAULT_ADMIN_TITLE : validateTitle(options.title),
    theme: resolveTheme(options.theme),
    authorize: options.authorize,
    ...(themeCustomization === undefined ? {} : { themeCustomization }),
    ...(hasResolveSession ? { resolveSession: options.resolveSession } : {}),
    ...(hasAuth ? { auth: options.auth } : {}),
    ...(pages === undefined ? {} : { pages }),
    ...(adminPlugins === undefined ? {} : { adminPlugins }),
    ...(resources === undefined ? {} : { resources }),
    ...(widgets === undefined ? {} : { widgets }),
    ...(charts === undefined ? {} : { charts }),
    ...(notices === undefined ? {} : { notices }),
    ...(clientScripts === undefined ? {} : { clientScripts }),
  };
  return Object.freeze(panel);
}

/** A service-token-shaped value: an object with a non-empty string `name`. */
function isServiceToken(value: unknown): value is ServiceToken<AdminSessionService> {
  return isRecord(value) && typeof value['name'] === 'string' && value['name'].trim() !== '';
}

/** Validate the base path, throwing a value-free error. */
function validatePath(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalid('admin path must be a string');
  }
  if (!value.startsWith('/')) {
    throw invalid('admin path must start with "/"');
  }
  if (value === '/') {
    throw invalid('admin path must not be "/"');
  }
  if (value.endsWith('/')) {
    throw invalid('admin path must not end with "/"');
  }
  if (value === '/_jsails' || value.startsWith('/_jsails/')) {
    throw invalid('admin path must not use the reserved /_jsails namespace');
  }
  if (value.includes('\\')) {
    throw invalid('admin path must not contain backslashes');
  }
  if (CONTROL_CHARS.test(value)) {
    throw invalid('admin path must not contain control characters');
  }
  if (value.includes('//')) {
    throw invalid('admin path must not contain "//"');
  }
  return value;
}

/** Validate the title, throwing a value-free error. */
function validateTitle(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid('admin title must be a non-empty string');
  }
  return value;
}

/** Validate the theme, defaulting to {@link DEFAULT_ADMIN_THEME}. */
function resolveTheme(value: unknown): AdminTheme {
  if (value === undefined) {
    return DEFAULT_ADMIN_THEME;
  }
  if (typeof value !== 'string' || !(ADMIN_THEMES as readonly string[]).includes(value)) {
    throw invalid('admin theme must be one of light, dark, or system');
  }
  return value as AdminTheme;
}

/** Validate the `themeCustomization` option, returning a frozen object or `undefined`. */
function resolveThemeCustomization(value: unknown): AdminThemeCustomization | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw invalid('admin themeCustomization must be an object');
  }
  const css = validateCustomCss(value['css']);
  const tokens = validateCustomTokens(value['tokens']);
  if (css === undefined && tokens === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(css === undefined ? {} : { css }),
    ...(tokens === undefined ? {} : { tokens }),
  });
}

/** Validate the raw CSS string; `undefined` is allowed (absent). */
function validateCustomCss(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalid('admin themeCustomization css must be a string');
  }
  if (CONTROL_CHARS.test(value)) {
    throw invalid('admin themeCustomization css must not contain control characters');
  }
  // Values are injected verbatim into a <style> element. Escaping would corrupt
  // legitimate CSS, and the seam is trusted config, so a string that can break
  // out of the tag is rejected as a configuration error.
  if (/<\/style/i.test(value)) {
    throw invalid('admin themeCustomization css must not contain "</style"');
  }
  return value;
}

/** Validate the token map; `undefined` is allowed, `{}` is allowed (no rule emitted). */
function validateCustomTokens(value: unknown): AdminThemeTokens | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw invalid('admin themeCustomization tokens must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return undefined;
  }
  const tokens: Record<string, string> = {};
  for (const [key, val] of entries) {
    if (!/^--[A-Za-z0-9-]+$/.test(key)) {
      throw invalid('admin themeCustomization token names must be CSS custom properties');
    }
    if (typeof val !== 'string') {
      throw invalid('admin themeCustomization token values must be strings');
    }
    if (CONTROL_CHARS.test(val)) {
      throw invalid('admin themeCustomization token values must not contain control characters');
    }
    // Token values are also injected into a <style> element verbatim; the same
    // reasoning as validateCustomCss applies.
    if (/<\/style/i.test(val)) {
      throw invalid('admin themeCustomization token values must not contain "</style"');
    }
    tokens[key] = val;
  }
  return Object.freeze(tokens);
}

/**
 * Validate the optional client script URLs and freeze a copy. Each entry is a
 * trusted config value required to be a non-empty string free of control
 * characters; the document renderer emits it verbatim as a `src` attribute, so
 * anything that could corrupt the attribute is a configuration error.
 */
function resolveClientScripts(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw invalid('admin clientScripts must be an array of script URLs');
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw invalid('admin clientScripts must be non-empty strings');
    }
    if (CONTROL_CHARS.test(entry)) {
      throw invalid('admin clientScripts must not contain control characters');
    }
  }
  return Object.freeze([...(value as string[])]);
}
