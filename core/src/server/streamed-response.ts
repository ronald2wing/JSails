/**
 * Identity tracking for progressively streamed responses.
 *
 * The ETag middleware buffers a response body to EOF to compute a digest. That
 * is correct for a finite document but defeats progressive rendering: a page
 * `stream` export that flushes a shell and then waits on slow data would have
 * its first chunk withheld until the producer finished. The middleware cannot
 * tell a progressive stream from a finite one by headers alone — both are
 * `text/html` — so the page route marks the response it hands back and the
 * middleware skips digesting exactly those.
 *
 * A `WeakSet` keyed by the `Response` object keeps this out of the response
 * headers (nothing leaks to clients) and lets the entry be collected with the
 * response. Only responses created by {@link markStreamedResponse} are tracked;
 * a finite non-SSE stream that never goes through the page route keeps its
 * ETag behavior.
 */

const streamed = new WeakSet<Response>();

/** Mark a response as progressively streamed so the ETag middleware skips it. */
export function markStreamedResponse(response: Response): Response {
  streamed.add(response);
  return response;
}

/** True when {@link markStreamedResponse} was called for this response. */
export function isStreamedResponse(response: Response): boolean {
  return streamed.has(response);
}
