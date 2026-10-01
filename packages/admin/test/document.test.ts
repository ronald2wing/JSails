/**
 * Tests for the admin document shell: `renderAdminDocumentWithTheme` (title,
 * `data-theme`, the default theme CSS, custom CSS and token rules appended
 * after it, module scripts after the style) and `panelDocumentOptions`, which
 * lifts a panel's theme fields into document options under a title.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defineAdminPanel,
  panelDocumentOptions,
  renderAdminDocumentWithTheme,
} from '../src/index.js';
import { SESSION } from './fixtures.js';

describe('renderAdminDocumentWithTheme', () => {
  it('renders a full document with a title', () => {
    const html = renderAdminDocumentWithTheme({ title: 'Hello' });
    assert.match(html, /<title>Hello<\/title>/);
  });

  it('sets data-theme on the html element and always emits the default theme CSS', () => {
    const html = renderAdminDocumentWithTheme({ title: 'Hi', theme: 'light' });
    assert.match(html, /<html[^>]*data-theme="light"/);
    assert.match(html, /--jsails-bg/);
  });

  it('omits the attribute when theme is undefined', () => {
    const html = renderAdminDocumentWithTheme({ title: 'Hi' });
    assert.doesNotMatch(html, /<html[^>]*data-theme/);
    assert.match(html, /--jsails-bg/);
  });
});

describe('admin theme customization', () => {
  it('appends custom CSS after the default theme CSS', () => {
    const html = renderAdminDocumentWithTheme({
      title: 'X',
      themeCustomization: { css: 'body { font-size: 20px; }' },
    });
    const styleContent = html.match(/<style>(.*?)<\/style>/s)?.[1] ?? '';
    const defaultIndex = styleContent.indexOf('--jsails-bg');
    const customIndex = styleContent.indexOf('font-size: 20px');
    assert.ok(customIndex > defaultIndex, 'custom CSS must appear after default theme CSS');
  });

  it('serializes a token map as a :root rule after the default CSS', () => {
    const html = renderAdminDocumentWithTheme({
      title: 'X',
      themeCustomization: { tokens: { '--jsails-bg': '#123456' } },
    });
    const styleContent = html.match(/<style>(.*?)<\/style>/s)?.[1] ?? '';
    assert.match(styleContent, /:root \{ --jsails-bg: #123456; \}/);
    const defaultEnd = styleContent.indexOf('body { margin');
    const tokenStart = styleContent.indexOf(':root { --jsails-bg: #123456; }');
    assert.ok(tokenStart > defaultEnd, 'token rule must appear after default theme CSS');
  });

  it('merges both css and tokens, with tokens last', () => {
    const html = renderAdminDocumentWithTheme({
      title: 'X',
      themeCustomization: {
        css: 'body { font-size: 20px; }',
        tokens: { '--my-color': 'red' },
      },
    });
    const styleContent = html.match(/<style>(.*?)<\/style>/s)?.[1] ?? '';
    const cssIndex = styleContent.indexOf('font-size: 20px');
    const tokenIndex = styleContent.indexOf('--my-color: red');
    assert.ok(cssIndex > 0, 'css must be present');
    assert.ok(tokenIndex > cssIndex, 'token rule must appear after custom css');
  });
});

describe('admin client scripts', () => {
  it('renders module scripts in the head, after the style, in order', () => {
    const html = renderAdminDocumentWithTheme({
      title: 'X',
      clientScripts: ['/a.js', '/b.js'],
    });
    // Scripts come after the style element.
    const styleEnd = html.indexOf('</style>');
    const scriptA = html.indexOf('<script type="module" src="/a.js"></script>');
    const scriptB = html.indexOf('<script type="module" src="/b.js"></script>');
    assert.ok(styleEnd >= 0, 'style element present');
    assert.ok(scriptA > styleEnd, 'first script after style');
    assert.ok(scriptB > scriptA, 'second script after first');
  });

  it('escapes a hostile script URL through Preact attribute escaping', () => {
    const html = renderAdminDocumentWithTheme({
      title: 'X',
      clientScripts: ['/x.js?q=" onload="alert(1)'],
    });
    assert.doesNotMatch(html, /onload="alert/);
    assert.match(html, /&quot; onload=&quot;alert/);
  });
});

describe('panelDocumentOptions', () => {
  it('lifts the panel theme fields under the given title', () => {
    const panel = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
      theme: 'dark',
      themeCustomization: { css: 'body { color: red; }' },
      clientScripts: ['/app.js'],
    });
    const options = panelDocumentOptions(panel, 'Dashboard');
    assert.equal(options.title, 'Dashboard');
    assert.equal(options.theme, 'dark');
    assert.deepEqual(options.themeCustomization, { css: 'body { color: red; }' });
    assert.deepEqual(options.clientScripts, ['/app.js']);
    assert.equal(options.themeTokens, undefined);
  });

  it('renders through renderAdminDocumentWithTheme with every field applied', () => {
    const panel = defineAdminPanel({
      resolveSession: () => SESSION,
      authorize: () => true,
      theme: 'light',
      clientScripts: ['/app.js'],
    });
    const html = renderAdminDocumentWithTheme(panelDocumentOptions(panel, 'Dashboard'));
    assert.match(html, /<title>Dashboard<\/title>/);
    assert.match(html, /<html[^>]*data-theme="light"/);
    assert.match(html, /<script type="module" src="\/app.js"><\/script>/);
  });
});
