/**
 * `adaptInertiaResponse` on responses the engine did not produce (P-6
 * Response Headers, P-16 Redirects; clause numbering as in props.test.ts):
 * `Vary` appending, redirect rewriting on immutable-header responses, and the
 * non-Inertia HTML page that becomes a location visit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { adaptInertiaResponse } from '../../src/index.js';
import { facts, inertiaHeaders } from './engine-fixture.js';

function html(body = '<h1>About</h1>', status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

describe('adaptInertiaResponse', () => {
  it('appends Vary to every response and is idempotent', async () => {
    const response = new Response('{}', {
      headers: { Vary: 'Origin', 'Content-Type': 'application/json' },
    });
    const once = adaptInertiaResponse(facts('/api'), response);
    assert.equal(once.headers.get('vary'), 'Origin, X-Inertia, Precognition');
    const twice = adaptInertiaResponse(facts('/api'), once);
    assert.equal(twice.headers.get('vary'), 'Origin, X-Inertia, Precognition');
    assert.equal(await twice.text(), '{}');
  });

  it('leaves Vary: * alone', () => {
    const response = adaptInertiaResponse(facts('/'), new Response('', { headers: { Vary: '*' } }));
    assert.equal(response.headers.get('vary'), '*');
  });

  it('turns a Response.redirect 302 into a 303 after PUT, PATCH, DELETE, and QUERY', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'QUERY']) {
      const adapted = adaptInertiaResponse(
        facts('/tasks/1', inertiaHeaders(), { method }),
        Response.redirect('https://example.test/tasks', 302),
      );
      assert.equal(adapted.status, 303, method);
      assert.equal(adapted.headers.get('location'), 'https://example.test/tasks');
    }
    for (const method of ['POST', 'GET']) {
      const adapted = adaptInertiaResponse(
        facts('/tasks/1', inertiaHeaders(), { method }),
        Response.redirect('https://example.test/tasks', 302),
      );
      assert.equal(adapted.status, 302, method);
    }
    const plain = adaptInertiaResponse(
      facts('/tasks/1', {}, { method: 'PUT' }),
      Response.redirect('https://example.test/tasks', 302),
    );
    assert.equal(plain.status, 302);
  });

  it('turns an off-origin redirect into a 409 location visit, keeping cookies', async () => {
    const response = new Response(null, {
      status: 302,
      headers: {
        Location: 'https://sso.example/login?next=%2F',
        'Set-Cookie': 'state=abc; Path=/; HttpOnly',
        'X-Inertia': 'true',
      },
    });
    const adapted = adaptInertiaResponse(facts('/', inertiaHeaders()), response);
    assert.equal(adapted.status, 409);
    assert.equal(adapted.headers.get('x-inertia-location'), 'https://sso.example/login?next=%2F');
    assert.equal(adapted.headers.get('location'), null);
    assert.equal(adapted.headers.get('x-inertia'), null);
    assert.deepEqual(adapted.headers.getSetCookie(), ['state=abc; Path=/; HttpOnly']);
    assert.equal(await adapted.text(), '');
  });

  it('turns a fragment redirect into a 409 X-Inertia-Redirect, except for prefetch', () => {
    const redirect = (): Response => Response.redirect('https://example.test/docs#setup', 303);
    const adapted = adaptInertiaResponse(
      facts('/', inertiaHeaders(), { method: 'POST' }),
      redirect(),
    );
    assert.equal(adapted.status, 409);
    assert.equal(adapted.headers.get('x-inertia-redirect'), 'https://example.test/docs#setup');
    const prefetch = adaptInertiaResponse(
      facts('/', inertiaHeaders({ Purpose: 'prefetch' })),
      redirect(),
    );
    assert.equal(prefetch.status, 303);
    assert.equal(prefetch.headers.get('location'), 'https://example.test/docs#setup');
  });

  it('turns a non-Inertia HTML page answering an Inertia GET into a location visit', async () => {
    const adapted = adaptInertiaResponse(facts('/about?lang=en', inertiaHeaders()), html());
    assert.equal(adapted.status, 409);
    assert.equal(adapted.headers.get('x-inertia-location'), '/about?lang=en');
    assert.equal(adapted.headers.get('content-type'), null);
    assert.equal(await adapted.text(), '');
  });

  it('leaves Inertia pages, non-GET, non-HTML, error, and non-Inertia answers alone', async () => {
    const page = new Response('{}', {
      headers: { 'Content-Type': 'application/json', 'X-Inertia': 'true' },
    });
    assert.equal(adaptInertiaResponse(facts('/', inertiaHeaders()), page).status, 200);
    const inertiaHtml = new Response('<html>', {
      headers: { 'Content-Type': 'text/html', 'X-Inertia': 'true' },
    });
    assert.equal(adaptInertiaResponse(facts('/', inertiaHeaders()), inertiaHtml).status, 200);
    assert.equal(
      adaptInertiaResponse(facts('/', inertiaHeaders(), { method: 'POST' }), html()).status,
      200,
    );
    assert.equal(adaptInertiaResponse(facts('/', inertiaHeaders()), html('x', 500)).status, 500);
    const fromBrowser = adaptInertiaResponse(facts('/'), html('<p>kept</p>'));
    assert.equal(fromBrowser.status, 200);
    assert.equal(await fromBrowser.text(), '<p>kept</p>');
  });

  it('replaces a page whose body is locked or whose cancel throws without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      const locked = html();
      const reader = locked.body?.getReader();
      const adapted = adaptInertiaResponse(facts('/about', inertiaHeaders()), locked);
      assert.equal(adapted.status, 409);
      assert.equal(locked.body?.locked, true);
      const throwing = new Response(
        new ReadableStream({
          cancel() {
            throw new Error('source refuses to cancel');
          },
        }),
        { headers: { 'Content-Type': 'text/html' } },
      );
      assert.equal(adaptInertiaResponse(facts('/about', inertiaHeaders()), throwing).status, 409);
      await new Promise((resolve) => setTimeout(resolve, 10));
      reader?.releaseLock();
    } finally {
      process.off('unhandledRejection', record);
    }
    assert.deepEqual(unhandled, []);
  });

  it('cancels the body of a page it replaces', async () => {
    let cancelled = false;
    const page = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'Content-Type': 'text/html' } },
    );
    adaptInertiaResponse(facts('/about', inertiaHeaders()), page);
    await Promise.resolve();
    assert.equal(cancelled, true);
  });

  it('returns a network-error response unchanged', () => {
    const failed = Response.error();
    assert.equal(adaptInertiaResponse(facts('/', inertiaHeaders()), failed), failed);
    assert.equal(adaptInertiaResponse(facts('/'), failed), failed);
  });

  it('marks every response to a Precognition request', () => {
    const adapted = adaptInertiaResponse(
      facts('/users', { Precognition: 'true' }, { method: 'POST' }),
      new Response(null, { status: 403 }),
    );
    assert.equal(adapted.headers.get('precognition'), 'true');
    assert.equal(adapted.headers.get('vary'), 'X-Inertia, Precognition');
  });
});
