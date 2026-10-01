/**
 * The blog's site settings as a `@jsails/config` set (`blog.site`): edited on
 * the config admin page, exported and imported with the rest of the app's
 * config, and overridable from code like any other set.
 *
 * Register it with the app's `configPlugin({ sets: [blogSiteConfig, ...] })`
 * and read it through the config service: `config.get(blogSiteConfig)`. The
 * blog's public routes read it through {@link readBlogSiteSettings}, so an
 * editor's change to the title or page size shows on the next request; without
 * the config plugin (or with the set unregistered) they use the defaults.
 */

import {
  defineConfig,
  integer,
  json,
  text,
  type Config,
  type ConfigField,
  type ConfigSet,
} from '@jsails/config';
import type { JsonValue } from 'jsails/plugin-sdk';

/** Most posts a listing page may show. */
export const BLOG_MAX_POSTS_PER_PAGE = 200;

/** True for an object mapping each platform to a URL string. */
function isSocialMap(value: JsonValue): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every((href) => typeof href === 'string')
  );
}

/** The `blog.site` config set. */
export const blogSiteConfig: ConfigSet<{
  readonly title: ConfigField<string>;
  readonly tagline: ConfigField<string>;
  readonly postsPerPage: ConfigField<number>;
  readonly timezone: ConfigField<string>;
  readonly social: ConfigField<Readonly<Record<string, string>>>;
}> = defineConfig('blog.site', {
  label: 'Blog',
  fields: {
    title: text({ label: 'Site title', default: 'My blog', required: true, max: 190 }),
    tagline: text({ label: 'Tagline', max: 190 }),
    postsPerPage: integer({
      label: 'Posts per page',
      default: 10,
      min: 1,
      max: BLOG_MAX_POSTS_PER_PAGE,
    }),
    timezone: text({ label: 'Timezone', default: 'UTC', required: true, max: 64 }),
    social: json<Readonly<Record<string, string>>>({
      label: 'Social (JSON object of platform to URL)',
      default: {},
      validate: isSocialMap,
    }),
  },
});

/** The resolved `blog.site` values the public routes render with. */
export interface BlogSiteSettings {
  readonly title: string;
  readonly tagline: string;
  readonly postsPerPage: number;
  readonly timezone: string;
  readonly social: Readonly<Record<string, string>>;
}

/** The set's declared defaults, used when no config service provides the set. */
export const BLOG_SITE_DEFAULTS: BlogSiteSettings = Object.freeze({
  title: blogSiteConfig.fields.title.default,
  tagline: blogSiteConfig.fields.tagline.default,
  postsPerPage: blogSiteConfig.fields.postsPerPage.default,
  timezone: blogSiteConfig.fields.timezone.default,
  social: blogSiteConfig.fields.social.default,
});

/**
 * The effective `blog.site` values from the config service, or the defaults
 * when there is no service, the set is not registered with it, or the store
 * cannot be read: a config outage must not take the public blog down.
 */
export async function readBlogSiteSettings(config: Config | undefined): Promise<BlogSiteSettings> {
  if (config === undefined || config.find(blogSiteConfig.name) !== blogSiteConfig) {
    return BLOG_SITE_DEFAULTS;
  }
  try {
    return await config.get(blogSiteConfig);
  } catch {
    return BLOG_SITE_DEFAULTS;
  }
}
