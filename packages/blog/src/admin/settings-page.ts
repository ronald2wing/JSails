/**
 * Blog settings admin page: a curated form over five site keys, replacing raw
 * JSON editing of the settings collection.
 *
 * The keys are `site.title` (required), `site.tagline`, `site.postsPerPage` (a
 * bounded integer), `site.timezone`, and `site.social` (a JSON-safe object of
 * platform to URL), read through `getSetting` and written through `setSetting`.
 * The only mutation is `action=save`; an unknown action, a blank title or
 * timezone, an out-of-range posts-per-page, or a malformed social object yields
 * a value-free 400 that never echoes the submitted input.
 */

import { h, type ComponentChild } from 'preact';

import {
  actionForm,
  adminBadRequestResponse,
  adminRedirectResponse,
  defineAdminPage,
  panelDocumentOptions,
  renderAdminDocumentWithTheme,
  renderNotice,
  type AdminPage,
  type AdminPagePostContext,
  type AdminPageRenderContext,
} from '@jsails/admin';

import type { JsonValue } from 'jsails/plugin-sdk';

import type { BlogRepository } from '../cms/index.js';
import {
  BLOG_PAGE_GROUP,
  SAVED_NOTICE,
  blogPagePath,
  formString,
  type BlogAdminPageOptions,
} from './page-frame.js';

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
 * Build the settings {@link AdminPage}: a curated form over the five site keys.
 * Mounted by `blogAdmin`; also usable directly where a standalone page is
 * wanted.
 */
export function defineBlogSettingsAdminPage(options: BlogAdminPageOptions): AdminPage {
  const { repository } = options;
  return defineAdminPage({
    slug: SETTINGS_SLUG,
    label: SETTINGS_LABEL,
    group: BLOG_PAGE_GROUP,
    render: (context) => renderSettingsPage(context, repository, options.path),
    handlePost: (context) => handleSettingsPost(context, repository, options.path),
  });
}

/** Read a curated setting, coercing absent/mistyped values to a safe default. */
async function readSetting(
  repository: BlogRepository,
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
async function readSite(repository: BlogRepository): Promise<{
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
  repository: BlogRepository,
  path?: string,
): Promise<string> {
  const site = await readSite(repository);
  const notice = context.url.searchParams.get('notice') === SAVED_NOTICE ? 'Settings saved.' : null;
  const actionPath = blogPagePath(path ?? context.path, SETTINGS_SLUG);

  const body: ComponentChild[] = [
    h('h1', null, SETTINGS_LABEL),
    ...(notice === null ? [] : [renderNotice(notice)]),
    actionForm({
      path: actionPath,
      csrf: context.session.csrfToken,
      action: 'save',
      label: 'Save settings',
      controls: [
        h(
          'div',
          null,
          h('label', null, 'Site title'),
          textInput({ name: 'site.title', value: site.title, required: true }),
        ),
        h(
          'div',
          null,
          h('label', null, 'Tagline'),
          textInput({ name: 'site.tagline', value: site.tagline }),
        ),
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
        h(
          'div',
          null,
          h('label', null, 'Timezone'),
          textInput({ name: 'site.timezone', value: site.timezone, required: true }),
        ),
        h(
          'div',
          null,
          h('label', null, 'Social (JSON object of platform to URL)'),
          h('textarea', { name: 'site.social' }, socialText(site.social)),
        ),
      ],
    }),
  ];

  return renderAdminDocumentWithTheme(panelDocumentOptions(context, SETTINGS_LABEL), ...body);
}

/** One text field of the settings form. */
interface TextInputOptions {
  readonly name: string;
  readonly value: string;
  /** Whether the browser must refuse an empty submission. */
  readonly required?: boolean;
}

/** A single text field with the given name, value, and requirement. */
function textInput(options: TextInputOptions): ComponentChild {
  const { name, value } = options;
  return h('input', { type: 'text', name, value, ...(options.required ? { required: true } : {}) });
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
  const raw = formString(value);
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
  repository: BlogRepository,
  path?: string,
): Promise<Response> {
  if (context.body['action'] !== 'save') {
    return adminBadRequestResponse();
  }

  const title = formString(context.body['site.title']);
  if (title === '') {
    return adminBadRequestResponse();
  }
  const timezone = formString(context.body['site.timezone']);
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
  await repository.setSetting('site.tagline', formString(context.body['site.tagline']));
  await repository.setSetting('site.postsPerPage', postsPerPage);
  await repository.setSetting('site.timezone', timezone);
  await repository.setSetting('site.social', social);

  return adminRedirectResponse(
    `${blogPagePath(path ?? context.path, SETTINGS_SLUG)}?notice=${SAVED_NOTICE}`,
  );
}
