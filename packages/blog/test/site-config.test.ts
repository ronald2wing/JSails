/** Tests for `blogSiteConfig`: the rules the old settings page enforced, now on the config set. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, createConfig, createMemoryConfigStore } from '@jsails/config';

import { BLOG_MAX_POSTS_PER_PAGE, blogSiteConfig } from '../src/index.js';

function makeConfig() {
  return createConfig({ store: createMemoryConfigStore(), sets: [blogSiteConfig] });
}

function invalid(error: unknown): boolean {
  return error instanceof ConfigError && error.code === 'invalid_value';
}

describe('blogSiteConfig', () => {
  it('defaults every field', async () => {
    assert.deepEqual(await makeConfig().get(blogSiteConfig), {
      title: 'My blog',
      tagline: '',
      postsPerPage: 10,
      timezone: 'UTC',
      social: {},
    });
  });

  it('requires a title and a timezone', async () => {
    const config = makeConfig();
    await assert.rejects(config.set(blogSiteConfig, { title: ' ' }), invalid);
    await assert.rejects(config.set(blogSiteConfig, { timezone: '' }), invalid);
  });

  it('bounds posts per page', async () => {
    const config = makeConfig();
    await assert.rejects(config.set(blogSiteConfig, { postsPerPage: 0 }), invalid);
    await assert.rejects(
      config.set(blogSiteConfig, { postsPerPage: BLOG_MAX_POSTS_PER_PAGE + 1 }),
      invalid,
    );
    await config.set(blogSiteConfig, { postsPerPage: BLOG_MAX_POSTS_PER_PAGE });
  });

  it('accepts only a map of platform to URL string for social', async () => {
    const config = makeConfig();
    await config.set(blogSiteConfig, { social: { mastodon: 'https://example.test/@me' } });
    await assert.rejects(config.set(blogSiteConfig, { social: { x: 1 } as never }), invalid);
    await assert.rejects(config.set(blogSiteConfig, { social: ['x'] as never }), invalid);
  });
});
