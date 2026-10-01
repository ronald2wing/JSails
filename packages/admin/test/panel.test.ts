/**
 * Tests for `defineAdminPanel`: option validation (path, auth, theme, theme
 * customization, client scripts) and the frozen descriptor it returns. Every
 * rejection is a value-free `AdminDefinitionError`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createServiceToken } from 'jsails/extensions';

import {
  AdminDefinitionError,
  defineAdminPage,
  defineAdminPanel,
  type AdminSessionService,
} from '../src/index.js';
import { ADMIN_THEMES } from '../src/panel.js';
import { SESSION } from './fixtures.js';

const sessionToken = createServiceToken<AdminSessionService>('test.session');

describe('admin panel option validation', () => {
  const valid = {
    resolveSession: () => SESSION,
    authorize: () => true,
  };

  it('rejects a missing options object', () => {
    assert.throws(() => defineAdminPanel(undefined as never), AdminDefinitionError);
  });

  it('rejects a missing resolveSession', () => {
    assert.throws(() => defineAdminPanel({ authorize: () => true }), AdminDefinitionError);
  });

  it('rejects a missing authorize', () => {
    assert.throws(
      () => defineAdminPanel({ resolveSession: () => SESSION } as never),
      AdminDefinitionError,
    );
  });

  it('rejects a reserved, malformed, or relative path', () => {
    for (const path of [
      '/',
      '/admin/',
      '/_jsails',
      '/_jsails/x',
      'admin',
      '/admin//x',
      '/ad\nmin',
      '/ad\\min',
    ]) {
      assert.throws(
        () => defineAdminPanel({ ...valid, path }),
        AdminDefinitionError,
        `path ${JSON.stringify(path)} must be rejected`,
      );
    }
  });

  it('accepts a valid custom path', () => {
    assert.doesNotThrow(() => defineAdminPanel({ ...valid, path: '/panel/admin' }));
  });

  it('returns a deeply frozen descriptor', () => {
    const panel = defineAdminPanel({
      ...valid,
      pages: [defineAdminPage({ slug: 'x', label: 'X', render: () => 'x' })],
    });
    assert.equal(Object.isFrozen(panel), true);
    assert.equal(Object.isFrozen(panel.pages), true);
  });
});

describe('defineAdminPanel auth option', () => {
  it('rejects both resolveSession and auth together', () => {
    assert.throws(
      () =>
        defineAdminPanel({
          resolveSession: () => SESSION,
          auth: sessionToken,
          authorize: () => true,
        }),
      AdminDefinitionError,
    );
  });

  it('rejects neither resolveSession nor auth', () => {
    assert.throws(() => defineAdminPanel({ authorize: () => true }), AdminDefinitionError);
  });

  it('accepts a panel built from auth alone and leaves resolveSession absent', () => {
    const panel = defineAdminPanel({ auth: sessionToken, authorize: () => true });
    assert.equal(panel.auth, sessionToken);
    assert.equal(panel.resolveSession, undefined);
  });
});

describe('admin panel theme option', () => {
  it('accepts every recognized theme value and rejects anything else', () => {
    const valid = { resolveSession: () => SESSION, authorize: () => true };
    for (const theme of ADMIN_THEMES) {
      assert.doesNotThrow(() => defineAdminPanel({ ...valid, theme }));
    }
    assert.throws(
      () => defineAdminPanel({ ...valid, theme: 'neon' as never }),
      AdminDefinitionError,
    );
    assert.throws(() => defineAdminPanel({ ...valid, theme: 3 as never }), AdminDefinitionError);
  });
});

describe('admin theme customization validation', () => {
  const valid = { resolveSession: () => ({}) as never, authorize: () => true };

  it('rejects a non-object themeCustomization', () => {
    assert.throws(
      () => defineAdminPanel({ ...valid, themeCustomization: 'bad' as never }),
      AdminDefinitionError,
    );
    assert.throws(
      () => defineAdminPanel({ ...valid, themeCustomization: [] as never }),
      AdminDefinitionError,
    );
  });

  it('rejects a non-string css', () => {
    assert.throws(
      () => defineAdminPanel({ ...valid, themeCustomization: { css: 42 as never } }),
      AdminDefinitionError,
    );
  });

  it('rejects css containing a control character', () => {
    assert.throws(
      () => defineAdminPanel({ ...valid, themeCustomization: { css: 'a\nb' } }),
      AdminDefinitionError,
    );
  });

  it('rejects css containing </style>', () => {
    assert.throws(
      () =>
        defineAdminPanel({
          ...valid,
          themeCustomization: { css: 'body { color: red; } </style><script>alert(1)</script>' },
        }),
      AdminDefinitionError,
    );
  });

  it('rejects non-object tokens', () => {
    assert.throws(
      () => defineAdminPanel({ ...valid, themeCustomization: { tokens: 'nope' as never } }),
      AdminDefinitionError,
    );
    assert.throws(
      () => defineAdminPanel({ ...valid, themeCustomization: { tokens: [] as never } }),
      AdminDefinitionError,
    );
  });

  it('rejects a token key that is not a CSS custom property', () => {
    assert.throws(
      () =>
        defineAdminPanel({
          ...valid,
          themeCustomization: { tokens: { bg: 'red' } },
        }),
      AdminDefinitionError,
    );
  });

  it('rejects a non-string token value', () => {
    assert.throws(
      () =>
        defineAdminPanel({
          ...valid,
          themeCustomization: { tokens: { '--ok': 42 as never } },
        }),
      AdminDefinitionError,
    );
  });

  it('rejects a token value containing </style>', () => {
    assert.throws(
      () =>
        defineAdminPanel({
          ...valid,
          themeCustomization: { tokens: { '--bad': '</style><script>' } },
        }),
      AdminDefinitionError,
    );
  });

  it('accepts an empty css string (no-op)', () => {
    assert.doesNotThrow(() => defineAdminPanel({ ...valid, themeCustomization: { css: '' } }));
  });

  it('accepts an empty tokens object (no rule emitted, treated as undefined)', () => {
    const panel = defineAdminPanel({ ...valid, themeCustomization: { tokens: {} } });
    assert.equal(panel.themeCustomization, undefined);
  });

  it('returns a frozen descriptor and deep-frozen tokens', () => {
    const panel = defineAdminPanel({
      ...valid,
      themeCustomization: { css: 'body { color: red; }', tokens: { '--bg': '#fff' } },
    });
    assert.equal(Object.isFrozen(panel), true);
    const tc = panel.themeCustomization;
    assert.ok(tc !== undefined);
    assert.equal(Object.isFrozen(tc), true);
    assert.ok(tc.tokens !== undefined);
    assert.equal(Object.isFrozen(tc.tokens), true);
  });
});

describe('admin panel client scripts option', () => {
  const valid = { resolveSession: () => SESSION, authorize: () => true };

  it('accepts an array of non-empty script URLs and freezes a copy', () => {
    const panel = defineAdminPanel({ ...valid, clientScripts: ['/app.js', '/vendor.js'] });
    assert.deepEqual(panel.clientScripts, ['/app.js', '/vendor.js']);
    assert.equal(Object.isFrozen(panel.clientScripts), true);
  });

  it('omits clientScripts when the option is omitted', () => {
    const panel = defineAdminPanel(valid);
    assert.equal(panel.clientScripts, undefined);
  });

  it('rejects a non-array value', () => {
    assert.throws(
      () => defineAdminPanel({ ...valid, clientScripts: 'x' as never }),
      AdminDefinitionError,
    );
  });

  it('rejects an empty or non-string entry', () => {
    assert.throws(() => defineAdminPanel({ ...valid, clientScripts: [''] }), AdminDefinitionError);
    assert.throws(
      () => defineAdminPanel({ ...valid, clientScripts: ['/a.js', 42 as never] }),
      AdminDefinitionError,
    );
  });

  it('rejects an entry containing a control character', () => {
    assert.throws(
      () => defineAdminPanel({ ...valid, clientScripts: ['/a.js', '/bad\n.js'] }),
      AdminDefinitionError,
    );
  });
});
