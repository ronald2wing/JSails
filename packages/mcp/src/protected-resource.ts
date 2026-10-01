/**
 * The OAuth 2.0 resource-server surface of an MCP HTTP endpoint: the canonical
 * resource identifier (RFC 8707), the Protected Resource Metadata document and
 * its path-inserted well-known location (RFC 9728), and the `WWW-Authenticate`
 * challenges (RFC 6750) the endpoint answers with.
 *
 * The metadata document is built here rather than with the SDK's
 * `buildOAuthProtectedResourceMetadata`, which derives `authorization_servers`
 * from a single authorization server's metadata document; RFC 9728 lists
 * issuers, and the endpoint takes issuers. The issuer rules are the SDK's
 * (HTTPS outside loopback, no query, no fragment), and the well-known URL comes
 * from the SDK's `getOAuthProtectedResourceMetadataUrl`.
 *
 * Challenges for a bad token and for a missing scope come from the SDK's
 * `bearerAuthChallengeResponse`. A request with no credential at all gets a
 * challenge without an error code, as RFC 6750 section 3.1 asks, naming the
 * metadata document and the scopes that would let it through.
 */

import {
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
} from '@modelcontextprotocol/server';

import { McpDefinitionError } from './errors.js';

/** The RFC 9728 document an endpoint serves. */
export interface McpProtectedResourceDocument {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly bearer_methods_supported: readonly ['header'];
  readonly scopes_supported?: readonly string[];
  readonly resource_name?: string;
  readonly resource_documentation?: string;
}

/** What {@link protectedResource} takes. */
export interface ProtectedResourceOptions {
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  readonly scopesSupported?: readonly string[];
  readonly resourceName?: string;
  readonly resourceDocumentation?: string;
}

/** A configured protected resource. */
export interface ProtectedResource {
  /** The metadata document's absolute URL. */
  readonly url: string;
  /** The metadata document's path, where it must be mounted. */
  readonly path: string;
  readonly document: McpProtectedResourceDocument;
  /** Serve the document: `GET`/`HEAD`, a CORS preflight, otherwise `405`. */
  respond(request: Request): Response;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** RFC 6749 `scope-token`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

function invalidOption(option: string, reason: string): McpDefinitionError {
  return new McpDefinitionError('invalid_option', `${option} ${reason}`, { option });
}

function secureUrl(value: unknown, option: string): URL {
  if (typeof value !== 'string' || !URL.canParse(value)) {
    throw invalidOption(option, 'must be an absolute URL');
  }
  const url = new URL(value);
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) {
    throw invalidOption(option, 'must use https: (http: only on a loopback host)');
  }
  if (url.hash !== '' || value.includes('#')) {
    throw invalidOption(option, 'must not have a fragment');
  }
  if (url.username !== '' || url.password !== '') {
    throw invalidOption(option, 'must not carry credentials');
  }
  return url;
}

/**
 * The canonical form of a resource identifier: an absolute `https:` URL
 * (`http:` on loopback) without fragment or credentials, as the WHATWG parser
 * serializes it. Throws {@link McpDefinitionError} otherwise.
 */
export function canonicalResource(value: unknown): string {
  return secureUrl(value, 'resource').href;
}

/** Comparable form of a resource identifier: no fragment, at most one trailing slash removed. */
function comparable(value: string): string | undefined {
  if (!URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

/** True when `audience` names `resource` (one value, or one of a list). */
export function audienceIncludes(audience: unknown, resource: string): boolean {
  const target = comparable(resource);
  const values: unknown[] = Array.isArray(audience) ? audience : [audience];
  return values.some((value) => typeof value === 'string' && comparable(value) === target);
}

/** Check a list of OAuth scope tokens. */
export function scopeList(value: unknown, option: string): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value)) {
    throw invalidOption(option, 'must be an array of scope tokens');
  }
  const scopes: unknown[] = value;
  const checked: string[] = [];
  for (const scope of scopes) {
    if (typeof scope !== 'string' || !SCOPE_TOKEN.test(scope)) {
      throw invalidOption(option, 'must hold OAuth scope tokens');
    }
    if (!checked.includes(scope)) {
      checked.push(scope);
    }
  }
  return Object.freeze(checked);
}

function optionalText(value: unknown, option: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidOption(option, 'must be a non-empty string');
  }
  return value;
}

/** Configure the metadata document for a resource. Throws {@link McpDefinitionError}. */
export function protectedResource(options: ProtectedResourceOptions): ProtectedResource {
  const resource = canonicalResource(options.resource);
  if (!Array.isArray(options.authorizationServers) || options.authorizationServers.length === 0) {
    throw invalidOption('authorizationServers', 'must list at least one issuer');
  }
  const servers: unknown[] = [...options.authorizationServers];
  const issuers = servers.map((issuer) => {
    const url = secureUrl(issuer, 'authorizationServers');
    if (url.search !== '') {
      throw invalidOption('authorizationServers', 'must not have a query');
    }
    return url.href;
  });
  const scopes = scopeList(options.scopesSupported, 'scopesSupported');
  const name = optionalText(options.resourceName, 'resourceName');
  const documentation =
    options.resourceDocumentation === undefined
      ? undefined
      : secureUrl(options.resourceDocumentation, 'resourceDocumentation').href;
  const document: McpProtectedResourceDocument = Object.freeze({
    resource,
    authorization_servers: Object.freeze([...new Set(issuers)]),
    bearer_methods_supported: Object.freeze(['header'] as const),
    ...(scopes.length === 0 ? {} : { scopes_supported: scopes }),
    ...(name === undefined ? {} : { resource_name: name }),
    ...(documentation === undefined ? {} : { resource_documentation: documentation }),
  });
  const url = getOAuthProtectedResourceMetadataUrl(new URL(resource));
  const body = JSON.stringify(document);
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'mcp-protocol-version',
  };
  return Object.freeze({
    url,
    path: new URL(url).pathname,
    document,
    respond(request: Request): Response {
      const method = request.method.toUpperCase();
      if (method === 'GET' || method === 'HEAD') {
        return new Response(method === 'HEAD' ? null : body, {
          status: 200,
          headers: {
            ...cors,
            'content-type': 'application/json',
            'cache-control': 'public, max-age=3600',
          },
        });
      }
      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
      }
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD, OPTIONS' } });
    },
  });
}

/** An HTTP quoted-string value, escaped as the SDK's challenge formatter escapes it. */
function quoted(value: string): string {
  return `"${value.replaceAll(/[\\"]/g, '\\$&').replaceAll(/[^\x20-\x7E]/g, ' ')}"`;
}

/** Why a request is unauthenticated. */
export type UnauthorizedReason = 'missing' | 'invalid' | 'expired';

/**
 * The `401` answer. `missing` (no credential) carries no error code; a bad or
 * expired token gets `error="invalid_token"`. Both name the metadata document
 * and, when there are any, the scopes that would be enough.
 */
export function unauthorizedResponse(
  reason: UnauthorizedReason,
  scopes: readonly string[],
  metadataUrl: string | undefined,
): Response {
  if (reason !== 'missing') {
    return bearerAuthChallengeResponse(
      new OAuthError(
        OAuthErrorCode.InvalidToken,
        reason === 'expired' ? 'The access token has expired' : 'The access token is not valid',
      ),
      {
        requiredScopes: [...scopes],
        ...(metadataUrl === undefined ? {} : { resourceMetadataUrl: metadataUrl }),
      },
    );
  }
  const params = [
    ...(metadataUrl === undefined ? [] : [`resource_metadata=${quoted(metadataUrl)}`]),
    ...(scopes.length === 0 ? [] : [`scope=${quoted(scopes.join(' '))}`]),
  ];
  return new Response(null, {
    status: 401,
    headers: {
      'www-authenticate': params.length === 0 ? 'Bearer' : `Bearer ${params.join(', ')}`,
    },
  });
}

/** The `403 insufficient_scope` answer naming every scope required, in one challenge. */
export function insufficientScopeResponse(
  scopes: readonly string[],
  metadataUrl: string | undefined,
): Response {
  return bearerAuthChallengeResponse(
    new OAuthError(OAuthErrorCode.InsufficientScope, 'Insufficient scope'),
    {
      requiredScopes: [...scopes],
      ...(metadataUrl === undefined ? {} : { resourceMetadataUrl: metadataUrl }),
    },
  );
}
