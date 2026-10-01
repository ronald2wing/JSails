/**
 * Role helpers for the `auth` plugin.
 *
 * The plugin adds a `role` column to Better Auth's user table (writable only
 * through `setUserRole`, never by the user) and the session resolver projects
 * it into `session.data.role`. These helpers read that field and produce the
 * default-deny predicates the admin panel and API resources expect: a session
 * with no string role is treated as having no role at all, and never throws on
 * a malformed session. They accept either a `Session` or a `RequestContext`,
 * so a page's `context` can be passed straight through.
 */

import type { RequestContext, Session } from 'jsails';

/** What the role helpers read a role from: a session, a request context, or nothing. */
export type RoleSubject = Session | RequestContext | null | undefined;

/** A role gate usable anywhere an `AdminPanelAuthorize`/`authorize` predicate is accepted. */
export type RoleCheck = (subject: RoleSubject) => boolean | Promise<boolean>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The session `data` behind a subject: the context's session's, or the subject's own. */
function subjectData(subject: RoleSubject): Record<string, unknown> | null {
  if (!isRecord(subject)) {
    return null;
  }
  const session = 'request' in subject && 'session' in subject ? subject.session : subject;
  return isRecord(session) && isRecord(session.data) ? session.data : null;
}

/**
 * Read the `role` from a session's data (or a request context's session), or
 * `null` when absent or not a string.
 */
export function sessionRole(subject: RoleSubject): string | null {
  const role = subjectData(subject)?.role;
  return typeof role === 'string' && role !== '' ? role : null;
}

/**
 * Build a predicate that allows exactly the named roles. A session with no (or
 * a non-string) role is denied; the result is `false`, never an exception.
 */
export function requireRole(...roles: readonly string[]): RoleCheck {
  return (subject) => {
    const role = sessionRole(subject);
    return role !== null && roles.includes(role);
  };
}

/** Predicate allowing only sessions whose role is exactly `admin`. */
export const adminOnly: RoleCheck = (subject) => sessionRole(subject) === 'admin';
