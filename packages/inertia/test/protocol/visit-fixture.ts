/**
 * Request fixtures for the protocol tests: build request facts and the parsed
 * visit from a path and a header record, and resolve props for them.
 */

import { readInertiaVisit, type InertiaRequestFacts, type InertiaVisit } from '../../src/index.js';
import {
  resolveProps,
  type ResolvedProps,
  type ResolvePropsInput,
} from '../../src/resolve-props.js';

/** Request facts and the parsed visit for one request. */
export interface RequestFixture {
  readonly facts: InertiaRequestFacts;
  readonly visit: InertiaVisit;
}

/** Facts for `path` on `https://example.test` with `headers`. */
export function request(
  path: string,
  headers: Readonly<Record<string, string>> = {},
  options: { readonly method?: string; readonly signal?: AbortSignal } = {},
): RequestFixture {
  const headerBag = new Headers(headers);
  return {
    facts: {
      method: options.method ?? 'GET',
      url: new URL(path, 'https://example.test'),
      headers: headerBag,
      signal: options.signal ?? new AbortController().signal,
    },
    visit: readInertiaVisit(headerBag),
  };
}

/** Headers of a partial reload of `component`. */
export function partialHeaders(
  component: string,
  lists: {
    readonly only?: string;
    readonly except?: string;
    readonly reset?: string;
    readonly exceptOnce?: string;
  } = {},
): Record<string, string> {
  return {
    'X-Inertia': 'true',
    'X-Inertia-Partial-Component': component,
    ...(lists.only === undefined ? {} : { 'X-Inertia-Partial-Data': lists.only }),
    ...(lists.except === undefined ? {} : { 'X-Inertia-Partial-Except': lists.except }),
    ...(lists.reset === undefined ? {} : { 'X-Inertia-Reset': lists.reset }),
    ...(lists.exceptOnce === undefined ? {} : { 'X-Inertia-Except-Once-Props': lists.exceptOnce }),
  };
}

/** Resolve `props` for `component` on a request with `headers`. */
export function resolveWith(
  component: string,
  props: ResolvePropsInput['props'],
  headers: Readonly<Record<string, string>> = {},
  extra: Partial<Omit<ResolvePropsInput, 'component' | 'props' | 'facts' | 'visit'>> = {},
): Promise<ResolvedProps> {
  const { facts, visit } = request('/page', headers);
  return resolveProps({ component, props, facts, visit, ...extra });
}
