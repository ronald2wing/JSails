/**
 * The server-component update protocol, version 2: the request a browser
 * controller sends to `/_jsails/components/update`, every reply the server
 * may give, their bounds, and the one parser both ends use (the server parses
 * requests with {@link parseUpdateRequest}, the controller parses replies with
 * {@link parseUpdateResponse}). There is no version 1 path: a request that does
 * not say `v: 2` is answered `protocol_mismatch`, which the client answers
 * with one guarded reload.
 *
 * The client states what it holds: `have.render` is the opaque render tag the
 * server issued for the DOM it shows, and `have.slots` lists the nested child
 * components inside it by `(slot, component)`. The server answers `unchanged`
 * when its render would produce the same tag with every child kept, keeps a
 * reported child by reference (a keep wrapper, the child is not executed),
 * and never re-derives a child from the parent's request; a parent asks the client to refresh
 * children through `effects.refresh`, and each child refreshes with its own
 * token.
 *
 * Browser-safe: it imports only the shared JSON scanner and shape guards.
 */

import type { JsonObject } from '../json/shape.js';
import { isPlainObject } from '../json/shape.js';
import { scanJson } from './json-scan.js';

/** The update protocol version this build speaks; the only one it accepts. */
export const COMPONENT_PROTOCOL_VERSION = 2;

/**
 * Maximum UTF-8 size of the JSON encoding of `have.slots`. Over it the client
 * refuses to send the update and the server answers `too_many_children`.
 *
 * @public
 */
export const MAX_HAVE_SLOTS_BYTES: number = 32 * 1024;

/**
 * Maximum length of one nested slot name, in characters.
 *
 * @public
 */
export const MAX_SLOT_LENGTH = 256;

/** Maximum length of one component id in `have.slots`, in characters. */
export const MAX_SLOT_COMPONENT_LENGTH = 256;

/** Maximum length of a render tag, in characters. */
export const MAX_RENDER_TAG_LENGTH = 128;

/** Maximum number of keys one update's `updates` object may carry. */
export const MAX_UPDATE_KEYS = 1000;

/**
 * One nested child the client holds: its slot in the parent and its component id.
 *
 * @public
 */
export interface ComponentHeldSlot {
  readonly slot: string;
  readonly component: string;
}

/**
 * What the client holds for the root it updates: the render tag of its DOM
 * (`null` when it holds no server render) and the nested children directly
 * inside it.
 *
 * @public
 */
export interface ComponentHave {
  readonly render: string | null;
  readonly slots: readonly ComponentHeldSlot[];
}

/**
 * A single action in an update request: a name plus optional explicit args.
 *
 * @public
 */
export interface ComponentUpdateAction {
  /** Registered action name. */
  readonly name: string;
  /** Explicit action args (a JSON object). Never derived from FormData. */
  readonly args?: JsonObject;
}

/**
 * The body of an update POST. `snapshot` is the signed token of the root;
 * `updates` holds only the top-level fields the client changed; `action`
 * carries at most one action; `sequence` is a client counter echoed back;
 * `have` states what the client holds.
 *
 * @public
 */
export interface ComponentUpdateRequest {
  readonly v: typeof COMPONENT_PROTOCOL_VERSION;
  readonly sequence: number;
  readonly snapshot: string;
  readonly updates: JsonObject;
  readonly action?: ComponentUpdateAction;
  readonly have: ComponentHave;
}

/**
 * Stable machine codes every component lane may answer with, from the shared
 * boundary: a malformed request, a refused credential (its signed origin
 * included) or authorization, an unknown component, the per-address limiter
 * (`rate_limited`), a full lane or an authorization fault (`unavailable`), the
 * lane deadline (`timeout`), and a server fault.
 *
 * @public
 */
export type ComponentBoundaryErrorCode =
  | 'invalid_request'
  | 'origin_mismatch'
  | 'invalid_snapshot'
  | 'forbidden'
  | 'unknown_component'
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'internal_error';

/** Every code an update `error` reply may carry. */
export const COMPONENT_UPDATE_ERROR_CODES: readonly ComponentUpdateErrorCode[] = Object.freeze([
  'invalid_request',
  'origin_mismatch',
  'invalid_snapshot',
  'forbidden',
  'unknown_component',
  'rate_limited',
  'unavailable',
  'timeout',
  'internal_error',
  'too_many_children',
]);

/**
 * Stable machine codes carried by an update `error` reply.
 *
 * @public
 */
export type ComponentUpdateErrorCode = ComponentBoundaryErrorCode | 'too_many_children';

/**
 * A top-level update failure descriptor. Value-free; never echoes raw input.
 *
 * @public
 */
export interface ComponentUpdateError {
  readonly code: ComponentUpdateErrorCode;
  readonly message: string;
}

/**
 * A download an action signaled: `url` is the signed GET endpoint for the
 * stored file, `filename` its display name. Server-crafted, never
 * client-supplied.
 *
 * @public
 */
export interface ComponentUpdateDownload {
  readonly url: string;
  readonly filename: string;
}

/**
 * What an action asked the client to do after applying the render: navigate
 * (`redirect`, validated server-side), fetch a file (`download`), or refresh
 * the listed nested children (`refresh`, slots of children this render kept),
 * each with its own token.
 *
 * @public
 */
export interface ComponentUpdateEffects {
  readonly redirect?: string;
  readonly download?: ComponentUpdateDownload;
  readonly refresh?: readonly string[];
}

/**
 * The render the client holds is still current. `snapshot` is present only
 * when the server re-signed the token (its sliding lifetime was more than half
 * spent); otherwise the client keeps its token byte for byte.
 *
 * @public
 */
export interface ComponentUnchangedResponse {
  readonly kind: 'unchanged';
  readonly sequence: number;
  readonly snapshot?: string;
}

/**
 * A new render of the root, its token, its render tag, and any effects.
 *
 * @public
 */
export interface ComponentRenderResponse {
  readonly kind: 'render';
  readonly sequence: number;
  readonly snapshot: string;
  readonly html: string;
  readonly render: string;
  readonly effects?: ComponentUpdateEffects;
}

/**
 * A validation failure (HTTP 422): field errors and a re-render that keeps the
 * submitted values. The token is unchanged; the render tag names the
 * re-render.
 *
 * @public
 */
export interface ComponentInvalidResponse {
  readonly kind: 'invalid';
  readonly sequence: number;
  readonly errors: Readonly<Record<string, string>>;
  readonly html: string;
  readonly render: string;
}

/**
 * A refused or failed update.
 *
 * @public
 */
export interface ComponentErrorResponse {
  readonly kind: 'error';
  readonly sequence: number;
  readonly error: ComponentUpdateError;
}

/**
 * The request spoke another protocol version; `v` is the one the server speaks.
 *
 * @public
 */
export interface ComponentProtocolMismatchResponse {
  readonly kind: 'protocol_mismatch';
  readonly sequence: number;
  readonly v: number;
}

/**
 * Every reply to an update request.
 *
 * @public
 */
export type ComponentUpdateResponse =
  | ComponentUnchangedResponse
  | ComponentRenderResponse
  | ComponentInvalidResponse
  | ComponentErrorResponse
  | ComponentProtocolMismatchResponse;

const textEncoder = new TextEncoder();

/** The UTF-8 size of the JSON encoding of `slots`, as the cap counts it. */
export function haveSlotsByteLength(slots: readonly ComponentHeldSlot[]): number {
  return textEncoder.encode(JSON.stringify(slots)).byteLength;
}

/** Why a request was refused before any credential work. */
export type UpdateRequestRejection = 'malformed' | 'protocol_mismatch' | 'too_many_children';

/** The outcome of {@link parseUpdateRequest}. */
export type UpdateRequestParse =
  | { readonly ok: true; readonly value: ComponentUpdateRequest }
  | {
      readonly ok: false;
      readonly reason: UpdateRequestRejection;
      /** The request's sequence when it was readable, else 0. */
      readonly sequence: number;
    };

const REQUEST_KEYS: ReadonlySet<string> = new Set([
  'v',
  'sequence',
  'snapshot',
  'updates',
  'action',
  'have',
]);

function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function parseAction(value: unknown): ComponentUpdateAction | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const { name, args } = value;
  if (typeof name !== 'string' || name.trim() === '' || name in Object.prototype) {
    return null;
  }
  if (args === undefined) {
    return { name };
  }
  if (!isPlainObject(args)) {
    return null;
  }
  return { name, args: args as JsonObject };
}

function parseHeldSlot(value: unknown): ComponentHeldSlot | null {
  if (!isPlainObject(value) || Object.keys(value).length !== 2) {
    return null;
  }
  const { slot, component } = value;
  if (!isBoundedString(slot, MAX_SLOT_LENGTH)) {
    return null;
  }
  if (!isBoundedString(component, MAX_SLOT_COMPONENT_LENGTH)) {
    return null;
  }
  return { slot, component };
}

function parseHave(value: unknown): ComponentHave | UpdateRequestRejection {
  if (!isPlainObject(value)) {
    return 'malformed';
  }
  const { render, slots } = value;
  if (render !== null && !isBoundedString(render, MAX_RENDER_TAG_LENGTH)) {
    return 'malformed';
  }
  if (!Array.isArray(slots)) {
    return 'malformed';
  }
  const held: ComponentHeldSlot[] = [];
  for (const entry of slots as unknown[]) {
    const parsed = parseHeldSlot(entry);
    if (parsed === null) {
      return 'malformed';
    }
    held.push(parsed);
  }
  if (haveSlotsByteLength(held) > MAX_HAVE_SLOTS_BYTES) {
    return 'too_many_children';
  }
  return { render, slots: held };
}

/**
 * Parse an update request body (already JSON-decoded). Never throws: a body
 * that is not a version 2 request is `protocol_mismatch`, an oversized
 * `have.slots` is `too_many_children`, and anything else that does not match
 * the shape, carries an unknown member, or fails the shared JSON scan is
 * `malformed`.
 */
export function parseUpdateRequest(payload: unknown): UpdateRequestParse {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: 'malformed', sequence: 0 };
  }
  const sequence = isSequence(payload.sequence) ? payload.sequence : undefined;
  const refuse = (reason: UpdateRequestRejection): UpdateRequestParse => ({
    ok: false,
    reason,
    sequence: sequence ?? 0,
  });
  if (payload.v !== COMPONENT_PROTOCOL_VERSION) {
    return refuse('protocol_mismatch');
  }
  if (sequence === undefined || scanJson(payload) !== null) {
    return refuse('malformed');
  }
  for (const key of Object.keys(payload)) {
    if (!REQUEST_KEYS.has(key)) {
      return refuse('malformed');
    }
  }
  const { snapshot, updates } = payload;
  if (typeof snapshot !== 'string' || snapshot.length === 0) {
    return refuse('malformed');
  }
  if (!isPlainObject(updates) || Object.keys(updates).length > MAX_UPDATE_KEYS) {
    return refuse('malformed');
  }
  let action: ComponentUpdateAction | undefined;
  if (payload.action !== undefined) {
    const parsed = parseAction(payload.action);
    if (parsed === null) {
      return refuse('malformed');
    }
    action = parsed;
  }
  const have = parseHave(payload.have);
  if (typeof have === 'string') {
    return refuse(have);
  }
  return {
    ok: true,
    value: {
      v: COMPONENT_PROTOCOL_VERSION,
      sequence,
      snapshot,
      updates: updates as JsonObject,
      ...(action === undefined ? {} : { action }),
      have,
    },
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function parseEffects(value: unknown): ComponentUpdateEffects | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const { redirect, download, refresh } = value;
  if (redirect !== undefined && (typeof redirect !== 'string' || redirect === '')) {
    return null;
  }
  let parsedDownload: ComponentUpdateDownload | undefined;
  if (download !== undefined) {
    if (
      !isPlainObject(download) ||
      typeof download.url !== 'string' ||
      download.url === '' ||
      typeof download.filename !== 'string'
    ) {
      return null;
    }
    parsedDownload = { url: download.url, filename: download.filename };
  }
  let parsedRefresh: string[] | undefined;
  if (refresh !== undefined) {
    if (!Array.isArray(refresh)) {
      return null;
    }
    parsedRefresh = [];
    for (const slot of refresh as unknown[]) {
      if (!isBoundedString(slot, MAX_SLOT_LENGTH)) {
        return null;
      }
      parsedRefresh.push(slot);
    }
  }
  return {
    ...(redirect === undefined ? {} : { redirect }),
    ...(parsedDownload === undefined ? {} : { download: parsedDownload }),
    ...(parsedRefresh === undefined ? {} : { refresh: parsedRefresh }),
  };
}

function isErrorCode(value: unknown): value is ComponentUpdateErrorCode {
  return (
    typeof value === 'string' && (COMPONENT_UPDATE_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Parse an update reply body (already JSON-decoded) into its typed form, or
 * `null` when it is not exactly one of the {@link ComponentUpdateResponse}
 * shapes. Never throws.
 */
export function parseUpdateResponse(value: unknown): ComponentUpdateResponse | null {
  if (!isPlainObject(value) || !isSequence(value.sequence)) {
    return null;
  }
  const sequence = value.sequence;
  switch (value.kind) {
    case 'unchanged': {
      const snapshot = value.snapshot;
      if (snapshot === undefined) {
        return { kind: 'unchanged', sequence };
      }
      return typeof snapshot === 'string' && snapshot !== ''
        ? { kind: 'unchanged', sequence, snapshot }
        : null;
    }
    case 'render': {
      const { snapshot, html, render } = value;
      if (
        typeof snapshot !== 'string' ||
        snapshot === '' ||
        typeof html !== 'string' ||
        !isBoundedString(render, MAX_RENDER_TAG_LENGTH)
      ) {
        return null;
      }
      if (value.effects === undefined) {
        return { kind: 'render', sequence, snapshot, html, render };
      }
      const effects = parseEffects(value.effects);
      return effects === null
        ? null
        : { kind: 'render', sequence, snapshot, html, render, effects };
    }
    case 'invalid': {
      const { errors, html, render } = value;
      if (
        !isStringRecord(errors) ||
        typeof html !== 'string' ||
        !isBoundedString(render, MAX_RENDER_TAG_LENGTH)
      ) {
        return null;
      }
      return { kind: 'invalid', sequence, errors, html, render };
    }
    case 'error': {
      const error = value.error;
      if (!isPlainObject(error) || !isErrorCode(error.code) || typeof error.message !== 'string') {
        return null;
      }
      return { kind: 'error', sequence, error: { code: error.code, message: error.message } };
    }
    case 'protocol_mismatch': {
      const v = value.v;
      return typeof v === 'number' && Number.isSafeInteger(v)
        ? { kind: 'protocol_mismatch', sequence, v }
        : null;
    }
    default:
      return null;
  }
}
