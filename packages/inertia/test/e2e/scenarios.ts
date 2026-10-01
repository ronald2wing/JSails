/**
 * The end-to-end scenario table: each row drives the real @inertiajs/react
 * 3.11.0 client against the engine and asserts what the protocol promises,
 * on the page, on the wire (the server's request log), and in the client's
 * history and events. Rows marked `smoke` also run against React 19 in the
 * default suite for the differential; every row does under
 * `JSAILS_INERTIA_FULL_DIFFERENTIAL=1`.
 *
 * The protocol clauses are those of the v3 protocol page
 * (inertiajs.com/docs/v3/core-concepts/the-protocol) as the protocol tests
 * number them.
 */

import assert from 'node:assert/strict';

import type { RequestRecord } from './app-server.js';
import type { Session } from './session.js';

/** One scenario. */
export interface Scenario {
  readonly name: string;
  /** Part of the default React 19 differential. */
  readonly smoke: boolean;
  run(session: Session): Promise<void>;
}

/** A request record reduced to what a row asserts: method, URL, headers, status. */
function wire(records: readonly RequestRecord[]): unknown[] {
  return records.map(({ method, url, headers, status, carrier }) => ({
    method,
    url,
    headers,
    status,
    ...(carrier ? { carrier } : {}),
  }));
}

const INERTIA = { 'x-inertia': 'true', 'x-inertia-version': 'v1' };

export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'boots from the server document: script data block, shared props, one request',
    smoke: true,
    async run(s) {
      await s.boot('/');
      await s.until('the home page', () => s.text('h1') === 'Home');
      s.snapshot('booted');
      assert.equal(s.text('#app-name'), 'Demo');
      assert.equal(s.text('#probe'), 'Home / -');
      assert.deepEqual(wire(s.requests()), [{ method: 'GET', url: '/', headers: {}, status: 200 }]);
    },
  },
  {
    name: '<Link> navigates with one Inertia visit and pushes history',
    smoke: true,
    async run(s) {
      await s.boot('/');
      await s.until('the home page', () => s.text('h1') === 'Home');
      s.click('#to-about');
      await s.until('the about page', () => s.text('h1') === 'About');
      s.snapshot('navigated');
      assert.equal(s.browser.window.location.pathname, '/about');
      assert.equal(s.browser.window.history.length, 2);
      assert.deepEqual(wire(s.requests(1)), [
        { method: 'GET', url: '/about', headers: INERTIA, status: 200 },
      ]);
    },
  },
  {
    name: 'usePage() reaches a memoized layout probe through the page context, also conditionally',
    smoke: true,
    async run(s) {
      await s.boot('/');
      await s.until('the home page', () => s.text('h1') === 'Home');
      assert.equal(s.text('#probe'), 'Home / -');
      s.click('#probe-toggle');
      await s.until('the conditional read', () => s.text('#probe') === 'Home / /');
      s.click('#to-about');
      await s.until(
        'the probe to follow the visit',
        () => s.text('#probe') === 'About /about /about',
      );
      s.snapshot('probe after visit');
      s.click('#to-home');
      await s.until('the probe to follow back', () => s.text('#probe') === 'Home / /');
    },
  },
  {
    name: 'router.reload({ only }) sends a partial reload and resolves only the named prop (P-8)',
    smoke: true,
    async run(s) {
      await s.boot('/clock');
      await s.until('the clock', () => s.text('#ticks') === '1');
      assert.equal(s.text('#label'), 'label 1');
      s.click('#reload');
      await s.until('the reloaded prop', () => s.text('#ticks') === '2');
      await s.settle();
      s.snapshot('reloaded');
      assert.equal(s.text('#label'), 'label 1');
      assert.equal(s.demo.state.labelCalls, 1);
      assert.deepEqual(wire(s.requests(1)), [
        {
          method: 'GET',
          url: '/clock',
          headers: {
            ...INERTIA,
            'x-inertia-partial-component': 'Clock',
            'x-inertia-partial-data': 'ticks',
          },
          status: 200,
        },
      ]);
    },
  },
  {
    name: '<Deferred> loads each group in one partial request after the first render (P-10)',
    smoke: true,
    async run(s) {
      await s.boot('/dashboard');
      await s.until('the deferred stats', () => s.text('#stats') === '1200 from 87');
      await s.until('the deferred activity', () => s.count('#activity li') === 2);
      await s.settle();
      s.snapshot('deferred loaded');
      const partials = wire(s.requests(1)).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
      const partial = (data: string) => ({
        method: 'GET',
        url: '/dashboard',
        headers: {
          ...INERTIA,
          'x-inertia-partial-component': 'Dashboard',
          'x-inertia-partial-data': data,
        },
        status: 200,
      });
      assert.deepEqual(partials, [partial('activity'), partial('revenue,visitors')]);
    },
  },
  {
    name: 'once props are not resolved again while the client holds them (P-12)',
    smoke: false,
    async run(s) {
      await s.boot('/plans/basic');
      await s.until('the plans', () => s.count('#plans li') === 2);
      s.click('#to-other-plan');
      await s.until('the other plan', () => s.text('h1') === 'Plan pro');
      s.snapshot('second plan');
      assert.equal(s.text('#plans'), 'freeteam');
      assert.equal(s.demo.state.planCalls, 1);
      assert.deepEqual(wire(s.requests(1)), [
        {
          method: 'GET',
          url: '/plans/pro',
          headers: { ...INERTIA, 'x-inertia-except-once-props': 'plans' },
          status: 200,
        },
      ]);
    },
  },
  {
    name: 'useForm: a failed submit comes back as a 303 with errors in the carrier, scoped to the bag',
    smoke: true,
    async run(s) {
      await s.boot('/users/create');
      await s.until('the form', () => s.text('h1') === 'New user');
      s.click('#save');
      await s.until('the field error', () => s.text('#name-error') === 'Name is required');
      await s.settle();
      s.snapshot('invalid');
      assert.equal(s.text('#page-errors'), '{"createUser":{"name":"Name is required"}}');
      assert.equal(s.browser.window.location.pathname, '/users/create');
      const bag = { ...INERTIA, 'x-inertia-error-bag': 'createUser' };
      assert.deepEqual(wire(s.requests(1)), [
        { method: 'POST', url: '/users', headers: bag, status: 303 },
        { method: 'GET', url: '/users/create', headers: bag, status: 200, carrier: true },
      ]);
      const before = s.requests().length;
      s.type('#name', 'Ada');
      s.click('#save');
      await s.until('the redirect home', () => s.text('#flash') === 'Created Ada');
      await s.settle();
      s.snapshot('created');
      assert.equal(s.demo.state.saved, 'Ada');
      assert.deepEqual(
        wire(s.requests(before)).map((entry) => JSON.stringify(entry)),
        [
          { method: 'POST', url: '/users', headers: bag, status: 303 },
          { method: 'GET', url: '/', headers: bag, status: 200, carrier: true },
        ].map((entry) => JSON.stringify(entry)),
      );
    },
  },
  {
    name: 'flash fires the flash event once and not again on back navigation',
    smoke: false,
    async run(s) {
      await s.boot('/');
      await s.until('the home page', () => s.text('h1') === 'Home');
      s.client.inertia.router.post('/flash');
      await s.until('the flash', () => s.text('#flash') === 'Saved');
      s.click('#to-about');
      await s.until('the about entry', () => s.historyUrl() === '/about');
      s.browser.window.history.back();
      await s.until('the home page again', () => s.text('h1') === 'Home');
      await s.settle();
      s.snapshot('back home');
      assert.equal(s.text('#flash'), '');
      assert.deepEqual(s.events, [['flash', { message: 'Saved' }]]);
      assert.deepEqual(wire(s.requests(1)), [
        { method: 'POST', url: '/flash', headers: INERTIA, status: 303 },
        { method: 'GET', url: '/', headers: INERTIA, status: 200, carrier: true },
        { method: 'GET', url: '/about', headers: INERTIA, status: 200 },
      ]);
    },
  },
  {
    name: 'a new asset version turns a visit into a full page load (409 X-Inertia-Location, P-15)',
    smoke: false,
    async run(s) {
      await s.boot('/');
      await s.until('the home page', () => s.text('h1') === 'Home');
      s.demo.state.version = 'v2';
      s.click('#to-about');
      await s.until('the location visit', () => s.browser.window.location.pathname === '/about');
      await s.settle();
      assert.deepEqual(wire(s.requests(1)), [
        { method: 'GET', url: '/about', headers: INERTIA, status: 409 },
      ]);
      assert.deepEqual(s.events, [['location', { url: '/about', versionChange: true }]]);
      assert.equal(
        s.browser.window.sessionStorage.getItem('inertiaLocationVisit'),
        '{"preserveScroll":false}',
      );
      assert.equal(s.text('h1'), 'Home');
    },
  },
  {
    name: 'an off-origin redirect from a handler becomes a 409 location visit',
    smoke: false,
    async run(s) {
      await s.boot('/');
      await s.until('the home page', () => s.text('h1') === 'Home');
      s.client.inertia.router.post('/external');
      await s.until('the location event', () => s.events.length === 1);
      await s.settle();
      assert.deepEqual(wire(s.requests(1)), [
        { method: 'POST', url: '/external', headers: INERTIA, status: 409 },
      ]);
      assert.deepEqual(s.events, [
        ['location', { url: 'https://elsewhere.test/landing', versionChange: false }],
      ]);
    },
  },
  {
    name: 'a 302 after PUT becomes a 303, so the browser follows with GET',
    smoke: true,
    async run(s) {
      await s.boot('/items');
      await s.until('the items page', () => s.text('h1') === 'Items');
      s.click('#rename');
      await s.until('the saved name', () => s.text('#saved') === 'Renamed');
      await s.settle();
      s.snapshot('renamed');
      assert.deepEqual(wire(s.requests(1)), [
        { method: 'PUT', url: '/items/1', headers: INERTIA, status: 303 },
        { method: 'GET', url: '/items', headers: INERTIA, status: 200 },
      ]);
    },
  },
  {
    name: '<InfiniteScroll> appends each next page through a partial reload with merge intent',
    smoke: false,
    async run(s) {
      await s.boot('/feed');
      await s.until('the first page', () => s.count('article') === 2);
      await s.until('the scroll manager', () => s.demoClient.feedReady());
      s.click('#more');
      await s.until('the second page', () => s.count('article') === 4);
      s.click('#more');
      await s.until('the last page', () => s.count('article') === 6 && s.count('#end') === 1);
      await s.settle();
      s.snapshot('all pages');
      assert.deepEqual(
        Array.from(
          s.browser.window.document.querySelectorAll('article'),
          (node) => node.textContent,
        ),
        ['Post 1', 'Post 2', 'Post 3', 'Post 4', 'Post 5', 'Post 6'],
      );
      const next = (page: number) => ({
        method: 'GET',
        url: `/feed?page=${page}`,
        headers: {
          ...INERTIA,
          'x-inertia-partial-component': 'Feed',
          'x-inertia-partial-data': 'posts',
          'x-inertia-infinite-scroll-merge-intent': 'append',
        },
        status: 200,
      });
      assert.deepEqual(wire(s.requests(1)), [next(2), next(3)]);
    },
  },
  {
    name: 'encryptHistory keeps the history entry encrypted, and clearHistory drops the key',
    smoke: false,
    async run(s) {
      const { window } = s.browser;
      await s.boot('/');
      await s.until('the home page', () => s.text('h1') === 'Home');
      s.click('#to-secret');
      await s.until('the secret page', () => s.text('#secret') === 'swordfish');
      const entry = (): unknown => Reflect.get(Object(window.history.state), 'page');
      // The entry is encrypted asynchronously after the page swap.
      await s.until('the encrypted entry', () => entry() instanceof ArrayBuffer);
      const ciphertext = entry();
      assert.ok(ciphertext instanceof ArrayBuffer);
      assert.equal(Buffer.from(ciphertext).includes('swordfish'), false);
      assert.notEqual(window.sessionStorage.getItem('historyKey'), null);
      s.click('#to-home');
      await s.until('the home entry', () => s.historyUrl() === '/');
      const before = s.requests().length;
      window.history.back();
      await s.until('the decrypted entry', () => s.text('#secret') === 'swordfish');
      await s.settle();
      s.snapshot('restored from history');
      assert.equal(s.requests().length, before, 'restored without a request');
      s.client.inertia.router.post('/logout');
      await s.until(
        'the key to be cleared',
        () => window.sessionStorage.getItem('historyKey') === null,
      );
      await s.settle();
      assert.deepEqual(wire(s.requests(before)), [
        { method: 'POST', url: '/logout', headers: INERTIA, status: 303 },
        { method: 'GET', url: '/', headers: INERTIA, status: 200, carrier: true },
      ]);
    },
  },
  {
    name: 'Precognition validates one field without running the handler',
    smoke: false,
    async run(s) {
      await s.boot('/users/validate');
      await s.until('the form', () => s.text('h1') === 'Validate user');
      s.type('#name', 'ab');
      s.click('#check');
      await s.until('the field error', () => s.text('#name-error') === 'Name is too short');
      s.type('#name', 'Ada');
      s.click('#check');
      await s.until('the field to pass', () => s.text('#name-valid') === 'valid');
      await s.settle();
      s.snapshot('validated');
      assert.equal(s.text('#name-error'), '');
      assert.equal(s.demo.state.saved, null);
      const check = (status: number) => ({
        method: 'POST',
        url: '/users',
        headers: { precognition: 'true', 'precognition-validate-only': 'name' },
        status,
      });
      assert.deepEqual(wire(s.requests(1)), [check(422), check(204)]);
    },
  },
];
