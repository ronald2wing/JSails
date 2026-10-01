/**
 * Shared fixtures for the blog tests: the plugin mounted on an in-process Hono
 * app, seed inputs, admin page/resource contexts, and value-free error
 * assertions.
 */

import assert from 'node:assert/strict';

import { Hono } from 'hono';

import {
  type AdminPage,
  type AdminPagePostContext,
  type AdminPageRenderContext,
  type AdminPlugin,
  type Resource,
} from '@jsails/admin';
import { runExtensions, type ExtensionRuntime, type HttpExtensionHook } from 'jsails/extensions';
import { createTestSession } from 'jsails/testing';

import type { BlogPost, BlogPostCreateInput, BlogRepository } from '../src/cms/index.js';
import { BlogContentError } from '../src/cms/repository.js';
import { blogPlugin, blogRepositoryToken, type BlogPluginOptions } from '../src/plugin.js';

// -- The plugin on an app ---------------------------------------------------

/**
 * `AppEnv` is not part of the public `jsails` surface; recover it from the
 * public `HttpExtensionHook` contract instead of naming it.
 */
export type TestAppEnv = Parameters<HttpExtensionHook>[0] extends Hono<infer E> ? E : never;

/** The blog plugin run through the extension runner and mounted on a fresh app. */
export interface TestApp {
  readonly app: Hono<TestAppEnv>;
  readonly runtime: ExtensionRuntime;
  readonly repository: BlogRepository;
}

/** Build the plugin through the runner and mount its hooks on a fresh Hono app. */
export async function makeApp(options: BlogPluginOptions = {}): Promise<TestApp> {
  const runtime = await runExtensions([blogPlugin(options)]);
  const app = new Hono<TestAppEnv>();
  for (const hook of runtime.httpHooks) {
    await hook(app);
  }
  return { app, runtime, repository: runtime.services.get(blogRepositoryToken) };
}

/** An `application/x-www-form-urlencoded` POST body for a raw Hono request. */
export function postBody(fields: Readonly<Record<string, string>>): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

// -- Seed data --------------------------------------------------------------

/** A valid post-create input, published unless overridden. */
export function seedInput(input: Partial<BlogPostCreateInput> = {}): BlogPostCreateInput {
  return {
    title: 'Seed',
    slug: 'seed',
    blocks: { version: 1, blocks: [] },
    status: 'published',
    authorId: 'test-author',
    ...input,
  };
}

/** Create one post from {@link seedInput}. */
export function seedPost(
  repository: BlogRepository,
  input: Partial<BlogPostCreateInput> = {},
): Promise<BlogPost> {
  return repository.createPost(seedInput(input));
}

// -- Admin pages and resources ----------------------------------------------

/** The session every admin context carries; `_csrf` fields must echo its token. */
export const session = createTestSession();

/** Build a `URL` for the given pathname (the admin pages ignore the base). */
export function makeUrl(pathname: string): URL {
  return new URL(pathname, 'http://localhost');
}

/** Build a `GET` render context with the given base path and query URL. */
export function renderContext(path: string, url: URL): AdminPageRenderContext {
  return { session, path, request: new Request(url), url };
}

/** Build a `POST` context with a string-only form body carrying the CSRF token. */
export function postContext(
  path: string,
  url: URL,
  body: Readonly<Record<string, string>>,
): AdminPagePostContext {
  return { ...renderContext(path, url), body: { _csrf: session.csrfToken, ...body } };
}

/** Every resource and page an admin plugin registers, keyed by slug. */
export function captureContributions(plugin: AdminPlugin): {
  readonly resources: Map<string, Resource>;
  readonly pages: Map<string, AdminPage>;
} {
  const resources = new Map<string, Resource>();
  const pages = new Map<string, AdminPage>();
  plugin.register({
    addPage(page) {
      pages.set(page.slug, page);
    },
    addNavigationItem() {},
    addResource(resource) {
      resources.set(resource.slug, resource);
    },
  });
  return { resources, pages };
}

/** The page the admin plugin registers under `slug`. */
export function capturePage(plugin: AdminPlugin, slug: string): AdminPage {
  const page = captureContributions(plugin).pages.get(slug);
  assert.ok(page, `blog must register the ${slug} page`);
  return page;
}

/** A resource's `list`/`get`/`save` with the optional callbacks narrowed to required. */
export interface ResourceHandlers {
  readonly list: Resource['list'];
  readonly get: NonNullable<Resource['get']>;
  readonly save: NonNullable<Resource['save']>;
}

/** Narrow a resource's optional `get`/`save` to their required forms. */
export function handlers(resource: Resource): ResourceHandlers {
  assert.ok(resource.get, `resource ${resource.slug} must define get`);
  assert.ok(resource.save, `resource ${resource.slug} must define save`);
  return { list: resource.list, get: resource.get, save: resource.save };
}

/** The handlers of the resource the admin plugin registers under `slug`. */
export function captureResource(plugin: AdminPlugin, slug: string): ResourceHandlers {
  const resource = captureContributions(plugin).resources.get(slug);
  assert.ok(resource, `blog admin must contribute the ${slug} resource`);
  return handlers(resource);
}

// -- Errors -----------------------------------------------------------------

/** Assert a call rejects with a value-free `BlogContentError` of the given code. */
export async function rejectsWithCode(
  promise: Promise<unknown>,
  code: string,
  messageMustNotContain?: string,
): Promise<BlogContentError> {
  let captured: BlogContentError | undefined;
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof BlogContentError, `expected BlogContentError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (messageMustNotContain !== undefined) {
      assert.ok(
        !error.message.includes(messageMustNotContain),
        'error message must not echo input',
      );
    }
    captured = error;
    return true;
  });
  assert.ok(captured !== undefined, 'expected a BlogContentError');
  return captured;
}
