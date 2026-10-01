/**
 * `inertiaRequest`: the headers an Inertia v3 client sends, validated values,
 * and a round trip through `requestFacts` and the engine.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  readInertiaVisit,
  requestFacts,
  resolveInertia,
  InertiaError,
  defineInertia,
  optional,
} from '../../src/index.js';
import { inertiaRequest, INERTIA_TEST_ORIGIN } from '../../src/testing/index.js';

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof InertiaError && error.code === expected;
}

describe('inertiaRequest', () => {
  it('sends the headers every client visit carries and resolves a relative URL', () => {
    const request = inertiaRequest('/users?page=2');
    assert.equal(request.url, `${INERTIA_TEST_ORIGIN}/users?page=2`);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.get('x-inertia'), 'true');
    assert.equal(request.headers.get('x-requested-with'), 'XMLHttpRequest');
    assert.equal(request.headers.get('accept'), 'text/html, application/xhtml+xml');
    assert.equal(request.headers.has('x-inertia-version'), false);
  });

  it('maps every option onto its v3 header', () => {
    const request = inertiaRequest(new URL('https://app.test/feed'), {
      method: 'POST',
      body: '{}',
      headers: { 'X-Custom': 'kept' },
      version: 'v7',
      partial: {
        component: 'Feed',
        only: ['posts', 'user.name'],
        except: ['stats'],
        reset: ['posts'],
      },
      errorBag: 'createPost',
      exceptOnce: ['plans'],
      prefetch: true,
      precognition: { validateOnly: ['title', 'tags.*'] },
    });
    const visit = readInertiaVisit(request.headers);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('x-custom'), 'kept');
    assert.deepEqual(visit, {
      isInertia: true,
      version: 'v7',
      partial: { component: 'Feed', only: ['posts', 'user.name', 'posts'], except: ['stats'] },
      reset: ['posts'],
      exceptOnce: ['plans'],
      errorBag: 'createPost',
      mergeIntent: 'append',
      prefetch: true,
    });
    assert.equal(request.headers.get('x-inertia-partial-data'), 'posts,user.name,posts');
    assert.equal(request.headers.get('precognition'), 'true');
    assert.equal(request.headers.get('precognition-validate-only'), 'title,tags.*');
  });

  it('selects reset props in X-Inertia-Partial-Data, as the client does', () => {
    const request = inertiaRequest('/feed', { partial: { component: 'Feed', reset: ['feed'] } });
    assert.equal(request.headers.get('x-inertia-partial-component'), 'Feed');
    assert.equal(request.headers.get('x-inertia-partial-data'), 'feed');
    assert.equal(request.headers.get('x-inertia-reset'), 'feed');
  });

  it('sends no partial headers when only, except, and reset are all empty', () => {
    const request = inertiaRequest('/feed', { partial: { component: 'Feed', only: [] } });
    for (const name of [
      'x-inertia-partial-component',
      'x-inertia-partial-data',
      'x-inertia-partial-except',
      'x-inertia-reset',
    ]) {
      assert.equal(request.headers.has(name), false, name);
    }
    assert.equal(readInertiaVisit(request.headers).partial, null);
  });

  it('sends the infinite-scroll merge intent', () => {
    const request = inertiaRequest('/feed', { mergeIntent: 'prepend' });
    assert.equal(request.headers.get('x-inertia-infinite-scroll-merge-intent'), 'prepend');
    assert.equal(readInertiaVisit(request.headers).mergeIntent, 'prepend');
  });

  it('sends Precognition without a validate-only list when no field is named', () => {
    const request = inertiaRequest('/users', { method: 'POST', precognition: {} });
    assert.equal(request.headers.get('precognition'), 'true');
    assert.equal(request.headers.has('precognition-validate-only'), false);
  });

  it('rejects values the client could never send', () => {
    for (const init of [
      { partial: { component: '' } },
      { partial: { component: 'Feed', only: ['a,b'] } },
      { partial: { component: 'Feed', only: [''] } },
      { exceptOnce: ['plans\r\nX-Evil: 1'] },
      { errorBag: 'bag\n' },
      { prefetch: 'yes' as unknown as boolean },
      { exceptOnce: 'plans' as unknown as readonly string[] },
      { mergeIntent: 'sideways' as unknown as 'append' },
      { partial: { component: 'Feed', reset: ['a,b'] } },
    ]) {
      assert.throws(() => inertiaRequest('/', init), code('invalid_options'));
    }
  });

  it('round-trips a reset reload, so only the reset prop resolves', async () => {
    const config = defineInertia({ version: 'v1' });
    const calls: string[] = [];
    const props = {
      feed: optional(() => {
        calls.push('feed');
        return ['a'];
      }),
      stats: () => {
        calls.push('stats');
        return 3;
      },
    };
    const facts = requestFacts(
      inertiaRequest('/feed', { version: 'v1', partial: { component: 'Feed', reset: ['feed'] } }),
    );
    const outcome = await resolveInertia(config, facts, { component: 'Feed', props });
    assert.deepEqual(calls, ['feed']);
    if (outcome.kind === 'page') assert.deepEqual(outcome.page.props, { errors: {}, feed: ['a'] });
  });

  it('round-trips through requestFacts into the engine', async () => {
    const config = defineInertia({ version: 'v1' });
    let resolved = 0;
    const props = {
      title: 'Feed',
      stats: optional(() => {
        resolved += 1;
        return 3;
      }),
    };
    const facts = requestFacts(
      inertiaRequest('/feed', { version: 'v1', partial: { component: 'Feed', only: ['stats'] } }),
    );
    assert.equal(facts.method, 'GET');
    assert.equal(facts.url.pathname, '/feed');
    const outcome = await resolveInertia(config, facts, { component: 'Feed', props });
    assert.equal(outcome.kind, 'page');
    assert.equal(resolved, 1);
    if (outcome.kind === 'page') assert.deepEqual(outcome.page.props, { errors: {}, stats: 3 });
  });
});

describe('requestFacts', () => {
  it('upper-cases the method and keeps the headers and signal of the request', () => {
    const controller = new AbortController();
    const request = new Request('https://app.test/x?y=1', {
      method: 'patch',
      headers: { 'X-Inertia': 'true' },
      signal: controller.signal,
    });
    const facts = requestFacts(request);
    assert.equal(facts.method, 'PATCH');
    assert.equal(facts.url.href, 'https://app.test/x?y=1');
    assert.equal(facts.headers.get('x-inertia'), 'true');
    controller.abort();
    assert.equal(facts.signal.aborted, true);
    assert.ok(Object.isFrozen(facts));
  });
});
