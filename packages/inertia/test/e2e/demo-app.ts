/**
 * The demo app every end-to-end scenario drives: its server routes on the
 * Inertia engine and its client pages for the real React adapter.
 *
 * The server half is plain engine calls (`resolveInertia`, the redirect
 * helpers, `validationFailure`, `precognition`, `adaptInertiaResponse`) behind
 * `METHOD /path` routes, with counters a scenario reads to prove which
 * resolvers ran. The client half is written once against {@link ClientModules}
 * with `createElement`, so the same components run on `preact/compat` and on
 * React 19, and in the SSR worker. `Plain/` pages use no Inertia hook or
 * component and no layout. A persistent layout holds a memoized probe
 * that reads `usePage()` (once unconditionally, once behind a toggle), so a
 * navigation reaches it only through the page context subscription.
 */

import {
  adaptInertiaResponse,
  defer,
  defineInertia,
  inertiaRedirect,
  once,
  precognition,
  resolveInertia,
  scroll,
  validationFailure,
  webCryptoSealer,
  type InertiaConfig,
  type InertiaRenderSpec,
  type InertiaSsr,
  type PropsTree,
  type ScrollPage,
} from '../../src/index.js';
import type { ValidationIssue } from 'jsails/api';

import type { AppHandler, AppRequest, AppRoutes } from './app-server.js';
import type { ClientChild, ClientComponent, ClientModules } from './module-graph.js';

/** Server-side counters and switches a scenario reads or flips. */
export interface DemoState {
  version: string;
  ticks: number;
  labelCalls: number;
  planCalls: number;
  saved: string | null;
}

/** The demo app's server half. */
export interface DemoServer {
  readonly state: DemoState;
  readonly config: InertiaConfig;
  readonly routes: AppRoutes;
}

const FEED_PAGES = 3;
const FEED_PAGE_SIZE = 2;

/** Build the demo server; `ssr` turns on server-side rendering of first visits. */
export function createDemoServer(options: { readonly ssr?: InertiaSsr } = {}): DemoServer {
  const state: DemoState = { version: 'v1', ticks: 0, labelCalls: 0, planCalls: 0, saved: null };
  const config = defineInertia({
    version: () => state.version,
    carrier: { sealer: webCryptoSealer(new Uint8Array(32).fill(7)), oversize: 'throw' },
    share: () => ({ appName: 'Demo' }),
    ...(options.ssr === undefined ? {} : { ssr: { gateway: options.ssr, onError: 'throw' } }),
  });

  const page =
    (
      component: string,
      props: () => PropsTree,
      spec: Partial<InertiaRenderSpec> = {},
    ): AppHandler =>
    (request) =>
      resolveInertia(config, request.facts, { ...spec, component, props: props() });

  const plans = (name: string): AppHandler =>
    page('Plans', () => ({
      name,
      plans: once(() => {
        state.planCalls += 1;
        return ['free', 'team'];
      }),
    }));

  const routes: AppRoutes = {
    'GET /': page('Home', () => ({ title: 'Home' })),
    'GET /about': page('About', () => ({ title: 'About' })),
    'GET /counter': page('Plain/Counter', () => ({ start: 5 })),
    'GET /counter/titled': page('Counter', () => ({ start: 5 })),
    'GET /clock': page('Clock', () => ({
      ticks: () => {
        state.ticks += 1;
        return state.ticks;
      },
      label: () => {
        state.labelCalls += 1;
        return `label ${state.labelCalls}`;
      },
    })),
    'GET /dashboard': page('Dashboard', () => ({
      revenue: defer(() => 1200, { group: 'stats' }),
      visitors: defer(() => 87, { group: 'stats' }),
      activity: defer(() => ['signed up', 'paid']),
    })),
    'GET /plans/basic': plans('basic'),
    'GET /plans/pro': plans('pro'),
    'GET /users/create': page('Users/Create', () => ({})),
    'GET /users/validate': page('Users/Validate', () => ({})),
    'POST /users': (request) => createUser(config, state, request),
    'POST /flash': (request) =>
      inertiaRedirect(config, request.facts, '/', { flash: { message: 'Saved' } }),
    'POST /external': (request) =>
      adaptInertiaResponse(request.facts, Response.redirect('https://elsewhere.test/landing', 302)),
    'PUT /items/1': (request) => {
      state.saved = readName(request.body);
      return adaptInertiaResponse(
        request.facts,
        new Response(null, { status: 302, headers: { Location: '/items' } }),
      );
    },
    'GET /items': page('Items', () => ({ saved: state.saved })),
    'GET /feed': page('Feed', () => ({
      posts: scroll((context) => feedPage(Number(context.url.searchParams.get('page') ?? '1'))),
    })),
    'GET /secret': page('Secret', () => ({ secret: 'swordfish' }), { encryptHistory: true }),
    'POST /logout': (request) =>
      inertiaRedirect(config, request.facts, '/', { clearHistory: true }),
  };
  return { state, config, routes };
}

function feedPage(current: number): ScrollPage<{ readonly id: number; readonly title: string }> {
  const first = (current - 1) * FEED_PAGE_SIZE + 1;
  return {
    data: Array.from({ length: FEED_PAGE_SIZE }, (_, index) => ({
      id: first + index,
      title: `Post ${first + index}`,
    })),
    currentPage: current,
    previousPage: current > 1 ? current - 1 : null,
    nextPage: current < FEED_PAGES ? current + 1 : null,
  };
}

function readName(body: string): string {
  const parsed: unknown = body === '' ? {} : JSON.parse(body);
  const name: unknown =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'name') : undefined;
  return typeof name === 'string' ? name : '';
}

/** `POST /users`: Precognition, a validation failure, or a redirect with flash. */
async function createUser(config: InertiaConfig, state: DemoState, request: AppRequest) {
  const name = readName(request.body).trim();
  const issues: ValidationIssue[] = [];
  if (name === '') issues.push({ path: ['name'], code: 'required', message: 'Name is required' });
  else if (name.length < 3) {
    issues.push({ path: ['name'], code: 'min_length', message: 'Name is too short' });
  }
  const precognitive = precognition(request.facts, issues);
  if (precognitive !== null) return precognitive;
  const failure = await validationFailure(config, request.facts, issues);
  if (failure !== null) return failure;
  state.saved = name;
  return inertiaRedirect(config, request.facts, '/', { flash: { message: `Created ${name}` } });
}

/** The demo's client pages and persistent layout, built on one client graph. */
export interface DemoClient {
  readonly pages: Readonly<Record<string, ClientComponent>>;
  /** The persistent layout of a page; `Plain/` pages have none. */
  layoutFor(component: string): ClientComponent | undefined;
  /**
   * Whether the feed's `<InfiniteScroll>` can fetch: its imperative handle
   * reports a next page only once the scroll manager is set up, in the same
   * commit that gives the `next` slot a working `fetch`.
   */
  feedReady(): boolean;
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function isElement(value: unknown): value is ClientChild {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

function child(value: unknown): ClientChild {
  return isElement(value) ? value : null;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
}

/** Build the demo pages for a client graph. */
export function createDemoClient(client: ClientModules): DemoClient {
  const { createElement: h, memo, useState } = client.react;
  const { Deferred, Head, InfiniteScroll, Link, router, useForm, usePage } = client.inertia;

  const link = (href: string, label: string): ClientChild =>
    h(Link, { href, id: `to-${label.toLowerCase().replaceAll(' ', '-')}` }, label);

  const Probe = memo(() => {
    const page = usePage();
    const [deep, setDeep] = useState(false);
    let inner = '-';
    if (deep) inner = usePage().url;
    return h(
      'aside',
      null,
      h('span', { id: 'probe' }, `${page.component} ${page.url} ${inner}`),
      h('button', { id: 'probe-toggle', onClick: () => setDeep(!deep) }, 'toggle'),
    );
  });

  const layout: ClientComponent = (props) =>
    h('div', { className: 'layout' }, h(Probe, null), child(props.children));

  const Home: ClientComponent = (props) => {
    const page = usePage();
    return h(
      'main',
      null,
      h('h1', null, text(props.title)),
      h('p', { id: 'app-name' }, text(props.appName)),
      h('p', { id: 'flash' }, text(page.flash.message)),
      h(
        'nav',
        null,
        link('/about', 'About'),
        link('/clock', 'Clock'),
        link('/dashboard', 'Dashboard'),
        link('/secret', 'Secret'),
      ),
    );
  };

  const About: ClientComponent = (props) =>
    h('main', null, h('h1', null, text(props.title)), link('/', 'Home'));

  const counter =
    (titled: boolean): ClientComponent =>
    (props) => {
      const [count, setCount] = useState(Number(props.start));
      return h(
        'main',
        null,
        titled ? h(Head, null, h('title', null, `Counter from ${text(props.start)}`)) : null,
        h('h1', null, 'Counter'),
        h('button', { id: 'increment', onClick: () => setCount(count + 1) }, `Count ${count}`),
      );
    };

  const Clock: ClientComponent = (props) =>
    h(
      'main',
      null,
      h('h1', null, 'Clock'),
      h('p', { id: 'ticks' }, text(props.ticks)),
      h('p', { id: 'label' }, text(props.label)),
      h('button', { id: 'reload', onClick: () => router.reload({ only: ['ticks'] }) }, 'Reload'),
    );

  const Dashboard: ClientComponent = (props) =>
    h(
      'main',
      null,
      h('h1', null, 'Dashboard'),
      h(
        Deferred,
        { data: ['revenue', 'visitors'], fallback: h('p', { id: 'stats' }, 'Loading stats') },
        () => h('p', { id: 'stats' }, `${text(props.revenue)} from ${text(props.visitors)}`),
      ),
      h(
        Deferred,
        { data: 'activity', fallback: h('p', { id: 'activity' }, 'Loading activity') },
        () =>
          h(
            'ul',
            { id: 'activity' },
            ...list(props.activity).map((item) => h('li', null, text(item))),
          ),
      ),
    );

  const Plans: ClientComponent = (props) =>
    h(
      'main',
      null,
      h('h1', null, `Plan ${text(props.name)}`),
      h('ul', { id: 'plans' }, ...list(props.plans).map((plan) => h('li', null, text(plan)))),
      link(props.name === 'basic' ? '/plans/pro' : '/plans/basic', 'Other plan'),
    );

  const UsersCreate: ClientComponent = () => {
    const form = useForm({ name: '' });
    const page = usePage();
    return h(
      'main',
      null,
      h('h1', null, 'New user'),
      h('input', {
        id: 'name',
        value: text(form.data.name),
        onChange: (event: unknown) => form.setData('name', field(field(event, 'target'), 'value')),
      }),
      h(
        'button',
        { id: 'save', onClick: () => form.post('/users', { errorBag: 'createUser' }) },
        'Save',
      ),
      h('p', { id: 'name-error' }, form.errors.name ?? ''),
      h('pre', { id: 'page-errors' }, JSON.stringify(page.props.errors)),
    );
  };

  const UsersValidate: ClientComponent = () => {
    const form = useForm('post', '/users', { name: '' });
    form.setValidationTimeout(0);
    return h(
      'main',
      null,
      h('h1', null, 'Validate user'),
      h('input', {
        id: 'name',
        value: text(form.data.name),
        onChange: (event: unknown) => form.setData('name', field(field(event, 'target'), 'value')),
      }),
      h('button', { id: 'check', onClick: () => form.validate('name') }, 'Check'),
      h('p', { id: 'name-error' }, form.errors.name ?? ''),
      h('p', { id: 'name-valid' }, form.valid('name') ? 'valid' : ''),
    );
  };

  const Items: ClientComponent = (props) =>
    h(
      'main',
      null,
      h('h1', null, 'Items'),
      h('p', { id: 'saved' }, text(props.saved)),
      h(
        'button',
        { id: 'rename', onClick: () => router.put('/items/1', { name: 'Renamed' }) },
        'Rename',
      ),
    );

  const feedScroll: { current: unknown } = { current: null };
  const feedReady = (): boolean => {
    const hasNext: unknown = Reflect.get(Object(feedScroll.current), 'hasNext');
    return typeof hasNext === 'function' && Reflect.apply(hasNext, undefined, []) === true;
  };

  const Feed: ClientComponent = (props) =>
    h(
      'main',
      null,
      h('h1', null, 'Feed'),
      h(
        InfiniteScroll,
        {
          data: 'posts',
          manual: true,
          ref: feedScroll,
          id: 'posts',
          next: (slot: unknown) => {
            const fetchNext = field(slot, 'fetch');
            if (field(slot, 'hasMore') !== true) return h('p', { id: 'end' }, 'End');
            const onClick = () => {
              if (typeof fetchNext === 'function') Reflect.apply(fetchNext, undefined, []);
            };
            return h('button', { id: 'more', onClick }, 'More');
          },
        },
        ...list(field(props.posts, 'data')).map((post) =>
          h('article', { key: text(field(post, 'id')) }, text(field(post, 'title'))),
        ),
      ),
    );

  const Secret: ClientComponent = (props) =>
    h(
      'main',
      null,
      h('h1', null, 'Secret'),
      h('p', { id: 'secret' }, text(props.secret)),
      link('/', 'Home'),
    );

  return {
    layoutFor: (component) => (component.startsWith('Plain/') ? undefined : layout),
    feedReady,
    pages: {
      Home,
      About,
      Counter: counter(true),
      'Plain/Counter': counter(false),
      Clock,
      Dashboard,
      Plans,
      'Users/Create': UsersCreate,
      'Users/Validate': UsersValidate,
      Items,
      Feed,
      Secret,
    },
  };
}
