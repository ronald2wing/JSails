/**
 * The `http(s)` origin shape: scheme plus host, nothing else.
 *
 * Dependency-free beyond the standard `URL`, so the browser-safe `jsails/client`
 * bundle and server modules can both import it.
 */

/** Why a value is not an `http(s)` origin. */
export type HttpOriginProblem =
  'not_a_url' | 'unsupported_scheme' | 'has_credentials' | 'not_origin_only';

/** The value-free phrase for each {@link HttpOriginProblem}, to follow a field name. */
export const HTTP_ORIGIN_PROBLEMS: Readonly<Record<HttpOriginProblem, string>> = Object.freeze({
  not_a_url: 'must be a valid http(s) origin',
  unsupported_scheme: 'must use the http or https scheme',
  has_credentials: 'must not contain credentials',
  not_origin_only: 'must be an origin only (no path, query, or fragment)',
});

/** Classify a string as a canonical origin or name what disqualifies it. */
function checkHttpOrigin(
  value: string,
): { readonly origin: string } | { readonly problem: HttpOriginProblem } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: 'not_a_url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { problem: 'unsupported_scheme' };
  }
  if (url.username !== '' || url.password !== '') {
    return { problem: 'has_credentials' };
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return { problem: 'not_origin_only' };
  }
  return { origin: url.origin };
}

/** True for `http(s)` origins only: no path, query, fragment, or credentials. */
export function isHttpOrigin(value: unknown): value is string {
  return typeof value === 'string' && 'origin' in checkHttpOrigin(value);
}

/**
 * Canonicalize an `http(s)` origin (lowercased host, no trailing slash) or
 * throw `makeError(problem)`, which receives the matching phrase from
 * {@link HTTP_ORIGIN_PROBLEMS} and must not echo the value.
 */
export function assertHttpOrigin(value: string, makeError: (problem: string) => Error): string {
  const checked = checkHttpOrigin(value);
  if ('problem' in checked) {
    throw makeError(HTTP_ORIGIN_PROBLEMS[checked.problem]);
  }
  return checked.origin;
}
