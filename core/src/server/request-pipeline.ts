/**
 * Shared request-pipeline primitives for the HTTP assembly.
 *
 * This module is a leaf of the `server` package's dependency graph: the
 * assembly (`app.ts`), the filesystem API registration (`api-routes.ts`), and
 * the framework routes all import from it, while it never imports back. It
 * holds the API method constants, the HTTP layer's own error codes (405,
 * 421), the options every route module shares, and plain
 * {@link RequestContext} construction, so no route module has to import the
 * assembly that imports it. The cross-site and access checks are the access
 * chain's (`security/access-chain.ts`); the problem envelope lives in
 * `api/error-response.ts`, because the browser-safe `jsails/api` uses it too.
 */

import type { ServiceRegistry } from '../extensions/services.js';
import type { AssetIndex } from '../assets/asset-index.js';
import type { AssetUrlResolver, RequestContext, Session } from '../contracts/http.js';
import type { PageRenderer } from '../contracts/render.js';
import type { RouteManifest } from '../routing/routes.js';
import type { RequestErrorReporter } from './request-errors.js';
import type { ResolvedReadiness } from './readiness.js';
import type { ErrorPageRenderer } from './error-pages.js';
import type { Guard, IdentitySource } from './request-frame.js';
import type { RequestScopeSpec } from './request-scope.js';

import type { ClientAddress, OriginPolicy, RequestOrigin } from '../security/request-origin.js';

/** HTTP method names recognized as API handler exports. */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;

import type { IntrospectRouteConfig } from '../introspect/route.js';
import type { SeoRuntimeOptions } from '../seo/metadata.js';
import { failureResponse, type Failure } from '../api/failure-response.js';
import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import type { SystemCheckRegistry } from '../database/system-checks.js';

/** Options resolved and validated by `createApp`; shared by every route module. */
export interface ResolvedOptions {
  readonly manifest: RouteManifest;
  /** Where identities come from: the `identity` option, or an adapter over `resolveSession`. */
  readonly identity: IdentitySource | undefined;
  readonly renderer: PageRenderer | undefined;
  readonly services: ServiceRegistry | undefined;
  /** The guard tier: config guards, then extension guards. */
  readonly guards: readonly Guard[];
  readonly maxBodyBytes: number;
  /** The deadline of a route that declares no `timeoutMs` (`0`: none). */
  readonly handlerTimeoutMs: number;
  /** The compiled `server` origin config the first stage resolves every request against. */
  readonly originPolicy: OriginPolicy;
  /** Continue every inbound `traceparent`, not only one a trusted proxy relayed. */
  readonly trustInboundTrace: boolean;
  /** The app's asset index: served before routing, and the source of `assetUrl`. */
  readonly assets: AssetIndex | undefined;
  readonly healthPath: string | undefined;
  readonly storagePath: string | undefined;
  readonly seo: SeoRuntimeOptions | undefined;
  readonly introspect: IntrospectRouteConfig | undefined;
  /** Optional system-check registry for the deep health probe. */
  readonly systemChecks?: SystemCheckRegistry;
  /** Validated readiness probes and their gate, when configured. */
  readonly readiness: ResolvedReadiness | undefined;
  /** Reports every unexpected failure: the app's `onError`, or the stderr logger. */
  readonly reportError: RequestErrorReporter;
  /** The app's HTML error-page renderer for browser navigations, when given. */
  readonly errorPage: ErrorPageRenderer | undefined;
  /** The extension request scopes, resolved by each request's claim in this order. */
  readonly scopes: readonly RequestScopeSpec[];
  /** Locale-prefixed routing: locales to register as `/{locale}` aliases. */
  readonly localeOptions?: { readonly locales: readonly string[]; readonly defaultLocale?: string };
  /** Milliseconds a streamed page's suspended subtrees have to finish after the shell. */
  readonly streamTimeoutMs?: number;
}

/** Inputs to {@link createRequestContext}; each field maps to one context field. */
interface BuildContextInput {
  readonly request: Request;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly session: Session | null;
  readonly origin?: RequestOrigin;
  readonly client?: ClientAddress;
  readonly services?: ServiceRegistry;
  readonly assetUrl?: AssetUrlResolver;
  readonly storagePath?: string;
  readonly seo?: SeoRuntimeOptions;
  readonly locale?: string;
}

/**
 * Build a {@link RequestContext} from a resolved request, URL, params, and
 * session, attaching the optional `origin`/`client`/`services`/`assetUrl`/
 * `storagePath` fields only when they are defined.
 */
export function createRequestContext(input: BuildContextInput): RequestContext {
  return {
    request: input.request,
    url: input.url,
    params: input.params,
    session: input.session,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.client === undefined ? {} : { client: input.client }),
    ...(input.services === undefined ? {} : { services: input.services }),
    ...(input.assetUrl === undefined ? {} : { assetUrl: input.assetUrl }),
    ...(input.storagePath === undefined ? {} : { storagePath: input.storagePath }),
    ...(input.seo === undefined ? {} : { seo: input.seo }),
    ...(input.locale === undefined ? {} : { locale: input.locale }),
  };
}

const HTTP_ERRORS = {
  method_not_allowed: {
    kind: 'invalid',
    audience: 'client',
    message: 'The request method is not allowed for this resource.',
  },
  misdirected_request: {
    kind: 'invalid',
    audience: 'client',
    message: 'This server does not serve the requested host.',
  },
} as const;

/**
 * The HTTP layer's own client codes, `http.*`: a method the matched path does
 * not answer (405, with `Allow`) and a host the app does not serve (421).
 * Their status is the HTTP answer's own, not a kind's.
 *
 * @public
 */
export const HttpErrors: ErrorRegistry<'http', typeof HTTP_ERRORS> = defineErrors(
  'http',
  HTTP_ERRORS,
);

/** The failure of an `http.*` code, answered with `status` and `headers`. */
export function httpFailure(
  code: keyof typeof HTTP_ERRORS,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): Failure {
  const error = new HttpErrors.Error(code);
  return Object.freeze({
    status,
    code: error.code,
    message: error.message,
    members: Object.freeze({}),
    headers: Object.freeze({ ...headers }),
    report: false,
  });
}

/**
 * The shared 405 answer with its `Allow` header, used by the HEAD-only GET
 * fallback; the not-found path answers other methods the same way.
 */
export function methodNotAllowedResponse(allow: string): Response {
  return failureResponse(httpFailure('method_not_allowed', 405, { allow }));
}
