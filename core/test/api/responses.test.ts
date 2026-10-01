import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Respond } from '../../src/api/responses.js';

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

  it('rejects unsafe redirect targets and non-redirect statuses', () => {
    assert.throws(() => Respond.redirect('javascript:alert(1)'), TypeError);
    assert.throws(() => Respond.redirect('/a b'), TypeError);
    assert.throws(() => Respond.redirect('/x', { status: 200 }), TypeError);
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
