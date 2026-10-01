/**
 * The request context's body readers (`ctx.body`): JSON validated by a
 * schema, form data, bytes, the stream, and the parts of a multipart body,
 * each over the route's request, whose body the budget bounds
 * (`body-budget.ts`).
 *
 * A route states the body it reads (`body: { kind, maxBytes }`). Outside
 * production a reader of another kind, or any reader on a route that declares
 * none, throws `body.undeclared_read` (a 500), so a route reading more than it
 * states is caught in development and test; production reads under the
 * budget as the route asks. The multipart reader refuses the same way in
 * production too: it reads under the parts the route declares
 * (`multipart.ts`), and without a declaration there are none to read under.
 * A part past its declared cap marks the budget exceeded, so the request is
 * answered 413 as for a body past the route's limit.
 */

import { readFormData } from '../api/forms.js';
import { readJsonBody } from '../api/json-body.js';
import type { MultipartPart, RequestBody } from '../contracts/http.js';
import { readStreamBounded } from '../support/bytes.js';
import { tooLarge } from '../errors/kernel.js';
import { BodyErrors, type RequestBodyBudget } from './body-budget.js';
import { readMultipart } from './multipart.js';
import type { BodyKind, BodySpec } from './route-limits.js';

/** Never called: the budget, not this read, bounds the body. */
function unbounded(): never {
  throw tooLarge();
}

/** An empty body stream, for a request that carries none. */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/** What the readers need of the request's frame. */
export interface RequestBodyOptions {
  /** Refuse a reader of a kind the route does not declare (outside production). */
  readonly strict: boolean;
  /** The budget the body is read through, marked exceeded when a part crosses its cap. */
  readonly budget: RequestBodyBudget | undefined;
  /** The request's signal (client gone, deadline passed), asked for when a reader needs it. */
  readonly signal: () => AbortSignal;
}

/** The readers of `request`'s body for a route declaring `spec`. */
export function createRequestBody(
  request: Request,
  spec: BodySpec | undefined,
  options: RequestBodyOptions,
): RequestBody {
  const declared = (reader: BodyKind): void => {
    if (options.strict && spec?.kind !== reader) {
      throw new BodyErrors.Error('undeclared_read', { reader });
    }
  };
  return Object.freeze({
    async json<T>(schema: { validate(input: unknown): T }): Promise<T> {
      declared('json');
      return schema.validate(await readJsonBody(request));
    },
    async form(): Promise<FormData> {
      declared('form');
      return readFormData(request);
    },
    async bytes(): Promise<Uint8Array> {
      declared('raw');
      return readStreamBounded(request.body, Number.POSITIVE_INFINITY, unbounded);
    },
    stream(): ReadableStream<Uint8Array> {
      declared('raw');
      return request.body ?? emptyStream();
    },
    multipart(): AsyncIterable<MultipartPart> {
      if (spec?.kind !== 'multipart') {
        throw new BodyErrors.Error('undeclared_read', { reader: 'multipart' });
      }
      const budget = options.budget;
      return readMultipart(request.body, request.headers.get('content-type'), spec.parts, {
        signal: options.signal(),
        ...(budget === undefined ? {} : { onLimit: () => budget.exceed() }),
      });
    },
  });
}
