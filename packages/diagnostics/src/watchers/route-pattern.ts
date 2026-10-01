/**
 * Route identifiers for diagnostics entries: the matched route pattern
 * (`/reset-password/:token`), never the concrete path
 * (`/reset-password/9f2c...`).
 *
 * A request signal's `route` is the concrete pathname when the server has no
 * better identifier, and a path segment can carry a reset token, an invite
 * code, or a user id. Entries are exported verbatim to stdout and external
 * collectors, so the watchers record the pattern instead: when `route` is the
 * concrete pathname, every segment run that equals a route parameter's value
 * is replaced by `:name` (a multi-segment catch-all value by `:name*`; a value
 * containing `/` that arrived percent-encoded in one segment by `:name`). When
 * the server already reports a pattern (`route` differs from the pathname),
 * it is kept as is. Every occurrence of a value is replaced, including a
 * static segment that happens to equal it: a mislabelled segment is a smaller
 * cost than an exported identifier.
 */

import type { RequestSignalPayload } from 'jsails/signals';

/** Decode one path segment for comparison; a malformed escape stays raw. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The route pattern for a request signal, safe to record and export. */
export function routePatternOf(
  payload: Pick<RequestSignalPayload, 'route' | 'url' | 'params'>,
): string {
  const { route, url, params } = payload;
  if (!(url instanceof URL) || route !== url.pathname) {
    return route;
  }
  const entries = Object.entries(params ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
  );
  if (entries.length === 0) {
    return route;
  }

  const segments = route.split('/');
  const decoded = segments.map(decodeSegment);
  const replaced: (string | undefined)[] = [...segments];

  // Longer values first, so a catch-all claims its whole run before a shorter
  // value that happens to equal one of its segments.
  const byLength = [...entries].sort(([, a], [, b]) => b.length - a.length);
  for (const [name, value] of byLength) {
    const parts = value.split('/');
    if (parts.length > 1) {
      // A value containing `/` may also arrive percent-encoded (`ab%2Fcd`) in
      // a single segment, which decodes to the whole value.
      for (let index = 1; index < segments.length; index += 1) {
        if (replaced[index] === segments[index] && decoded[index] === value) {
          replaced[index] = `:${name}`;
        }
      }
    }
    for (let start = 1; start + parts.length <= segments.length; start += 1) {
      const run = decoded.slice(start, start + parts.length);
      const free = replaced.slice(start, start + parts.length).every((part, offset) => {
        return part === segments[start + offset];
      });
      if (free && run.join('/') === value) {
        replaced[start] = parts.length > 1 ? `:${name}*` : `:${name}`;
        for (let offset = 1; offset < parts.length; offset += 1) {
          replaced[start + offset] = undefined;
        }
      }
    }
  }
  return replaced.filter((part): part is string => part !== undefined).join('/');
}
