/**
 * The Streamable HTTP endpoint for a defined server, on the SDK's
 * `createMcpHandler`: the 2026-07-28 revision per request, and (by default)
 * 2025-era clients through the SDK's stateless legacy fallback, both served
 * by the same per-unit factory.
 *
 * In front of the SDK entry, which is validation-free by design, the endpoint
 * answers in this order:
 *
 * 1. `Host` not in the allowlist, or a present `Origin` not in it: `403`
 *    (DNS rebinding and cross-site protection, the transport's MUST). The
 *    body never echoes the header.
 * 2. Any method but `POST`: `405` with `Allow: POST`. The endpoint holds no
 *    sessions and no standalone stream.
 * 3. The `authenticate` seam. A rejected or absent credential gets `401` with
 *    a `WWW-Authenticate` challenge naming the Protected Resource Metadata
 *    document and the scopes that would be enough; a credential issued for
 *    another resource (its audience does not name this endpoint) or past its
 *    expiry gets `401 invalid_token`; one without the endpoint's required
 *    scopes gets `403 insufficient_scope`. The authenticator itself throwing,
 *    or answering something malformed, is a `500` and an operator report.
 * 4. The SDK entry, with the actor carried to the factory. An item the gate
 *    challenges answers `403 insufficient_scope` for a credential that lacks
 *    its scopes (the step-up case), or `401` with the scopes for an
 *    anonymous caller, which has no credential to step up.
 *
 * The SDK entry owns everything after that: the request body cap (`413`
 * before parsing), content type (`415`), header/body agreement (`-32020`),
 * protocol versions (`-32022`), `Mcp-Param-*` headers, and the response mode
 * (a JSON body, upgraded to SSE when a handler sends progress first).
 *
 * A request is cancelled by closing its response stream (the client
 * disconnecting), which aborts its handler's signal on either era. On
 * 2026-07-28 that is the revision's cancellation. A 2025 request is served
 * statelessly, by a server made for it alone with no session, so a
 * `notifications/cancelled` lands on a server that never saw the request and
 * is acknowledged with `202` to no effect: a request id is unique only within
 * a session, and routing one across requests could cancel another client's
 * call. The disconnect is therefore the only cancellation such a request can
 * receive; the 2025-06-18 rule that a disconnect is not a cancellation
 * presumes a session that outlives the stream. `connectMcp` closes the stream
 * whenever it cancels a call.
 *
 * The endpoint's options are an internal seam: the `mcp` plugin will own them
 * and mount the endpoint through the framework's routes, so this module is not
 * part of the package's public exports yet.
 */

import {
  createMcpHandler,
  validateHostHeader,
  validateOriginHeader,
  type AuthInfo,
} from '@modelcontextprotocol/server';
import type { Awaitable } from 'jsails/plugin-sdk';
import { isRecord } from 'jsails/plugin-sdk';

import type { McpActor, McpScopes } from './access.js';
import type { McpServerDefinition } from './definitions.js';
import { McpDefinitionError } from './errors.js';
import {
  audienceIncludes,
  canonicalResource,
  insufficientScopeResponse,
  protectedResource,
  scopeList,
  unauthorizedResponse,
  type ProtectedResource,
} from './protected-resource.js';
import {
  createMcpServerFactory,
  reporter,
  type McpServingOptions,
  type Site,
} from './server-factory.js';

/**
 * The credential an authenticated caller presented. Never the token itself:
 * an identifier for it (a token id, or issuer plus subject plus client).
 */
export interface McpCredential {
  /** Stable for the credential's lifetime; bound into multi-round-trip state. */
  readonly id: string;
  /** The token's audience (`aud`); it must name this endpoint's resource. */
  readonly audience: string | readonly string[];
  /** Expiry, in seconds since the epoch. */
  readonly expiresAt?: number;
}

/** What the `authenticate` seam answers for one request. */
export type McpAuthentication =
  | { readonly kind: 'anonymous' }
  | {
      readonly kind: 'authenticated';
      /** A `user` or `service` actor whose `scopes` are the credential's scopes. */
      readonly actor: McpActor;
      readonly credential: McpCredential;
    }
  | { readonly kind: 'rejected'; readonly reason: 'missing' | 'invalid' | 'expired' };

/** Options for {@link createMcpHttpEndpoint}. */
export interface McpHttpOptions extends McpServingOptions {
  /** The endpoint's canonical URL (its RFC 8707 resource identifier). */
  readonly resource: string;
  /** Resolve the caller from the request (typically its bearer token). */
  readonly authenticate: (request: Request) => Awaitable<McpAuthentication>;
  /** Issuers whose tokens the endpoint accepts; enables the metadata document. */
  readonly authorizationServers?: readonly string[];
  /** The scopes the endpoint understands, advertised in the metadata document. */
  readonly scopesSupported?: readonly string[];
  /** Scopes every credential must carry to use the endpoint at all. */
  readonly requiredScopes?: readonly string[];
  /** Hostnames a browser `Origin` may name. Default: the resource's host. */
  readonly allowedOrigins?: readonly string[];
  /** Hostnames the `Host` header may name. Default: the resource's host. */
  readonly allowedHosts?: readonly string[];
  /** Serve 2025-era clients statelessly (the default) or refuse them. */
  readonly legacy?: 'stateless' | 'reject';
  /** The largest request body read, in bytes. Default 1 MiB. */
  readonly maxRequestBytes?: number;
  readonly resourceName?: string;
  readonly resourceDocumentation?: string;
}

/** A served endpoint. */
export interface McpHttpEndpoint {
  /** The canonical resource identifier. */
  readonly resource: string;
  /** The metadata document, when authorization servers are configured. */
  readonly protectedResource: ProtectedResource | undefined;
  /** Answer one request to the endpoint's path. */
  handle(request: Request): Promise<Response>;
  /** Abort in-flight requests and refuse new ones. */
  close(): Promise<void>;
}

/** The state one authenticated exchange carries from the endpoint into the factory. */
interface Exchange {
  readonly actor: McpActor;
  readonly credential: string | undefined;
  challenged: McpScopes | undefined;
}

const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const ANONYMOUS: McpActor = Object.freeze({ kind: 'anonymous', scopes: Object.freeze([]) });
const TRANSPORT: Site = Object.freeze({ kind: 'transport', name: 'http' });

function invalidOption(option: string, reason: string): McpDefinitionError {
  return new McpDefinitionError('invalid_option', `${option} ${reason}`, { option });
}

function hostnames(value: unknown, option: string, fallback: string): string[] {
  if (value === undefined) {
    return [fallback];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidOption(option, 'must be a non-empty array of hostnames');
  }
  const names: unknown[] = value;
  return names.map((name) => {
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      /[\s/:@]/.test(name.replace(/^\[.*\]$/, ''))
    ) {
      throw invalidOption(option, 'must hold bare hostnames (no scheme, port, or path)');
    }
    return name.toLowerCase();
  });
}

function forbidden(): Response {
  return Response.json(
    { jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden' }, id: null },
    { status: 403 },
  );
}

function serverError(): Response {
  return Response.json({ error: 'server_error' }, { status: 500 });
}

/** A copy of `value` when it is an array of strings, otherwise `undefined`. */
function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: unknown[] = value;
  const copy: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') {
      return undefined;
    }
    copy.push(item);
  }
  return copy;
}

/** The actor and credential of an `authenticated` answer, or `undefined` when malformed. */
function checkAuthenticated(
  answer: Record<string, unknown>,
): { actor: McpActor; credential: McpCredential } | undefined {
  const { actor, credential } = answer;
  if (!isRecord(actor) || !isRecord(credential)) {
    return undefined;
  }
  if (actor.kind !== 'user' && actor.kind !== 'service') {
    return undefined;
  }
  if (actor.id !== undefined && (typeof actor.id !== 'string' || actor.id.length === 0)) {
    return undefined;
  }
  const scopes = strings(actor.scopes);
  if (scopes === undefined) {
    return undefined;
  }
  if (typeof credential.id !== 'string' || credential.id.length === 0) {
    return undefined;
  }
  const audience =
    typeof credential.audience === 'string' ? credential.audience : strings(credential.audience);
  if (audience === undefined) {
    return undefined;
  }
  if (
    credential.expiresAt !== undefined &&
    (typeof credential.expiresAt !== 'number' || !Number.isFinite(credential.expiresAt))
  ) {
    return undefined;
  }
  return {
    actor: Object.freeze({
      kind: actor.kind,
      ...(actor.id === undefined ? {} : { id: actor.id }),
      scopes: Object.freeze(scopes),
    }),
    credential: Object.freeze({
      id: credential.id,
      audience: typeof audience === 'string' ? audience : Object.freeze(audience),
      ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
    }),
  };
}

/**
 * Serve a defined server over Streamable HTTP. Throws
 * {@link McpDefinitionError} on malformed options (and for every reason
 * {@link createMcpServerFactory} does).
 *
 * @internal The `mcp` plugin owns these options once it exists.
 */
export function createMcpHttpEndpoint(
  server: McpServerDefinition,
  options: McpHttpOptions,
): McpHttpEndpoint {
  if (!isRecord(options)) {
    throw invalidOption('options', 'must be an object');
  }
  const resource = canonicalResource(options.resource);
  if (typeof options.authenticate !== 'function') {
    throw invalidOption('authenticate', 'must be a function');
  }
  const authenticate = options.authenticate;
  const scopesSupported = scopeList(options.scopesSupported, 'scopesSupported');
  const requiredScopes = scopeList(options.requiredScopes, 'requiredScopes');
  if (
    scopesSupported.length > 0 &&
    !requiredScopes.every((scope) => scopesSupported.includes(scope))
  ) {
    throw invalidOption('requiredScopes', 'must be listed in scopesSupported');
  }
  const host = new URL(resource).hostname;
  const allowedHosts = hostnames(options.allowedHosts, 'allowedHosts', host);
  const allowedOrigins = hostnames(options.allowedOrigins, 'allowedOrigins', host);
  if (
    options.legacy !== undefined &&
    options.legacy !== 'stateless' &&
    options.legacy !== 'reject'
  ) {
    throw invalidOption('legacy', "must be 'stateless' or 'reject'");
  }
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw invalidOption('maxRequestBytes', 'must be a positive integer');
  }
  const metadata =
    options.authorizationServers === undefined
      ? undefined
      : protectedResource({
          resource,
          authorizationServers: options.authorizationServers,
          ...(scopesSupported.length === 0 ? {} : { scopesSupported }),
          ...(options.resourceName === undefined ? {} : { resourceName: options.resourceName }),
          ...(options.resourceDocumentation === undefined
            ? {}
            : { resourceDocumentation: options.resourceDocumentation }),
        });
  const metadataUrl = metadata?.url;
  const factory = createMcpServerFactory(server, {
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.maxResultBytes === undefined ? {} : { maxResultBytes: options.maxResultBytes }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxToolInputElements === undefined
      ? {}
      : { maxToolInputElements: options.maxToolInputElements }),
    ...(options.requestStateKey === undefined ? {} : { requestStateKey: options.requestStateKey }),
    ...(options.requestStateTtlSeconds === undefined
      ? {}
      : { requestStateTtlSeconds: options.requestStateTtlSeconds }),
    ...(options.maxInputRounds === undefined ? {} : { maxInputRounds: options.maxInputRounds }),
  });
  const report = reporter(options.onError);
  const exchanges = new WeakMap<AuthInfo, Exchange>();
  const handler = createMcpHandler(
    (ctx) => {
      const exchange = ctx.authInfo === undefined ? undefined : exchanges.get(ctx.authInfo);
      if (exchange === undefined) {
        throw new Error('a request reached the MCP factory without passing the endpoint');
      }
      return factory({
        actor: exchange.actor,
        era: ctx.era,
        ...(exchange.credential === undefined ? {} : { credential: exchange.credential }),
        channel: 'stateless',
        onChallenge: (scopes) => {
          exchange.challenged = scopes;
        },
      });
    },
    {
      legacy: options.legacy ?? 'stateless',
      maxRequestBodySize: maxRequestBytes,
      onerror: (error) => {
        report('transport_error', 'the HTTP transport reported an error', TRANSPORT, error);
      },
    },
  );
  let closed = false;

  const authenticated = async (
    request: Request,
  ): Promise<{ actor: McpActor; credential: McpCredential | undefined } | Response> => {
    let answer: unknown;
    try {
      answer = await authenticate(request);
    } catch (error) {
      report('authentication_failed', 'the authenticate seam threw', TRANSPORT, error);
      return serverError();
    }
    if (isRecord(answer) && answer.kind === 'anonymous') {
      return requiredScopes.length > 0
        ? unauthorizedResponse('missing', requiredScopes, metadataUrl)
        : { actor: ANONYMOUS, credential: undefined };
    }
    if (
      isRecord(answer) &&
      answer.kind === 'rejected' &&
      (answer.reason === 'missing' || answer.reason === 'invalid' || answer.reason === 'expired')
    ) {
      return unauthorizedResponse(answer.reason, requiredScopes, metadataUrl);
    }
    const checked =
      isRecord(answer) && answer.kind === 'authenticated' ? checkAuthenticated(answer) : undefined;
    if (checked === undefined) {
      report(
        'invalid_authentication',
        'the authenticate seam answered something malformed',
        TRANSPORT,
      );
      return serverError();
    }
    if (!audienceIncludes(checked.credential.audience, resource)) {
      return unauthorizedResponse('invalid', requiredScopes, metadataUrl);
    }
    const expiresAt = checked.credential.expiresAt;
    if (expiresAt !== undefined && expiresAt * 1000 <= Date.now()) {
      return unauthorizedResponse('expired', requiredScopes, metadataUrl);
    }
    const held = checked.actor.scopes;
    if (held !== '*' && !requiredScopes.every((scope) => held.includes(scope))) {
      return insufficientScopeResponse(requiredScopes, metadataUrl);
    }
    return checked;
  };

  return Object.freeze({
    resource,
    protectedResource: metadata,
    async handle(request: Request): Promise<Response> {
      if (closed) {
        return Response.json({ error: 'unavailable' }, { status: 503 });
      }
      const hostHeader = request.headers.get('host') ?? new URL(request.url).host;
      if (!validateHostHeader(hostHeader, allowedHosts).ok) {
        return forbidden();
      }
      if (!validateOriginHeader(request.headers.get('origin'), allowedOrigins).ok) {
        return forbidden();
      }
      if (request.method.toUpperCase() !== 'POST') {
        return new Response(null, { status: 405, headers: { allow: 'POST' } });
      }
      const caller = await authenticated(request);
      if (caller instanceof Response) {
        return caller;
      }
      const authInfo: AuthInfo = {
        token: '',
        clientId: caller.credential?.id ?? '',
        scopes: caller.actor.scopes === '*' ? [] : [...caller.actor.scopes],
        resource: new URL(resource),
        ...(metadataUrl === undefined ? {} : { resourceMetadataUrl: metadataUrl }),
        ...(caller.credential?.expiresAt === undefined
          ? {}
          : { expiresAt: caller.credential.expiresAt }),
      };
      const exchange: Exchange = {
        actor: caller.actor,
        credential: caller.credential?.id,
        challenged: undefined,
      };
      exchanges.set(authInfo, exchange);
      const response = await handler.fetch(request, { authInfo });
      if (
        response.status === 403 &&
        exchange.challenged !== undefined &&
        caller.actor.kind === 'anonymous'
      ) {
        await response.body?.cancel();
        return unauthorizedResponse('missing', exchange.challenged, metadataUrl);
      }
      return response;
    },
    async close(): Promise<void> {
      closed = true;
      await handler.close();
    },
  });
}
