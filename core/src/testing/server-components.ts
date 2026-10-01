/**
 * Server-component test harness (`createComponentTestHarness`).
 *
 * An in-process harness over the real server-component runtime that mounts a
 * component and drives updates without listening on a port, hand-rolling an
 * HTTP fixture, or extracting snapshot tokens from SSR HTML. Every call
 * goes through {@link createServerComponentsRuntime} and
 * {@link HmacComponentSigner} directly, and an update goes through the
 * runtime's own update route, lane boundary included — no Hono app is built,
 * so the access chain's cross-site check (which guards the real update route)
 * is not part of it.
 *
 * The harness is stateless across calls: each `render` mints a new component
 * instance, and each `update` sends a version 2 update request through the
 * same runtime path a real POST takes. An update states no held render unless
 * `render` is passed, so it is answered with a full render; passing the
 * previous result's `render` tag lets a test observe an `unchanged` reply.
 */

import {
  COMPONENT_RENDER_ATTRIBUTE,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
} from '../server-components/protocol.js';
import {
  COMPONENT_PROTOCOL_VERSION,
  type ComponentHeldSlot,
  type ComponentUpdateEffects,
  type ComponentUpdateRequest,
} from '../wire/protocol.js';
import { componentRegistryFromMap } from '../server-components/registry.js';
import { createServerComponentsRuntime } from '../server-components/runtime/index.js';
import { HmacComponentSigner } from '../server-components/snapshot.js';
import { createRequestContext } from '../server/request-pipeline.js';

import type { ServerComponentDefinition } from '../server-components/component.js';
import type { Session, RequestContext } from '../contracts/http.js';
import type { TestingLifecycle } from './app.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Deterministic test key used when no `signingKey` is supplied, so every test
 * run produces identical snapshots without relying on `NODE_ENV`.
 */
const DEFAULT_TEST_KEY = '0123456789abcdef0123456789abcdef';

/** Origin used when no `origin` is given. */
const DEFAULT_ORIGIN = 'http://localhost';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for {@link createComponentTestHarness}. */
export interface ComponentTestHarnessOptions {
  /** Components keyed by component id (required); each `name` must equal its key. */
  readonly components: Readonly<Record<string, ServerComponentDefinition<any>>>;
  /** Signing key. When omitted a deterministic test key is used. */
  readonly signingKey?: string;
  /** Trusted origin (default `http://localhost`). */
  readonly origin?: string;
  /** Session to bind the component to (default `null`). */
  readonly session?: Session | null;
  /** Auto-close registration surface (e.g. a `node:test` `t`). */
  readonly lifecycle?: TestingLifecycle;
}

/** The result of {@link ComponentTestHarness.render}. */
export interface ComponentRenderResult {
  /** The SSR HTML produced by the component's `render`. */
  readonly html: string;
  /** The signed snapshot token extracted from the rendered root. */
  readonly snapshot: string;
  /** The render tag extracted from the rendered root. */
  readonly render: string;
}

/** The result of {@link ComponentTestHarness.update}. */
export interface ComponentUpdateTestResult {
  /** HTTP status code (200 on success, 403/422/500 on failure). */
  readonly status: number;
  /** The reply's kind: `render`, `unchanged`, `invalid`, `error`, or `protocol_mismatch`. */
  readonly kind?: string;
  /** The parsed JSON response body. */
  readonly body: unknown;
  /** Failures the route reported while answering (a throwing action, a policy fault). */
  readonly reported: readonly unknown[];
  /**
   * The token the reply carries: always on a `render`, and on an `unchanged`
   * only when the server re-signed it.
   */
  readonly snapshot?: string;
  /** Re-rendered component HTML, present on a render or a validation error. */
  readonly html?: string;
  /** The render tag of `html`. */
  readonly render?: string;
  /** What the action asked the client to do after the render. */
  readonly effects?: ComponentUpdateEffects;
}

/** The handle returned by {@link createComponentTestHarness}. */
export interface ComponentTestHarness {
  render(name: string): Promise<ComponentRenderResult>;
  update(
    snapshot: string,
    updates: Record<string, unknown>,
    options?: ComponentUpdateOptions,
  ): Promise<ComponentUpdateTestResult>;
  close(): Promise<void>;
}

/** Options for {@link ComponentTestHarness.update}. */
export interface ComponentUpdateOptions {
  /** Trusted origin (defaults to the harness's origin). */
  readonly origin?: string;
  /** An optional action to run alongside client edits. */
  readonly action?: {
    readonly name: string;
    readonly args?: Record<string, unknown>;
  };
  /** The render tag the client holds (`have.render`); omitted, none. */
  readonly render?: string;
  /** The nested children the client holds (`have.slots`); omitted, none. */
  readonly slots?: readonly ComponentHeldSlot[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract an attribute value from an HTML string, or throw if absent. */
function extractAttr(html: string, name: string): string {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  if (match === null) {
    throw new Error(`expected attribute ${name} in HTML`);
  }
  return match[1]!;
}

/**
 * Build a minimal {@link Request} for a component render (GET).
 * The runtime reads `context.url` for route params and origin derivation.
 */
function renderRequest(url: URL): Request {
  return new Request(url, { method: 'GET' });
}

/** Build a minimal {@link Request} for a component update (POST), as a same-origin browser sends it. */
function updateRequest(url: URL, origin: string, payload: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an in-process test harness over the real server-component runtime.
 *
 * The harness builds a {@link ComponentSigner} and a
 * {@link ServerComponentsRuntime} from the supplied components, then exposes
 * `render` and `update` methods that build a {@link RequestContext} and call
 * the runtime directly — no HTTP server, Hono app, or browser is involved.
 *
 * When `lifecycle` is supplied the harness registers an `after` callback that
 * calls `close()`, so the harness tears down idempotently when the test
 * finishes.
 */
export function createComponentTestHarness(
  options: ComponentTestHarnessOptions,
): ComponentTestHarness {
  const key = options.signingKey ?? DEFAULT_TEST_KEY;
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const session = options.session ?? null;

  const signer = new HmacComponentSigner({ key });
  const runtime = createServerComponentsRuntime({
    components: componentRegistryFromMap(options.components),
    signer,
  });

  let closed = false;

  /** Build a {@link RequestContext} suitable for render or update. */
  function buildContext(req: Request, params: Record<string, string> = {}): RequestContext {
    return createRequestContext({
      request: req,
      url: new URL(req.url),
      params,
      session,
    });
  }

  async function render(name: string): Promise<ComponentRenderResult> {
    if (closed) {
      throw new Error('component test harness is closed');
    }
    const mountUrl = new URL(`/${name}`, origin);
    const context = buildContext(renderRequest(mountUrl), { component: name });
    const html = await runtime.render(name, context);

    return {
      html,
      snapshot: extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE),
      render: extractAttr(html, COMPONENT_RENDER_ATTRIBUTE),
    };
  }

  async function update(
    snapshot: string,
    updates: Record<string, unknown>,
    updateOptions: ComponentUpdateOptions = {},
  ): Promise<ComponentUpdateTestResult> {
    if (closed) {
      throw new Error('component test harness is closed');
    }

    const effectiveOrigin = updateOptions.origin ?? origin;
    const updateUrl = new URL('/_jsails/components/update', effectiveOrigin);

    const payload: ComponentUpdateRequest = {
      v: COMPONENT_PROTOCOL_VERSION,
      sequence: 1,
      snapshot,
      updates: updates as ComponentUpdateRequest['updates'],
      ...(updateOptions.action === undefined
        ? {}
        : { action: updateOptions.action as ComponentUpdateRequest['action'] & object }),
      have: { render: updateOptions.render ?? null, slots: updateOptions.slots ?? [] },
    };
    const req = updateRequest(updateUrl, effectiveOrigin, payload);
    const context = buildContext(req);

    const reported: unknown[] = [];
    const response = await runtime.routes.update(req, context, (error) => {
      reported.push(error);
    });
    const body = (await response.json()) as Record<string, unknown>;
    const text = (key: string): string | undefined =>
      typeof body[key] === 'string' ? body[key] : undefined;
    const kind = text('kind');
    const reSigned = text('snapshot');
    const html = text('html');
    const render = text('render');
    const effects = body.effects as ComponentUpdateEffects | undefined;

    return {
      status: response.status,
      body,
      reported,
      ...(kind === undefined ? {} : { kind }),
      ...(reSigned === undefined ? {} : { snapshot: reSigned }),
      ...(html === undefined ? {} : { html }),
      ...(render === undefined ? {} : { render }),
      ...(effects === undefined ? {} : { effects }),
    };
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    runtime.close();
  }

  if (options.lifecycle !== undefined) {
    options.lifecycle.after(() => close());
  }

  return { render, update, close };
}
