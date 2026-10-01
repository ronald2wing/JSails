/**
 * Integration tests: i18n plugin wired through createTestApp.
 *
 * Exercises the full request pipeline — locale resolution,
 * RequestContext.locale, I18n.t() in registrar routes, and the
 * introspect /_jsails/introspect endpoint.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { publicAccess } from '../../src/api/access-ref.js';
import { createTestApp } from '../../src/testing/index.js';
import { i18nPlugin } from '../../src/i18n/plugin.js';
import { i18nToken } from '../../src/i18n/token.js';
import type { ExtensionEntry } from '../../src/extensions/extension.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const OPEN = publicAccess('i18n probe');
const fixturesRoot = join(__dirname, '..', '..', 'tmp', 'i18n-integration');
let seq = 0;

rmSync(fixturesRoot, { recursive: true, force: true });

function tmpDir(): string {
  mkdirSync(fixturesRoot, { recursive: true });
  const dir = mkdtempSync(join(fixturesRoot, `case-${seq++}-`));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Build the canonical extension list: i18nPlugin with the given options,
 * then a `requires: [i18nToken]` demo extension that registers routes.
 */
function extensions(opts: Parameters<typeof i18nPlugin>[0]): ExtensionEntry[] {
  return [
    i18nPlugin(opts),
    {
      name: 'i18n-demo',
      requires: [i18nToken],
      setup({ services, routes }) {
        const i18n = services.get(i18nToken);
        const text = (path: string, answer: () => string) =>
          routes.add({
            methods: ['GET'],
            path,
            access: OPEN,
            handler: () => new Response(answer()),
          });
        text('/i18n/locale', () => i18n.locale());
        text('/i18n/hello', () => i18n.t('hello'));
        text('/i18n/fallback', () => i18n.fallbackLocale());
      },
    },
  ];
}

// ---- RequestContext.locale ---------------------------------------------------

describe('request locale flow', () => {
  it('populates RequestContext.locale from the i18n middleware', async (t) => {
    const app = await createTestApp({
      config: {
        rootDir: tmpDir(),
        port: 0,
        extensions: [
          i18nPlugin({ locale: 'en' }),
          {
            name: 'locale-capture',
            requires: [i18nToken],
            setup({ routes }) {
              routes.add({
                methods: ['GET'],
                path: '/locale-check',
                access: OPEN,
                handler: ({ locale }) => new Response(locale ?? 'MISSING'),
              });
            },
          },
        ],
      },
      lifecycle: t,
    });

    const res = await app.request('/locale-check');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'en');
  });

  it('I18n.t resolves through the ambient scope in a request', async (t) => {
    const app = await createTestApp({
      config: {
        rootDir: tmpDir(),
        port: 0,
        extensions: extensions({ catalogs: { en: { hello: 'Hello from catalog!' } } }),
      },
      lifecycle: t,
    });

    const res = await app.request('/i18n/hello');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'Hello from catalog!');
  });

  it('resolveLocale from query parameter selects the locale', async (t) => {
    const app = await createTestApp({
      config: {
        rootDir: tmpDir(),
        port: 0,
        extensions: extensions({
          catalogs: { en: {}, de: {} },
          resolveLocale: (_request, context) => context.url.searchParams.get('lang') ?? undefined,
        }),
      },
      lifecycle: t,
    });

    const res = await app.request('/i18n/locale?lang=de');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'de');
  });

  it('throwing resolver falls back to default locale', async (t) => {
    const app = await createTestApp({
      config: {
        rootDir: tmpDir(),
        port: 0,
        extensions: extensions({
          resolveLocale: () => {
            throw new Error('boom');
          },
        }),
      },
      lifecycle: t,
    });

    const res = await app.request('/i18n/locale');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'en');
  });
});

// ---- fallback chain -----------------------------------------------------------

describe('fallback chain', () => {
  it('key only in fallback locale resolves correctly', async (t) => {
    const app = await createTestApp({
      config: {
        rootDir: tmpDir(),
        port: 0,
        extensions: extensions({
          locale: 'fr',
          fallbackLocale: 'en',
          catalogs: {
            fr: { farewell: 'Au revoir' },
            en: { hello: 'Hello', farewell: 'Goodbye' },
          },
        }),
      },
      lifecycle: t,
    });

    const res = await app.request('/i18n/hello');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'Hello');
  });

  it('fallback locale is reported correctly', async (t) => {
    const app = await createTestApp({
      config: {
        rootDir: tmpDir(),
        port: 0,
        extensions: extensions({ fallbackLocale: 'de' }),
      },
      lifecycle: t,
    });

    const res = await app.request('/i18n/fallback');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'de');
  });
});

// ---- localize ---------------------------------------------------------------

describe('localize', () => {
  it('formats a date in the request locale', async (t) => {
    const app = await createTestApp({
      config: {
        rootDir: tmpDir(),
        port: 0,
        extensions: [
          i18nPlugin({ locale: 'en' }),
          {
            name: 'localize-demo',
            requires: [i18nToken],
            setup({ services, routes }) {
              const i18n = services.get(i18nToken);
              routes.add({
                methods: ['GET'],
                path: '/localize',
                access: OPEN,
                handler: () =>
                  new Response(i18n.localize(new Date('2023-03-14T12:00:00Z'), { kind: 'date' })),
              });
            },
          },
        ],
      },
      lifecycle: t,
    });

    const res = await app.request('/localize');
    assert.strictEqual(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('2023') || body.includes('3/14'), `unexpected date: ${body}`);
  });
});

// ---- introspect -------------------------------------------------------------

describe('introspect i18n section', () => {
  it('reports locale info', async (t) => {
    const app = await createTestApp({
      config: {
        rootDir: tmpDir(),
        port: 0,
        introspect: { enabled: true, authorize: () => true },
        extensions: [
          i18nPlugin({
            locale: 'fr',
            fallbackLocale: 'en',
            catalogs: { fr: {}, en: {} },
          }),
        ],
      },
      lifecycle: t,
    });

    const res = await app.request('/_jsails/introspect?section=i18n');
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as {
      sections: Record<string, { status: string; data?: unknown; error?: unknown }>;
    };

    assert.ok(body.sections.i18n);
    assert.strictEqual(body.sections.i18n.status, 'ok');

    const data = body.sections.i18n.data as {
      activeLocale: string;
      fallbackLocale: string;
      availableLocales: readonly string[];
    };
    assert.strictEqual(data.activeLocale, 'fr');
    assert.strictEqual(data.fallbackLocale, 'en');
    assert.deepStrictEqual(data.availableLocales, ['en', 'fr']);
  });

  it('reports unavailable when i18n plugin is absent', async (t) => {
    const app = await createTestApp({
      config: {
        rootDir: tmpDir(),
        port: 0,
        introspect: { enabled: true, authorize: () => true },
        extensions: [],
      },
      lifecycle: t,
    });

    const res = await app.request('/_jsails/introspect?section=i18n');
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as {
      sections: Record<string, { status: string; data?: unknown }>;
    };

    assert.ok(body.sections.i18n);
    assert.strictEqual(body.sections.i18n.status, 'unavailable');
    // Unavailable sections omit `data` (consistent with every other provider).
    assert.strictEqual(body.sections.i18n.data, undefined);
  });
});
