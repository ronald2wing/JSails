/**
 * Drive a runtime's transport routes the way the HTTP layer does, for tests
 * that hold a hand-built request context: each call goes through the lane
 * boundary and returns the decoded answer plus every failure the route
 * reported.
 */

import type { RequestContext } from '../../src/contracts/http.js';
import type { ServerComponentsRuntime } from '../../src/server-components/runtime/index.js';
import {
  COMPONENT_PROTOCOL_VERSION,
  type ComponentHeldSlot,
  type ComponentUpdateEffects,
} from '../../src/wire/protocol.js';

/** Every member a transport route's JSON body may carry. */
export interface LaneBody {
  readonly kind?: string;
  readonly sequence?: number;
  readonly snapshot?: string;
  readonly html?: string;
  readonly render?: string;
  readonly effects?: ComponentUpdateEffects;
  readonly errors?: Readonly<Record<string, string>>;
  readonly error?: { readonly code: string; readonly message: string };
  readonly reference?: string;
  readonly v?: number;
}

/** The members of a version 2 update request a test chooses. */
export interface UpdateBodyFields {
  readonly snapshot: string;
  readonly updates?: Record<string, unknown>;
  readonly sequence?: number;
  readonly action?: { readonly name: string; readonly args?: Record<string, unknown> };
  /** `have.render`; omitted, the client holds no render. */
  readonly render?: string | null;
  /** `have.slots`; omitted, the client holds no nested child. */
  readonly slots?: readonly ComponentHeldSlot[];
}

/** A version 2 update request body. */
export function updateBody(fields: UpdateBodyFields): Record<string, unknown> {
  return {
    v: COMPONENT_PROTOCOL_VERSION,
    sequence: fields.sequence ?? 1,
    snapshot: fields.snapshot,
    updates: fields.updates ?? {},
    ...(fields.action === undefined ? {} : { action: fields.action }),
    have: { render: fields.render ?? null, slots: fields.slots ?? [] },
  };
}

/** A decoded JSON answer from a transport route. */
export interface LaneAnswer {
  readonly status: number;
  readonly body: LaneBody;
  readonly headers: Headers;
  readonly reported: readonly unknown[];
}

/** A download answer: the raw response, so a test can read the stream. */
export interface DownloadAnswer {
  readonly status: number;
  readonly response: Response;
  readonly reported: readonly unknown[];
}

async function decode(response: Response, reported: readonly unknown[]): Promise<LaneAnswer> {
  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? {} : JSON.parse(text)) as LaneBody,
    headers: response.headers,
    reported,
  };
}

/**
 * POST `payload` to the update route with `context`'s request headers (its
 * `Origin`) and the context's other members.
 */
export async function callUpdate(
  runtime: ServerComponentsRuntime,
  payload: unknown,
  context: RequestContext,
): Promise<LaneAnswer> {
  const request = new Request(context.request.url, {
    method: 'POST',
    headers: context.request.headers,
    body: JSON.stringify(payload),
  });
  const reported: unknown[] = [];
  const response = await runtime.routes.update(request, { ...context, request }, (error) => {
    reported.push(error);
  });
  return decode(response, reported);
}

/** Send `request` (a multipart upload) to the upload route. */
export async function callUpload(
  runtime: ServerComponentsRuntime,
  request: Request,
  context: RequestContext,
): Promise<LaneAnswer> {
  const reported: unknown[] = [];
  const response = await runtime.routes.upload(request, { ...context, request }, (error) => {
    reported.push(error);
  });
  return decode(response, reported);
}

/** GET the download route with `context`'s request. */
export async function callDownload(
  runtime: ServerComponentsRuntime,
  context: RequestContext,
): Promise<DownloadAnswer> {
  const reported: unknown[] = [];
  const response = await runtime.routes.download(context.request, context, (error) => {
    reported.push(error);
  });
  return { status: response.status, response, reported };
}
