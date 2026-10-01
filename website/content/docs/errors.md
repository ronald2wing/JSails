---
title: Errors
order: 49
section: Reference
---

# Errors

`jsails/errors` is the error kernel: one way to declare a failure, raise it,
recognize it, and turn any thrown value into something a boundary (an HTTP
response, a CLI exit, a job outcome, a log line) can act on. It is
browser-safe and loads nothing but its own modules, so a package that only
needs to raise or recognize framework errors imports it and pays for nothing
else. The root entry, `jsails`, re-exports it together with the server half:
the boundary table and the problem+json encoder.

## Declaring codes

A domain declares its codes once with `defineErrors(domain, codes)`. Each code
states its **kind** (what went wrong, as a boundary treats it), its
**audience** (`operator` by default; `client` when the caller may read it), a
message template, and the value kind of each `{slot}` the template names.

```ts
import { defineErrors, type ErrorRegistry } from 'jsails/errors';

const INVOICE_ERRORS = {
  unknown_customer: {
    kind: 'not_found',
    message: 'customer {customer} has no billing profile',
    context: { customer: 'identifier' },
    suggestion: 'create the billing profile before invoicing',
  },
  already_sent: {
    kind: 'conflict',
    audience: 'client',
    message: 'The invoice has already been sent.',
  },
  line_limit: {
    kind: 'too_large',
    message: 'an invoice holds at most {limit} lines',
    context: { limit: 'count' },
  },
} as const;

export const InvoiceErrors: ErrorRegistry<'invoice', typeof INVOICE_ERRORS> = defineErrors(
  'invoice',
  INVOICE_ERRORS,
);
```

A context slot holds one of a closed set of value kinds: `identifier` (a name
the code chose: `A-Z a-z 0-9 _ . : @ / -`, at most 128 characters), `count` (a
non-negative integer), `relative-path` (a path relative to the project root),
or a list of strings, meaning one of those members. Free text is not a kind:
it is where secrets and raw input leak into logs and responses. Construction
validates every slot, and the message is rendered from the validated values
only, so a registry error's message is value-free by construction. A message
`{slot}` with no context entry is a compile error.

## Raising and recognizing

```ts
import { defineErrors, invariant, type ErrorRegistry } from 'jsails/errors';

const INVOICE_ERRORS = {
  unknown_customer: {
    kind: 'not_found',
    message: 'customer {customer} has no billing profile',
    context: { customer: 'identifier' },
  },
  line_limit: {
    kind: 'too_large',
    message: 'an invoice holds at most {limit} lines',
    context: { limit: 'count' },
  },
} as const;

const InvoiceErrors: ErrorRegistry<'invoice', typeof INVOICE_ERRORS> = defineErrors(
  'invoice',
  INVOICE_ERRORS,
);

export function assertCustomer(customer: string, known: ReadonlySet<string>): void {
  if (!known.has(customer)) throw new InvoiceErrors.Error('unknown_customer', { customer });
}

export function addLines(count: number, limit: number): void {
  invariant(count <= limit, InvoiceErrors, 'line_limit', { limit });
}

export function isUnknownCustomer(error: unknown): boolean {
  return InvoiceErrors.is(error, 'unknown_customer');
}
```

An error's `code` is `domain.code` (`invoice.unknown_customer`). Identity is a
`Symbol.for('jsails.error')` brand plus that code, never `instanceof`, so an
error raised by a second copy of `jsails` in the process is still recognized.
`isJsailsError(value)` tells any framework error; `isRegistryError(value)`
tells one raised through a registry, whose message is safe to show the
operator.

`invariant(condition, registry, code, context)`, as in `addLines` above, is
the check that replaces a hand-written `throw new TypeError(...)`.

## Client errors

The client-audience constructors are what an application throws on purpose
for its caller to see: `notFound()`, `forbidden()`, `unauthenticated()`,
`conflict(reason)`, `invalid(issues)`, `tooLarge()`, and
`rateLimited(retryAfterMs)`. Their messages are fixed text; what the caller
acts on travels as an exposed member (`issues`, `reason`) or, for a rate
limit, as the `Retry-After` header.

## Boundaries

`normalizeError(thrown)` turns anything into a framework error: a framework
error passes through, a Zod error becomes `request.invalid` with its issues, an
`AbortError` becomes `errors.aborted` (a non-error outcome boundaries do not
log), a `TimeoutError` becomes `errors.timeout`, a database unique violation
becomes the operator-audience `errors.unique_violation`, and anything else
becomes `errors.internal` with the original as its `cause`.
`registerErrorTranslator` adds a translator ahead of the built-in ones.

The boundary table (`BOUNDARY_TABLE`, `boundaryOutcome` from `jsails`) reads
the kind in the column the audience selects. A client error answers its kind's
status (404, 409, 422, ...); an operator error answers 500, or 503/504 with a
generic body for `unavailable`/`timeout`. Its retry column, whether a job that
failed with the kind is retried, is `isRetryableKind(kind)` from
`jsails/errors`, so a job runtime reads it without loading the server half.
The CLI exits 1, 75 for a failure a script may retry, and 130 for an aborted
command, and prints the error's `cause` chain under its message: a registry
error in full (its text rendered again from its code and context), any other
error as its class name, Node code and source location only, unless
`JSAILS_DEBUG=1` in the process environment asks for the underlying messages.
A thrown error that is no framework error does not get its message on the top
line either ([Failure reports](/docs/cli#failure-reports)). `toProblem` and
`problemResponse` encode the failure as RFC 9457 `application/problem+json`
(see below).

## The problem envelope

Every error answer the HTTP server sends is one RFC 9457
`application/problem+json` document, whichever layer failed:

```json
{
  "type": "about:blank",
  "title": "Unprocessable Content",
  "status": 422,
  "detail": "The request is invalid.",
  "code": "request.invalid",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "issues": [{ "path": ["email"], "code": "required" }]
}
```

`type` is `about:blank`, so `title` is the status's own phrase. A failure the
caller may read (a client error) carries its message as `detail`, its stable
`code`, and its exposed members (`issues`, `reason`); an operator failure (any
unexpected throw) carries only `type`, `title`, `status`, and `traceId`, so no
message, stack, or path ever reaches the caller. `traceId` is the trace the
request ran under, the key that finds the matching `onError` report.

One mapper turns every thrown value into its answer:

| Thrown | Status | `code` |
| --- | --- | --- |
| a registry error (`notFound()`, `forbidden()`, `invalid(issues)`, ...) | its kind's status | its code |
| a `ValidationError` (a schema, `readJsonBody`) | 422 | `request.invalid`, with `issues` |
| an `HttpError` | its status, with its headers | its code |
| a Hono `HTTPException` (`hono/basic-auth`, ...) | its status, with its headers | none |
| anything else, a string or a plain object included | 500 | none |

A route that matched nothing answers `404` `request.not_found`, or `405`
`http.method_not_allowed` with an `Allow` header when the path answers other
methods; a host the app does not serve answers `421` `http.misdirected_request`;
a body over its route's limit answers `413` `request.too_large`. Only a status
of 500 or above is reported to `onError`: everything below is an answer, not a
fault, so a `401` challenge or a `404` never logs. Headers a failure carries
(`Allow`, `WWW-Authenticate`, `Retry-After`) are kept on its answer, and every
error answer is `Cache-Control: private, no-store`. A failed page route or a
browser navigation gets an HTML error page instead
([Not-found and error pages](/docs/routing#not-found-and-error-pages)).

`jsonError(status, code, message, extra?, headers?)` (`jsails/api`) builds the
same document for a handler's own deliberate answer: `message` becomes `detail`
and `extra` further members. Pass only value-free text: the body reaches the
caller verbatim.
