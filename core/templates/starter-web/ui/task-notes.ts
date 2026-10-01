/**
 * Task note helpers, shared between the browser island and the server.
 *
 * Everything here is browser-safe: the counter island imports `summarizeNote`,
 * so this module is part of the client bundle. Server-only code (a database
 * call, a secret) does not belong in it. Put that in its own module whose
 * first statement is `'use server'`: a client build reduces such a module to
 * throwing stubs and drops its imports and constants, while a `'use server'`
 * inside one function of a mixed module like this one fails the build.
 *
 * `summarizeNote` is intentionally pure so SSR and hydration agree.
 */

/** Collapse whitespace and bound a note to a single short display line. */
export function summarizeNote(note: string, maxLength = 40): string {
  const collapsed = note.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}
