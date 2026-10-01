/**
 * Shared fixtures for the admin test suite: the test session, a test app
 * mounting one admin panel, the in-memory article resource the route tests
 * drive, and the rich-text body resource.
 *
 * Every app is a real in-process `Application` from `jsails/testing`: the admin
 * plugin registers trusted Hono hook routes and each request is routed through
 * the same pipeline `serve` uses. No browser, database, Valkey, or listener is
 * involved.
 */

import { defineRichTextEditorAdapter } from 'jsails/rich-text';
import { createTestApp, createTestSession, type TestApplication } from 'jsails/testing';
import { z } from 'zod';

import {
  adminPlugin,
  defineAdminPanel,
  defineResource,
  type AdminPanelOptions,
  type Resource,
  type ResourceColumn,
  type ResourceDefinition,
  type ResourceField,
  type ResourceGetContext,
  type ResourceListContext,
} from '../src/index.js';

/** The authorized admin session every fixture app resolves by default. */
export const SESSION = createTestSession();

/** The CSRF token mutating posts must carry as `_csrf`. */
export const CSRF = SESSION.csrfToken;

/**
 * Create a test app mounting one admin panel. The panel resolves {@link SESSION}
 * and authorizes everything unless `panelOptions` overrides either; the panel
 * is defined synchronously so invalid options throw before the app starts.
 */
export function createAdminTestApp(
  panelOptions: Partial<AdminPanelOptions> = {},
): Promise<TestApplication> {
  const panel = defineAdminPanel({
    resolveSession: () => SESSION,
    authorize: () => true,
    ...panelOptions,
  });
  return createTestApp({ config: { port: 0, extensions: [adminPlugin(panel)] } });
}

/** One article row of the in-memory fixture resource. */
export type Article = {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: string;
  readonly active: boolean;
  readonly priority: number;
};

/** A `save` call captured by {@link ArticleStore}. */
export interface SaveRecord {
  readonly id: string | null;
  readonly values: Record<string, unknown>;
}

/** The in-memory backing store of {@link defineArticleResource}. */
export interface ArticleStore {
  rows: Article[];
  nextId: number;
  saves: SaveRecord[];
  listCalls: Array<{ page: number; pageSize: number }>;
  getCalls: Array<{ id: string }>;
}

/** Every field kind the basic schema coercion covers: text, textarea, select, toggle, number. */
export const ARTICLE_FIELDS: readonly ResourceField[] = [
  { name: 'title', label: 'Title', type: 'text' },
  { name: 'description', label: 'Description', type: 'textarea', required: false },
  {
    name: 'status',
    label: 'Status',
    type: 'select',
    options: [
      { value: 'draft', label: 'Draft' },
      { value: 'published', label: 'Published' },
    ],
  },
  { name: 'active', label: 'Active', type: 'toggle' },
  { name: 'priority', label: 'Priority', type: 'number' },
];

export const ARTICLE_COLUMNS: readonly ResourceColumn[] = [
  { name: 'id', label: 'ID' },
  { name: 'title', label: 'Title' },
  { name: 'status', label: 'Status' },
  { name: 'priority', label: 'Priority' },
  { name: 'active', label: 'Active' },
];

/** Create an article store seeded with `rows`. */
export function createArticleStore(rows: Article[] = []): ArticleStore {
  return { rows: [...rows], nextId: rows.length + 1, saves: [], listCalls: [], getCalls: [] };
}

/** An article row with defaults for every column. */
export function article(id: string, overrides: Partial<Article> = {}): Article {
  return {
    id,
    title: `Article ${id}`,
    status: 'draft',
    active: false,
    priority: 1,
    ...overrides,
  };
}

/** Define the `articles` resource over `store`, with `overrides` applied last. */
export function defineArticleResource(
  store: ArticleStore,
  overrides: Partial<ResourceDefinition> = {},
): Resource {
  return defineResource({
    slug: 'articles',
    label: 'Articles',
    columns: ARTICLE_COLUMNS,
    fields: ARTICLE_FIELDS,
    list: async ({ page, pageSize }: ResourceListContext) => {
      store.listCalls.push({ page, pageSize });
      const start = (page - 1) * pageSize;
      return { rows: store.rows.slice(start, start + pageSize), total: store.rows.length };
    },
    get: async ({ id }: ResourceGetContext) => {
      store.getCalls.push({ id });
      return store.rows.find((row) => row.id === id) ?? null;
    },
    save: async ({ id, values }) => {
      store.saves.push({ id, values });
      const record: Article = {
        id: id ?? String(store.nextId++),
        title: values['title'] as string,
        description: values['description'] as string | undefined,
        status: values['status'] as string,
        active: values['active'] as boolean,
        priority: values['priority'] as number,
      };
      if (id === null) {
        store.rows.push(record);
      } else {
        const index = store.rows.findIndex((row) => row.id === id);
        if (index >= 0) store.rows[index] = record;
      }
    },
    ...overrides,
  });
}

/** A one-paragraph rich-text document. */
export const RICH_TEXT_DOCUMENT = {
  version: 1,
  blocks: [{ id: 'b1', type: 'paragraph', text: 'Hello rich text' }],
} as const;

/** A fake editor adapter whose native payload is `{ text }`. */
export const fakeRichTextEditor = defineRichTextEditorAdapter({
  id: 'fake',
  island: 'fake-editor',
  payloadSchema: z.object({ text: z.string() }),
  toContent: (payload) => ({
    version: 1,
    blocks: [{ id: 'b1', type: 'paragraph', text: payload.text }],
  }),
  fromContent: (document) => {
    const first = document.blocks[0];
    return { text: first?.type === 'paragraph' ? first.text : '' };
  },
});

/** The envelope {@link fakeRichTextEditor} accepts for {@link RICH_TEXT_DOCUMENT}. */
export const RICH_TEXT_ENVELOPE = {
  version: 1,
  editor: 'fake',
  content: RICH_TEXT_DOCUMENT,
  native: { text: 'Hello rich text' },
} as const;

/** Define the `bodies` resource with one `richText` field unless overridden. */
export function defineBodyResource(
  overrides: { fields?: readonly ResourceField[]; get?: Resource['get'] } = {},
): Resource {
  return defineResource({
    slug: 'bodies',
    label: 'Bodies',
    columns: [{ name: 'id', label: 'ID' }],
    fields: overrides.fields ?? [{ name: 'body', label: 'Body', type: 'richText' }],
    list: async () => ({ rows: [], total: 0 }),
    ...(overrides.get === undefined ? {} : { get: overrides.get }),
    save: async () => {},
  });
}
