/**
 * Tests for notices: descriptor validation, `?_notice=<code>` mapping through
 * the panel registry to an escaped flash message, and the unknown-code drop.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToString } from 'jsails/render-to-string';
import type { VNode } from 'preact';

import { AdminDefinitionError, defineNotice, renderNotice, type Notice } from '../src/index.js';

import { createAdminTestApp } from './fixtures.js';

describe('admin notice descriptor validation', () => {
  it('rejects an invalid code, level, or empty message', () => {
    assert.throws(
      () => defineNotice('bad/code', { level: 'success', message: 'x' }),
      AdminDefinitionError,
    );
    assert.throws(
      () => defineNotice('ok', { level: 'bogus' as never, message: 'x' }),
      AdminDefinitionError,
    );
    assert.throws(
      () => defineNotice('ok', { level: 'success', message: '  ' }),
      AdminDefinitionError,
    );
  });

  it('freezes a valid descriptor', () => {
    const notice = defineNotice('saved', { level: 'success', message: 'Saved.' });
    assert.equal(Object.isFrozen(notice), true);
    assert.equal(notice.code, 'saved');
    assert.equal(notice.level, 'success');
  });
});

describe('admin notice rendering', () => {
  it('maps a registered notice code to its message on the dashboard', async () => {
    const app = await createAdminTestApp({
      notices: [
        defineNotice('saved', { level: 'success', message: 'Record saved.' }),
        defineNotice('deleted', { level: 'warning', message: 'Record deleted.' }),
      ],
    });

    const saved = await (await app.request('/admin?_notice=saved')).text();
    assert.match(saved, /admin-notice/);
    assert.match(saved, /Record saved\./);
    assert.match(saved, /role="status"/);

    await app.close();
  });

  it('drops an unknown notice code without rendering a message', async () => {
    const app = await createAdminTestApp({
      notices: [defineNotice('saved', { level: 'success', message: 'Record saved.' })],
    });

    const body = await (await app.request('/admin?_notice=forged')).text();
    assert.doesNotMatch(body, /admin-notice/);

    await app.close();
  });

  it('escapes a hostile notice message', async () => {
    const app = await createAdminTestApp({
      notices: [defineNotice('x', { level: 'info', message: '<b>bold</b>' })],
    });

    const body = await (await app.request('/admin?_notice=x')).text();
    assert.doesNotMatch(body, /<b>bold<\/b>/);
    assert.match(body, /&lt;b>bold&lt;\/b>/);

    await app.close();
  });

  it('rejects a non-array notices value and duplicate notice codes', () => {
    assert.throws(
      () => createAdminTestApp({ notices: 'nope' as unknown as readonly Notice[] }),
      AdminDefinitionError,
    );
    const notices = [
      defineNotice('dup', { level: 'success', message: 'A' }),
      defineNotice('dup', { level: 'info', message: 'B' }),
    ];
    assert.throws(() => createAdminTestApp({ notices }), AdminDefinitionError);
  });
});

describe('renderNotice', () => {
  it('renders an escaped status banner', () => {
    const html = renderToString(renderNotice('<b>Saved</b>') as VNode);
    assert.match(html, /role="status"/);
    assert.match(html, /admin-notice/);
    assert.doesNotMatch(html, /<b>/);
  });
});
