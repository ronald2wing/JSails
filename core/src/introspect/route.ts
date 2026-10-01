/**
 * The introspection route's handler.
 *
 * `createIntrospectHandler(services, config)` answers `GET /_jsails/introspect`
 * with a JSON envelope of runtime state, grouped into independently
 * requestable sections. The app registers it as a framework route whose
 * access is the config's `authorize` (default-deny: only an exact `true`
 * allows), so the route boundary claims the request and the access gate
 * decides before the handler runs. Any other method is answered 405 by the
 * not-found path; the path is reserved, so no other route can take it.
 */

import { bytesResponse, utf8 } from '../api/response-bodies.js';

import { jsonError } from '../api/failure-response.js';
import { INTROSPECT_SECTIONS, type IntrospectProvider } from './sections.js';
import type { Authorize } from '../contracts/http.js';
import type { RequestContext } from '../contracts/http.js';
import type { ServiceRegistry } from '../extensions/services.js';

/** Endpoint path for the introspection route. */
export const INTROSPECT_ENDPOINT = '/_jsails/introspect';

/** Resolved config shape the route needs from the caller. */
export interface IntrospectRouteConfig {
  readonly enabled: boolean;
  readonly authorize: Authorize;
  readonly sections: readonly string[];
  /** Registered introspection providers, resolved before route registration. */
  readonly providers: readonly IntrospectProvider[];
}

/** The body of a `GET /_jsails/introspect` response. */
interface IntrospectResponse {
  readonly generatedAt: number;
  readonly sections: Record<string, unknown>;
}

/**
 * The introspection handler for `config`: the gate has already authorized the
 * request. The `introspect` config is assumed already resolved and validated
 * by the application config loader.
 */
export function createIntrospectHandler(
  services: ServiceRegistry | undefined,
  introspect: IntrospectRouteConfig,
): (context: RequestContext) => Promise<Response> {
  const providers = introspect.providers;
  // `introspect.sections` is the DEFAULT set returned when no `?section=` is
  // given; an explicit request may name any valid section, so validation uses
  // the full section list rather than the configured default.
  const defaultSections = new Set(introspect.sections);
  const validSections = new Set<string>(INTROSPECT_SECTIONS);

  return async (context) => {
    const url = context.url;
    const generatedAt = Date.now();

    // `?section=` is comma-separated and repeatable; omitted means every
    // section the config allows.
    const requestedSections = parseRequestedSections(
      url.searchParams,
      validSections,
      defaultSections,
    );
    if (requestedSections === undefined) {
      return jsonError(
        400,
        'invalid_section',
        'one or more requested sections are not recognized',
        { valid: [...INTROSPECT_SECTIONS] },
      );
    }

    // Collect each requested section independently — one provider failing never
    // fails the rest of the response.
    const sections: Record<string, unknown> = Object.create(null);
    for (const sectionName of requestedSections) {
      sections[sectionName] = await collectSection(sectionName, providers, context, services);
    }

    const body: IntrospectResponse = { generatedAt, sections };
    return bytesResponse(utf8(JSON.stringify(body)), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse `?section=` parameters into a deduplicated list. A parameter value may
 * be comma-separated and the key may repeat. Returns `undefined` when any
 * single section name is not a valid section (unknown sections are rejected
 * explicitly); when absent, returns the configured default set.
 */
function parseRequestedSections(
  params: URLSearchParams,
  valid: ReadonlySet<string>,
  defaults: ReadonlySet<string>,
): string[] | undefined {
  const names: string[] = [];
  for (const raw of searchParamValues(params, 'section')) {
    for (const name of raw.split(',')) {
      const trimmed = name.trim();
      if (trimmed === '') continue;
      if (!valid.has(trimmed)) return undefined;
      names.push(trimmed);
    }
  }
  if (names.length === 0) return [...defaults].sort();
  // Deduplicate, preserving first-occurrence order.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/** Collect the values for one `section` query with repeatable key support. */
function searchParamValues(params: URLSearchParams, key: string): string[] {
  const values: string[] = [];
  for (const [k, v] of params.entries()) {
    if (k === key) values.push(v);
  }
  return values;
}

/**
 * Collect one section from the registered providers. When no provider handles
 * the section, the result is `unavailable`. A thrown exception is caught and
 * serialized as a value-free `error` entry, isolating the failure.
 */
async function collectSection(
  sectionName: string,
  providers: readonly IntrospectProvider[],
  context: RequestContext,
  services: ServiceRegistry | undefined,
): Promise<unknown> {
  try {
    const provider = providers.find((p) => p.section === sectionName);
    if (provider === undefined) {
      return { status: 'unavailable' };
    }
    const data = await provider.collect(context, services);
    // When `collect` already returned a status object, pass it through. This is
    // the normal path for built-in providers that decide their own availability.
    if (isSectionResult(data)) return data;
    return { status: 'ok', data };
  } catch {
    return {
      status: 'error',
      error: { code: 'section_error', message: 'Failed to collect section data' },
    };
  }
}

/** Whether a value is already a shaped section result with a `status` field. */
function isSectionResult(value: unknown): value is { status: string } {
  return value !== null && typeof value === 'object' && 'status' in value;
}
