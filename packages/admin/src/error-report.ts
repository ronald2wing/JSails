/**
 * Operator-facing failure reporting for the admin panel.
 *
 * Every admin route answers a failing callback (a throwing `render`, `list`,
 * `save`, action `run`, disk write, session resolver, or authorize gate) with a
 * value-free response, so the browser never sees the cause. Without a report
 * the operator could not tell a database outage from a permissions problem, so
 * each of those catches hands the error to {@link reportAdminError}, which
 * calls the panel's `onError` hook or, when none is configured, writes one
 * value-free line (the surface, the slug, and the error's name and `code`) to
 * stderr. The hook receives the error object itself; whatever it logs is the
 * operator's own choice. A throwing hook never changes the HTTP response.
 */

/** The admin surface a reported failure came from. */
export type AdminErrorSurface =
  | 'session'
  | 'authorize'
  | 'page'
  | 'search'
  | 'widget'
  | 'chart'
  | 'resource'
  | 'action'
  | 'relation'
  | 'upload';

/** What the admin knows about a reported failure; never request values. */
export interface AdminErrorContext {
  /** The surface whose callback failed. */
  readonly surface: AdminErrorSurface;
  /** The page, resource, widget, or chart slug/name, when the failure has one. */
  readonly slug?: string;
  /** The failing operation within the surface (`list`, `save`, `run`, ...). */
  readonly operation?: string;
}

/**
 * Receives every failure an admin route turns into a value-free response. It
 * runs synchronously in the request; a throw from it is swallowed.
 */
export type AdminErrorHandler = (error: unknown, context: AdminErrorContext) => void;

/** The slice of a panel the reporter reads. */
export interface AdminErrorSink {
  readonly onError?: AdminErrorHandler;
}

/** Report one failure through the panel's hook, or the default stderr line. */
export function reportAdminError(
  sink: AdminErrorSink | undefined,
  error: unknown,
  context: AdminErrorContext,
): void {
  const handler = sink?.onError ?? writeDefaultReport;
  try {
    handler(error, context);
  } catch {
    // Reporting is best effort: a broken hook must not turn a handled failure
    // into an unhandled one or change the response already chosen.
  }
}

/** The default report: one value-free line naming the surface and the error kind. */
function writeDefaultReport(error: unknown, context: AdminErrorContext): void {
  console.error(describeAdminFailure(error, context));
}

/**
 * Format a failure as `[jsails:admin] <surface>[.<operation>] (<slug>) failed:
 * <ErrorName> [<code>]`. The error message is left out on purpose: driver and
 * validation messages can carry the submitted values.
 */
export function describeAdminFailure(error: unknown, context: AdminErrorContext): string {
  const where =
    context.operation === undefined ? context.surface : `${context.surface}.${context.operation}`;
  const slug = context.slug === undefined ? '' : ` (${context.slug})`;
  return `[jsails:admin] ${where}${slug} failed: ${errorKind(error)}`;
}

/** The error's constructor name plus its string `code`, when it carries one. */
function errorKind(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error;
  }
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? `${error.name} [${code}]` : error.name;
}
