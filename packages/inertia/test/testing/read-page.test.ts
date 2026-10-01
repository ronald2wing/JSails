/**
 * `readInertiaPage`: the page from the JSON representation and from the
 * document's data element (custom root ids, SSR documents), big integers
 * revived as `parsePage` revives them, and `not_a_page` for every response
 * that carries no page.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parsePage } from '@inertiajs/core/json';

import {
  defineInertia,
  inertiaLocation,
  outcomeToResponse,
  requestFacts,
  resolveInertia,
  serializePage,
  escapeScriptJson,
  InertiaError,
  type InertiaOptions,
  type InertiaRenderSpec,
} from '../../src/index.js';
import { inertiaRequest, readInertiaPage } from '../../src/testing/index.js';

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof InertiaError && error.code === expected;
}

async function render(
  request: Request,
  spec: InertiaRenderSpec,
  options: Partial<InertiaOptions> = {},
): Promise<Response> {
  const config = defineInertia({ version: 'v1', ...options });
  return outcomeToResponse(await resolveInertia(config, requestFacts(request), spec));
}

const SPEC: InertiaRenderSpec = {
  component: 'Users/Show',
  props: { user: { id: 7n, name: '</script><b>x</b>', joined: new Date(0) } },
};

describe('readInertiaPage', () => {
  it('reads the JSON page of an Inertia response and revives big integers', async () => {
    const response = await render(inertiaRequest('/users/7', { version: 'v1' }), SPEC);
    const page = await readInertiaPage(response);
    assert.equal(page.component, 'Users/Show');
    assert.equal(page.url, '/users/7');
    assert.deepEqual(page.props, {
      errors: {},
      user: { id: 7n, name: '</script><b>x</b>', joined: '1970-01-01T00:00:00.000Z' },
    });
    assert.equal(page.preserveBigIntegers, true);
  });

  it('reads the page of the HTML document exactly as the client parses it', async () => {
    const response = await render(new Request('http://localhost/users/7'), SPEC, {
      rootId: 'root',
    });
    const page = await readInertiaPage(response, { rootId: 'root' });
    const html = await response.text();
    const start = html.indexOf('type="application/json">') + 'type="application/json">'.length;
    const reference: unknown = parsePage(html.slice(start, html.indexOf('</script>', start)));
    assert.deepEqual(page, reference);
  });

  it('reads the page of a server-rendered document', async () => {
    const response = await render(
      new Request('http://localhost/'),
      { component: 'Home', props: { title: 'Hi' } },
      {
        ssr: {
          gateway: {
            render: (page) =>
              Promise.resolve({
                head: ['<title>Hi</title>'],
                body:
                  `<script data-page="app" type="application/json">` +
                  `${escapeScriptJson(serializePage(page))}</script>` +
                  '<div data-server-rendered="true" id="app"><h1>Hi</h1></div>',
              }),
          },
        },
      },
    );
    const page = await readInertiaPage(response);
    assert.deepEqual(page, {
      component: 'Home',
      props: { errors: {}, title: 'Hi' },
      url: '/',
      version: 'v1',
    });
  });

  it('does not consume the response body', async () => {
    const response = await render(inertiaRequest('/users/7', { version: 'v1' }), SPEC);
    await readInertiaPage(response);
    assert.equal(response.bodyUsed, false);
  });

  it('rejects every response that carries no page', async () => {
    const facts = requestFacts(inertiaRequest('/x', { version: 'v1' }));
    const responses = [
      outcomeToResponse(inertiaLocation(facts, 'https://elsewhere.test/')),
      await render(inertiaRequest('/users/7', { version: 'stale' }), SPEC),
      new Response('<!doctype html><div id="app"></div>', {
        headers: { 'content-type': 'text/html' },
      }),
      new Response('<script data-page="app" type="application/json">{"component":"A"', {
        headers: { 'content-type': 'text/html' },
      }),
      new Response('{"component":"A"}', {
        headers: { 'content-type': 'application/json', 'x-inertia': 'true' },
      }),
      new Response('not json', {
        headers: { 'content-type': 'application/json', 'x-inertia': 'true' },
      }),
      new Response(
        JSON.stringify({
          component: 'A',
          props: { n: { $bigint: '12abc' } },
          url: '/',
          version: '',
          preserveBigIntegers: true,
        }),
        { headers: { 'content-type': 'application/json', 'x-inertia': 'true' } },
      ),
      new Response('{"component":"A","props":{},"url":"/","version":""}', {
        headers: { 'content-type': 'application/json' },
      }),
    ];
    for (const response of responses) {
      await assert.rejects(readInertiaPage(response), code('not_a_page'));
    }
    await assert.rejects(
      readInertiaPage(new Response(''), { rootId: 'bad id' }),
      code('invalid_options'),
    );
  });
});
