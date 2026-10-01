/**
 * The outcome layer against the Inertia v3 protocol: page and document
 * outcomes, the version guard, response headers, redirects, and the 409
 * control responses.
 *
 * Clause ids number the H2 sections of
 * <https://inertiajs.com/docs/v3/core-concepts/the-protocol> (checked
 * 2026-11-19), as in props.test.ts: P-2 HTML Responses, P-3 Inertia
 * Responses, P-6 Response Headers, P-15 Asset Versioning, P-16 Redirects.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defer,
  defineInertia,
  inertiaBack,
  inertiaLocation,
  inertiaRedirect,
  InertiaError,
  outcomeToResponse,
  readInertiaVisit,
  resolveInertia,
  serializePage,
  versionGuard,
  type InertiaOutcome,
} from '../../src/index.js';
import { decideRedirect } from '../../src/control.js';
import {
  engine,
  facts,
  header,
  inertiaHeaders,
  jsonBody,
  seeded,
  setCookies,
  TEST_SEALER,
} from './engine-fixture.js';

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof InertiaError && error.code === expected;
}

const PROPS = { event: { id: 80, title: 'Birthday party' } };

describe('page outcomes (P-2, P-3, P-6)', () => {
  it('answers an Inertia visit with the JSON page and X-Inertia (P-3)', async () => {
    const outcome = await resolveInertia(engine(), facts('/events/80?tab=1', inertiaHeaders()), {
      component: 'Event',
      props: PROPS,
    });
    assert.equal(outcome.kind, 'page');
    assert.equal(outcome.status, 200);
    assert.equal(header(outcome, 'content-type'), 'application/json');
    assert.equal(header(outcome, 'x-inertia'), 'true');
    assert.equal(header(outcome, 'vary'), 'X-Inertia, Precognition');
    assert.equal(header(outcome, 'cache-control'), 'private');
    assert.ok(outcome.kind === 'page');
    assert.equal(outcome.body, serializePage(outcome.page));
    assert.deepEqual(jsonBody(outcome), {
      component: 'Event',
      props: { errors: {}, event: { id: 80, title: 'Birthday party' } },
      url: '/events/80?tab=1',
      version: 'v1',
    });
  });

  it('answers a first visit with the HTML document and no X-Inertia (P-2)', async () => {
    const outcome = await resolveInertia(
      engine(undefined, { assets: { scripts: ['/assets/app.js'] }, lang: 'en' }),
      facts('/events/80'),
      { component: 'Event', props: PROPS },
    );
    assert.equal(outcome.kind, 'document');
    assert.equal(header(outcome, 'content-type'), 'text/html; charset=utf-8');
    assert.equal(header(outcome, 'x-inertia'), null);
    assert.equal(header(outcome, 'vary'), 'X-Inertia, Precognition');
    assert.ok(outcome.body !== null);
    assert.ok(outcome.body.startsWith('<!DOCTYPE html><html lang="en">'));
    assert.ok(outcome.body.includes('<script type="module" src="/assets/app.js"></script>'));
    assert.ok(outcome.body.includes('<script data-page="app" type="application/json">'));
  });

  it('appends Vary to a caller Vary and keeps a caller Cache-Control (P-6)', async () => {
    const outcome = await resolveInertia(engine(), facts('/', inertiaHeaders()), {
      component: 'Home',
      props: {},
      headers: {
        Vary: 'Accept-Encoding',
        'Cache-Control': 'private, max-age=5',
        'Content-Type': 'text/plain',
        'X-Trace': 'abc',
      },
    });
    assert.equal(header(outcome, 'vary'), 'Accept-Encoding, X-Inertia, Precognition');
    assert.equal(header(outcome, 'cache-control'), 'private, max-age=5');
    assert.equal(header(outcome, 'content-type'), 'application/json');
    assert.equal(header(outcome, 'x-trace'), 'abc');
  });

  for (const [label, extra] of [
    ['partial', { 'X-Inertia-Partial-Component': 'Home', 'X-Inertia-Partial-Data': 'a' }],
    ['except-once', { 'X-Inertia-Except-Once-Props': 'plans' }],
    ['reset', { 'X-Inertia-Reset': 'feed' }],
    ['error-bag', { 'X-Inertia-Error-Bag': 'login' }],
  ] as const) {
    it(`marks a response to a ${label} request no-store`, async () => {
      const outcome = await resolveInertia(engine(), facts('/', inertiaHeaders(extra)), {
        component: 'Home',
        props: { a: 1 },
        headers: { 'Cache-Control': 'public' },
      });
      assert.equal(header(outcome, 'cache-control'), 'private, no-store');
    });
  }

  it('answers HEAD with the GET status and headers and no body', async () => {
    for (const headers of [inertiaHeaders(), {}]) {
      const outcome = await resolveInertia(engine(), facts('/', headers, { method: 'HEAD' }), {
        component: 'Home',
        props: {},
        status: 404,
      });
      assert.equal(outcome.status, 404);
      assert.equal(outcome.body, null);
      assert.ok(header(outcome, 'content-type') !== null);
    }
  });

  it('rejects a redirect or informational render status and a bad component first', async () => {
    let called = false;
    const props = {
      lazy: () => {
        called = true;
        return 1;
      },
    };
    for (const status of [302, 409.5, 100, 600]) {
      await assert.rejects(
        resolveInertia(engine(), facts('/'), { component: 'Home', props, status }),
        code('invalid_options'),
      );
    }
    await assert.rejects(
      resolveInertia(engine(), facts('/'), { component: '', props }),
      code('invalid_component'),
    );
    assert.equal(called, false);
  });

  it('reports shared prop keys and gives share() the request context', async () => {
    const seen: string[] = [];
    const config = engine(undefined, {
      share: (context) => {
        seen.push(`${context.component} ${context.method} ${context.url.pathname}`);
        return { auth: { user: null }, title: 'shared' };
      },
    });
    const outcome = await resolveInertia(config, facts('/a', inertiaHeaders()), {
      component: 'Home',
      props: { title: 'page' },
    });
    assert.deepEqual(seen, ['Home GET /a']);
    assert.ok(outcome.kind === 'page');
    assert.deepEqual(outcome.page.props, { errors: {}, auth: { user: null }, title: 'page' });
    assert.deepEqual(outcome.page.sharedProps, ['auth', 'title']);
  });

  it('applies the configured encryptHistory unless the render overrides it', async () => {
    const config = engine(undefined, { encryptHistory: true });
    const on = await resolveInertia(config, facts('/', inertiaHeaders()), {
      component: 'Home',
      props: {},
    });
    const off = await resolveInertia(config, facts('/', inertiaHeaders()), {
      component: 'Home',
      props: {},
      encryptHistory: false,
    });
    assert.ok(on.kind === 'page' && off.kind === 'page');
    assert.equal(on.page.encryptHistory, true);
    assert.equal(off.page.encryptHistory, undefined);
  });

  it('warns once per config when encryptHistory is served outside a secure context', async (t) => {
    const warn = t.mock.method(console, 'warn', () => undefined);
    const render = (config: ReturnType<typeof engine>, origin: string) =>
      resolveInertia(config, facts('/', inertiaHeaders(), { origin }), {
        component: 'Home',
        props: {},
      });
    const development = { encryptHistory: true, mode: 'development' } as const;
    const secure = engine(undefined, development);
    for (const origin of [
      'https://app.example',
      'http://localhost:3000',
      'http://app.localhost',
      'http://127.0.0.1',
      'http://127.8.9.10',
      'http://[::1]:8080',
    ]) {
      await render(secure, origin);
    }
    assert.equal(warn.mock.callCount(), 0);

    const insecure = engine(undefined, development);
    await render(insecure, 'http://192.168.1.20:3000');
    await render(insecure, 'http://app.example');
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /secure context/u);

    await render(engine(undefined, { mode: 'development' }), 'http://app.example');
    assert.equal(warn.mock.callCount(), 1);

    // The production mode, which is also the default, never warns.
    await render(engine(undefined, { encryptHistory: true }), 'http://app.example');
    await render(
      engine(undefined, { encryptHistory: true, mode: 'production' }),
      'http://app.example',
    );
    assert.equal(warn.mock.callCount(), 1);
  });

  it('routes a rescued deferred prop failure to report with its path', async () => {
    const reports: unknown[][] = [];
    const config = engine(undefined, { report: (...args) => reports.push(args) });
    const failure = new Error('down');
    const outcome = await resolveInertia(
      config,
      facts(
        '/',
        inertiaHeaders({
          'X-Inertia-Partial-Component': 'Home',
          'X-Inertia-Partial-Data': 'stats',
        }),
      ),
      {
        component: 'Home',
        props: {
          stats: defer(() => Promise.reject(failure), { rescue: true }),
        },
      },
    );
    assert.ok(outcome.kind === 'page');
    assert.deepEqual(outcome.page.rescuedProps, ['stats']);
    assert.deepEqual(reports, [[failure, 'rescued_prop', 'stats']]);
  });

  it('maps an outcome to a Response, keeping repeated Set-Cookie', async () => {
    const outcome: InertiaOutcome = {
      kind: 'redirect',
      location: '/next',
      status: 303,
      headers: [
        ['location', '/next'],
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ],
      body: null,
    };
    const response = outcomeToResponse(outcome);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/next');
    assert.deepEqual(response.headers.getSetCookie(), ['a=1', 'b=2']);
    assert.equal(await response.text(), '');
  });
});

describe('version guard (P-15)', () => {
  it('answers a stale Inertia GET with 409, X-Inertia-Location, and X-Inertia-Version', async () => {
    let called = false;
    const config = engine(undefined, { version: () => 'v2' });
    const outcome = await resolveInertia(config, facts('/events?x=1', inertiaHeaders()), {
      component: 'Events',
      props: {
        lazy: () => {
          called = true;
          return 1;
        },
      },
    });
    assert.equal(outcome.kind, 'control');
    assert.equal(outcome.status, 409);
    // The protocol names the full URL; the path and query resolve to it on the client.
    assert.equal(header(outcome, 'x-inertia-location'), '/events?x=1');
    assert.equal(header(outcome, 'x-inertia-version'), 'v2');
    assert.equal(header(outcome, 'x-inertia'), null);
    assert.equal(outcome.body, null);
    assert.equal(called, false);
  });

  it('compares a missing X-Inertia-Version as the empty string', async () => {
    const versioned = await resolveInertia(engine(), facts('/', { 'X-Inertia': 'true' }), {
      component: 'Home',
      props: {},
    });
    assert.equal(versioned.kind, 'control');
    const unversioned = await resolveInertia(
      engine(undefined, { version: null }),
      facts('/', { 'X-Inertia': 'true' }),
      { component: 'Home', props: {} },
    );
    assert.equal(unversioned.kind, 'page');
  });

  it('guards GET and HEAD Inertia visits only', async () => {
    const stale = { 'X-Inertia': 'true', 'X-Inertia-Version': 'old' };
    const config = engine();
    assert.equal(versionGuard(config, facts('/', stale))?.status, 409);
    assert.equal(versionGuard(config, facts('/', stale, { method: 'HEAD' }))?.status, 409);
    assert.equal(versionGuard(config, facts('/', stale, { method: 'POST' })), null);
    assert.equal(versionGuard(config, facts('/', { 'X-Inertia-Version': 'old' })), null);
    assert.equal(versionGuard(config, facts('/', inertiaHeaders())), null);
  });

  it('reads a version function on every request and rejects a non-string', async () => {
    let version = 'a';
    const config = defineInertia({ version: () => version });
    assert.equal(
      versionGuard(config, facts('/', { 'X-Inertia': 'true', 'X-Inertia-Version': 'a' })),
      null,
    );
    version = 'b';
    assert.equal(
      versionGuard(config, facts('/', { 'X-Inertia': 'true', 'X-Inertia-Version': 'a' }))?.target,
      '/',
    );
    for (const produced of [7, 'v\r\n', ' v', 'v ', '日本', 'caf\u00e9']) {
      const broken = defineInertia({ version: () => produced as unknown as string });
      assert.throws(
        () => versionGuard(broken, facts('/', { 'X-Inertia': 'true' })),
        code('invalid_options'),
        String(produced),
      );
    }
    const spaced = defineInertia({ version: () => 'build 7' });
    assert.equal(
      versionGuard(spaced, facts('/', { 'X-Inertia': 'true', 'X-Inertia-Version': 'build 7' })),
      null,
    );
  });
});

describe('defineInertia', () => {
  it('rejects invalid options at configuration time', () => {
    const bad: unknown[] = [
      null,
      { version: 3 },
      { version: 'v', rootId: '1app' },
      { version: 'v', lang: 'en_US' },
      { version: 'v', encryptHistory: 'yes' },
      { version: 'v', carrier: { sealer: {} } },
      { version: 'v', carrier: { sealer: TEST_SEALER, maxAgeSeconds: 0 } },
      { version: 'v', carrier: { sealer: TEST_SEALER, maxAgeSeconds: 601 } },
      { version: 'v', carrier: { sealer: TEST_SEALER, oversize: 'truncate' } },
      { version: 'v', ssr: { gateway: {} } },
      { version: 'v', assets: 'app.js' },
      { version: 'v', assets: { scripts: '/app.js' } },
      { version: 'v', assets: { styles: [1] } },
      { version: 'v', assets: { preloads: [''] } },
      { version: 'v\n' },
      { version: ' v' },
      { version: 'v\u00e9' },
    ];
    for (const options of bad) {
      assert.throws(() => defineInertia(options as never), code('invalid_options'));
    }
    assert.throws(
      () => defineInertia({ version: 'v', errors: { backFallback: 'https://evil.example/' } }),
      code('invalid_redirect'),
    );
  });
});

describe('defineInertia assets', () => {
  it('copies fixed assets, so a later change to the caller list is not used', async () => {
    const scripts = ['/app.js'];
    const config = defineInertia({ version: 'v', assets: { scripts } });
    scripts.push('/evil.js');
    const outcome = await resolveInertia(config, facts('/'), { component: 'Home', props: {} });
    assert.ok(outcome.body?.includes('/app.js'));
    assert.equal(outcome.body?.includes('/evil.js'), false);
  });

  it('rejects malformed per-request assets with invalid_options', async () => {
    const config = defineInertia({
      version: 'v',
      assets: () => ({ scripts: '/app.js' }) as unknown as { scripts: string[] },
    });
    await assert.rejects(
      resolveInertia(config, facts('/'), { component: 'Home', props: {} }),
      code('invalid_options'),
    );
  });
});

describe('redirects (P-16)', () => {
  it('defaults to 302 after GET and 303 after a mutation', async () => {
    const config = engine();
    const get = await inertiaRedirect(config, facts('/', inertiaHeaders()), '/next');
    const post = await inertiaRedirect(
      config,
      facts('/', inertiaHeaders(), { method: 'POST' }),
      '/next',
    );
    assert.equal(get.status, 302);
    assert.equal(post.status, 303);
    assert.equal(header(post, 'location'), '/next');
    assert.equal(header(post, 'vary'), 'X-Inertia, Precognition');
  });

  it('turns a 302 into a 303 after PUT, PATCH, DELETE, and QUERY, not POST or GET', async () => {
    const config = engine();
    for (const method of ['PUT', 'PATCH', 'DELETE', 'QUERY']) {
      const outcome = await inertiaRedirect(
        config,
        facts('/', inertiaHeaders(), { method }),
        '/n',
        {
          status: 302,
        },
      );
      assert.equal(outcome.status, 303, method);
    }
    for (const method of ['POST', 'GET']) {
      const outcome = await inertiaRedirect(
        config,
        facts('/', inertiaHeaders(), { method }),
        '/n',
        {
          status: 302,
        },
      );
      assert.equal(outcome.status, 302, method);
    }
    const plain = await inertiaRedirect(config, facts('/', {}, { method: 'PUT' }), '/n', {
      status: 302,
    });
    assert.equal(plain.status, 302);
  });

  it('answers a fragment redirect with 409 X-Inertia-Redirect, except for prefetch', async () => {
    const config = engine();
    const control = await inertiaRedirect(config, facts('/', inertiaHeaders()), '/docs#install');
    assert.equal(control.kind, 'control');
    assert.equal(control.status, 409);
    assert.equal(header(control, 'x-inertia-redirect'), '/docs#install');
    assert.equal(header(control, 'location'), null);
    assert.equal(header(control, 'x-inertia'), null);
    const prefetch = await inertiaRedirect(
      config,
      facts('/', inertiaHeaders({ Purpose: 'prefetch' })),
      '/docs#install',
    );
    assert.equal(prefetch.kind, 'redirect');
    assert.equal(header(prefetch, 'location'), '/docs#install');
    const plain = await inertiaRedirect(config, facts('/'), '/docs#install');
    assert.equal(plain.kind, 'redirect');
  });

  it('rejects redirect targets that are not same-origin paths', async () => {
    const config = engine();
    for (const target of [
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'next',
      '',
      '/a/../b',
      '/a/%2E%2E/b',
      '/a\nb',
    ]) {
      await assert.rejects(
        inertiaRedirect(config, facts('/'), target),
        code('invalid_redirect'),
        target,
      );
    }
  });

  it('percent-encodes a target outside visible ASCII instead of failing or sending raw bytes', async () => {
    const config = engine();
    const rows: [string, string][] = [
      ['/日本', '/%E6%97%A5%E6%9C%AC'],
      ['/café?q=crème', '/caf%C3%A9?q=cr%C3%A8me'],
      ['/a b', '/a%20b'],
      ['/.//host', '/.//host'],
      ['/100%25', '/100%25'],
    ];
    for (const [target, sent] of rows) {
      const outcome = await inertiaRedirect(config, facts('/'), target);
      assert.equal(header(outcome, 'location'), sent, target);
      assert.equal(new URL(sent, 'https://example.test').origin, 'https://example.test');
    }
    const fragment = await inertiaRedirect(
      config,
      facts('/', inertiaHeaders(), { method: 'POST' }),
      '/café#top',
    );
    assert.equal(fragment.kind, 'control');
    assert.equal(header(fragment, 'x-inertia-redirect'), '/caf%C3%A9#top');
    await assert.rejects(inertiaRedirect(config, facts('/'), '/\ud800'), code('invalid_redirect'));
    const location = inertiaLocation(facts('/', inertiaHeaders()), '/naïve');
    assert.equal(header(location, 'x-inertia-location'), '/na%C3%AFve');
    const back = await inertiaBack(config, facts('/'), { fallback: '/über' });
    assert.equal(header(back, 'location'), '/%C3%BCber');
  });

  it('never redirects off-origin, for any generated target (property)', async () => {
    const random = seeded(0x1e47);
    const pieces = [
      '/',
      '\\',
      '//',
      ':',
      '.',
      '..',
      '@',
      '#',
      '?',
      '%2e',
      'evil.example',
      'http',
      'a',
      'é',
      '日',
      '\t',
      ' ',
      '%5c',
      ';',
    ];
    const config = engine();
    for (let sample = 0; sample < 2000; sample += 1) {
      let target = '';
      const length = 1 + Math.floor(random() * 6);
      for (let index = 0; index < length; index += 1) {
        target += pieces[Math.floor(random() * pieces.length)] ?? '';
      }
      const requestFacts = facts('/from', inertiaHeaders(), { method: 'POST' });
      let outcome: InertiaOutcome;
      try {
        outcome = await inertiaRedirect(config, requestFacts, target);
      } catch (error) {
        assert.ok(code('invalid_redirect')(error), target);
        continue;
      }
      const sent =
        outcome.kind === 'control'
          ? header(outcome, 'x-inertia-redirect')
          : header(outcome, 'location');
      assert.ok(sent !== null);
      assert.equal(new URL(sent, requestFacts.url).origin, 'https://example.test', target);
      assert.notEqual(outcome.kind === 'control' && outcome.control, 'location');
    }
  });

  it('always turns an off-origin redirect into a 409 location visit (property)', () => {
    const random = seeded(0x0ff0);
    const hosts = ['evil.example', 'example.test:8443', 'sub.example.test', 'EXAMPLE.TEST.evil'];
    for (let sample = 0; sample < 500; sample += 1) {
      const scheme = random() < 0.5 ? 'http' : 'https';
      const host = hosts[Math.floor(random() * hosts.length)] ?? 'evil.example';
      const target = `${scheme}://${host}/p${Math.floor(random() * 100)}#f`;
      const requestFacts = facts('/', inertiaHeaders(), { method: random() < 0.5 ? 'GET' : 'PUT' });
      const decision = decideRedirect(
        requestFacts,
        readInertiaVisit(requestFacts.headers),
        302,
        target,
      );
      assert.equal(decision.kind, 'control', target);
      assert.ok(decision.kind === 'control' && decision.control === 'location');
    }
  });

  it('makes an explicit location visit: 409 for Inertia, a redirect otherwise', () => {
    const control = inertiaLocation(facts('/', inertiaHeaders()), 'https://pay.example/checkout');
    assert.equal(control.status, 409);
    assert.equal(header(control, 'x-inertia-location'), 'https://pay.example/checkout');
    assert.equal(header(control, 'x-inertia'), null);
    const plain = inertiaLocation(
      facts('/', {}, { method: 'POST' }),
      new URL('https://pay.example/'),
    );
    assert.equal(plain.status, 303);
    assert.equal(header(plain, 'location'), 'https://pay.example/');
    assert.equal(inertiaLocation(facts('/'), '/local').status, 302);
    assert.throws(
      () => inertiaLocation(facts('/'), 'javascript:alert(1)'),
      code('invalid_redirect'),
    );
    assert.throws(() => inertiaLocation(facts('/'), 'not a url'), code('invalid_redirect'));
  });

  it('goes back to a same-origin Referer, else to the fallback', async () => {
    const config = engine(undefined, { errors: { backFallback: '/home' } });
    const back = await inertiaBack(
      config,
      facts('/save', inertiaHeaders({ Referer: 'https://example.test/form?step=2' }), {
        method: 'POST',
      }),
    );
    assert.equal(header(back, 'location'), '/form?step=2');
    const foreign = await inertiaBack(
      config,
      facts('/save', inertiaHeaders({ Referer: 'https://evil.example/form' }), { method: 'POST' }),
    );
    assert.equal(header(foreign, 'location'), '/home');
    const garbage = await inertiaBack(
      config,
      facts('/save', { Referer: '::' }, { method: 'POST' }),
      {
        fallback: '/start',
      },
    );
    assert.equal(header(garbage, 'location'), '/start');
    await assert.rejects(
      inertiaBack(config, facts('/save'), { fallback: '//evil.example' }),
      code('invalid_redirect'),
    );
  });

  it('never sets an XSRF-TOKEN cookie (CSRF is the Origin check)', async () => {
    const config = engine();
    const outcomes: InertiaOutcome[] = [
      await resolveInertia(config, facts('/'), { component: 'Home', props: {} }),
      await resolveInertia(config, facts('/', inertiaHeaders()), { component: 'Home', props: {} }),
      await inertiaRedirect(config, facts('/', inertiaHeaders(), { method: 'POST' }), '/n', {
        flash: { ok: true },
      }),
      await inertiaBack(config, facts('/', inertiaHeaders(), { method: 'PUT' })),
      inertiaLocation(facts('/', inertiaHeaders()), 'https://pay.example/'),
    ];
    for (const outcome of outcomes) {
      for (const cookie of setCookies(outcome)) {
        assert.match(cookie, /^(__Host-)?jsails-inertia-carrier=/u);
      }
      assert.equal(header(outcome, 'x-xsrf-token'), null);
    }
  });
});
