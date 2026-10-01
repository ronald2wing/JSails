/**
 * Shared fixtures for the blog tests: the plugin on an in-process app (the
 * real request pipeline, access chain included), seed inputs, admin
 * page/resource contexts, and value-free error assertions.
 */

import assert from 'node:assert/strict';

import {
  type AdminPage,
  type AdminPagePostContext,
  type AdminPageRenderContext,
  type AdminPlugin,
  type Resource,
} from '@jsails/admin';
import type { Application } from 'jsails/app';
import { publicAccess } from 'jsails/kernel';
import { runExtensions, type ExtensionRuntime } from 'jsails/extensions';
import {
  createTestApp,
  createTestSession,
  type TestAppOptions,
  type TestApplication,
} from 'jsails/testing';

import type { BlogPost, BlogPostCreateInput, BlogRepository } from '../src/cms/index.js';
import { BlogContentError } from '../src/cms/repository.js';
import { blogPlugin, blogRepositoryToken, type BlogPluginOptions } from '../src/plugin.js';

// -- The plugin on an app ---------------------------------------------------

/** The blog plugin assembled into an in-process application. */
export interface TestApp {
  /** Requests through the app's pipeline, pinned to its origin. */
  readonly app: TestApplication;
  /** The application: its services and its `close`. */
  readonly runtime: Application;
  readonly repository: BlogRepository;
}

/** How {@link makeApp} assembles the app beyond the plugin's own options. */
export interface MakeAppSetup {
  /** The origin requests are addressed to; `http://localhost` unless given. */
  readonly origin?: string;
  /** Plugins set up before the blog plugin (the cache, the config sets). */
  readonly before?: NonNullable<NonNullable<TestAppOptions['config']>['extensions']>;
}

/** Assemble an app with the blog plugin, so its routes run through the real pipeline. */
export async function makeApp(
  options: BlogPluginOptions = {},
  setup: MakeAppSetup = {},
): Promise<TestApp> {
  const app = await createTestApp({
    config: { port: 0, extensions: [...(setup.before ?? []), blogPlugin(options)] },
    ...(setup.origin === undefined ? {} : { origin: setup.origin }),
  });
  const runtime = app.application;
  return { app, runtime, repository: runtime.services.get(blogRepositoryToken) };
}

/** Run the blog plugin through the extension runner alone, for its operation contract. */
export async function makeRuntime(options: BlogPluginOptions = {}): Promise<ExtensionRuntime> {
  return runExtensions([blogPlugin(options)], { rootDir: import.meta.dirname });
}

/**
 * An `application/x-www-form-urlencoded` POST body, sent from the in-process
 * app's own origin unless another one (or none) is given.
 */
export function postBody(
  fields: Readonly<Record<string, string>>,
  origin: string | null = 'http://localhost',
): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin === null ? {} : { origin }),
    },
    body: new URLSearchParams(fields).toString(),
  };
}

/** Plugin options that register `POST /blog/posts` for every same-origin request. */
export const OPEN_CREATE_ROUTE: BlogPluginOptions = {
  createRoute: { access: publicAccess('test fixture: anyone may create a draft') },
};

// -- Seed data --------------------------------------------------------------

/** A valid post-create input, published unless overridden. */
export function seedInput(input: Partial<BlogPostCreateInput> = {}): BlogPostCreateInput {
  return {
    title: 'Seed',
    slug: 'seed',
    blocks: { version: 2, blocks: [] },
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

/** The session every admin context carries. */
export const session = createTestSession();

/** Build a `URL` for the given pathname (the admin pages ignore the base). */
export function makeUrl(pathname: string): URL {
  return new URL(pathname, 'http://localhost');
}

/** Build a `GET` render context with the given base path and query URL. */
export function renderContext(path: string, url: URL): AdminPageRenderContext {
  return { session, path, request: new Request(url), url };
}

/** Build a `POST` context with a string-only form body. */
export function postContext(
  path: string,
  url: URL,
  body: Readonly<Record<string, string>>,
): AdminPagePostContext {
  return { ...renderContext(path, url), body: { ...body } };
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
