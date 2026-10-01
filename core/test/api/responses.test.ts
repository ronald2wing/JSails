/**
 * Tests for the `Respond` helpers: JSON, redirect, and empty responses with
 * the expected status codes and headers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Respond } from '../../src/api/responses.js';
import { isSameOriginPath, RedirectErrors, safeRedirectPath } from '../../src/api/index.js';

describe('Respond', () => {
  it('builds JSON responses with the right content type', async () => {
    const response = Respond.json({ ok: true });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(await response.json(), { ok: true });
  });

  it('serializes undefined JSON as null', async () => {
    const response = Respond.json(undefined);
    assert.equal(await response.text(), 'null');
  });

  it('lets the caller override the JSON content type', () => {
    const response = Respond.json({}, { headers: { 'content-type': 'application/vnd.api+json' } });
    assert.equal(response.headers.get('content-type'), 'application/vnd.api+json');
  });

  it('builds HTML, text, and XML responses', async () => {
    const html = Respond.html('<h1>Hi</h1>');
    assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await html.text(), '<h1>Hi</h1>');

    const text = Respond.text('hello');
    assert.equal(text.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await text.text(), 'hello');

    const xml = Respond.xml('<rss/>');
    assert.equal(xml.headers.get('content-type'), 'application/xml; charset=utf-8');
    assert.equal(await xml.text(), '<rss/>');
  });

  it('redirects with 303 by default and accepts another redirect status', () => {
    const response = Respond.redirect('/dashboard');
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/dashboard');

    const temporary = Respond.redirect('/login', { status: 302 });
    assert.equal(temporary.status, 302);
  });

  it('refuses a target that could leave the origin, and a non-redirect status', () => {
    for (const target of [
      'javascript:alert(1)',
      'https://example.com/',
      '//evil.example/',
      '/\\evil.example',
      'relative',
      '/a/../../b',
      '/a/%2e%2e/b',
      '/a\nb',
      '',
    ]) {
      assert.throws(
        () => Respond.redirect(target),
        (error: unknown) => RedirectErrors.is(error, 'invalid_target'),
      );
    }
    assert.throws(
      () => Respond.redirect('/x', { status: 200 }),
      (error: unknown) => RedirectErrors.is(error, 'invalid_status'),
    );
  });

  it('percent-encodes a same-origin target for the header', () => {
    assert.equal(Respond.redirect('/a b/café').headers.get('location'), '/a%20b/caf%C3%A9');
  });

  it('redirects to an absolute http(s) URL only through redirectExternal', () => {
    const response = Respond.redirectExternal('https://pay.example/checkout?id=1');
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), 'https://pay.example/checkout?id=1');
    const url = Respond.redirectExternal(new URL('https://id.example/a'), { status: 307 });
    assert.equal(url.status, 307);
    for (const target of [
      '/local',
      'javascript:alert(1)',
      'https://u:p@example.com/',
      'ftp://x/',
    ]) {
      assert.throws(
        () => Respond.redirectExternal(target),
        (error: unknown) => RedirectErrors.is(error, 'invalid_external_target'),
      );
    }
  });

  it('keeps a request-supplied target on the origin with safeRedirectPath', () => {
    assert.equal(safeRedirectPath('/account?tab=1', '/'), '/account?tab=1');
    for (const input of ['https://evil.example/', '//evil.example', '/\\evil', 42, undefined]) {
      assert.equal(safeRedirectPath(input, '/home'), '/home');
    }
    assert.throws(
      () => safeRedirectPath('/x', 'https://evil.example/'),
      (error: unknown) => RedirectErrors.is(error, 'invalid_fallback'),
    );
    assert.equal(isSameOriginPath('/ok'), true);
    assert.equal(isSameOriginPath('//no'), false);
  });

  it('builds empty responses with 204 by default', async () => {
    const response = Respond.noContent();
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
  });

  it('rejects a non-empty noContent status', () => {
    assert.throws(() => Respond.noContent({ status: 200 }), TypeError);
  });

  it('builds download responses with a safe filename', async () => {
    const response = Respond.download('data', 'report.csv', {
      headers: { 'content-type': 'text/csv; charset=utf-8' },
    });
    assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="report.csv"');
    assert.equal(await response.text(), 'data');
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(Respond));
  });
});
