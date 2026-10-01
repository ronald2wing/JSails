/**
 * Browser-safe wire protocol for stateful server components.
 *
 * This module defines the constants and types shared between the server
 * runtime (`runtime/`) and any browser client that drives components: the
 * transport endpoints, the marker attributes the server renders onto a
 * component root and its nested wrappers, and the upload and download
 * response shapes. The update request and reply shapes are the wire
 * protocol (`../wire/protocol.ts`).
 *
 * It imports only type-only contracts, so it is safe to bundle into a browser
 * client: no Node, Preact, or DOM dependency is pulled in at runtime.
 *
 * Security posture (enforced by the runtime, declared here for the client):
 * - A component update is a state change, so it is always a same-origin POST:
 *   the update and upload endpoints accept the session cookie, so the access
 *   chain refuses one whose `Origin` (or, without it, `Sec-Fetch-Site`) does
 *   not name the app's own origin.
 * - The snapshot token is a signed record (HMAC-SHA256); it is integrity
 *   protection, not encryption, and is replayed until it expires.
 */

import type { ComponentBoundaryErrorCode } from '../wire/protocol.js';

// ---------------------------------------------------------------------------
// Transport endpoint
// ---------------------------------------------------------------------------

/** Path the runtime mounts the component-update surface under. */
export const COMPONENT_UPDATE_ENDPOINT = '/_jsails/components/update';

/** Path the runtime mounts the component-upload surface under. */
export const COMPONENT_UPLOAD_ENDPOINT = '/_jsails/components/upload';

/** Path the runtime mounts the component-download GET surface under. */
export const COMPONENT_DOWNLOAD_ENDPOINT = '/_jsails/components/download';

/** Multipart field carrying the signed snapshot on an upload. */
export const COMPONENT_UPLOAD_SNAPSHOT_FIELD = 'snapshot';

/** Multipart field carrying the uploaded file on an upload. */
export const COMPONENT_UPLOAD_FILE_FIELD = 'file';

/**
 * Object key a signed upload reference occupies in component state. The value
 * is the reference token itself (`{ __upload: string }`), declared in a
 * component's `stateSchema` via `uploadRefSchema()`.
 */
export const UPLOAD_REFERENCE_KEY = '__upload';

/** A signed upload reference as stored in component state. */
export interface UploadReference {
  readonly __upload: string;
}

// ---------------------------------------------------------------------------
// Marker attributes (the SSR/author contract)
// ---------------------------------------------------------------------------

/**
 * Root marker present on every server-component root; its value is the
 * registered component name, so a client can find roots and resolve their
 * action surface with a single attribute selector.
 */
export const COMPONENT_ATTRIBUTE = 'data-jsails-component';

/** Explicit component-name marker (value equals {@link COMPONENT_ATTRIBUTE}). */
export const COMPONENT_NAME_ATTRIBUTE = 'data-jsails-component-name';

/** Signed snapshot token carried on the root; echoed back verbatim on update. */
export const COMPONENT_SNAPSHOT_ATTRIBUTE = 'data-jsails-component-snapshot';

/** Prefix of the root element id, followed by the signed snapshot id. */
export const COMPONENT_ROOT_ID_PREFIX = 'jsails-component-';

/** Model-binding marker spread onto an element by `bind(name)`. */
export const MODEL_ATTRIBUTE = 'data-jsails-model';

/** Action-trigger marker spread onto an element by `call(action, args?)`. */
export const CALL_ATTRIBUTE = 'data-jsails-call';

/** Form-submit marker spread onto an element by `submit(action, args?)`. */
export const SUBMIT_ATTRIBUTE = 'data-jsails-submit';

/** Serialized (JSON) action arguments, carried alongside call/submit markers. */
export const ARGS_ATTRIBUTE = 'data-jsails-args';

/** Turbo attribute a submit helper pins to `false` so a submit is a plain POST. */
export const TURBO_ATTRIBUTE = 'data-turbo';

/** Marker set on a file input while its upload is in flight. */
export const COMPONENT_UPLOADING_ATTRIBUTE = 'data-jsails-uploading';

/**
 * Component-root attribute carrying the maximum accepted upload size in bytes,
 * as a decimal string. A client may read it to reject an oversized file before
 * uploading; absence or an unparseable value means "no client-side bound".
 */
export const COMPONENT_UPLOAD_MAX_BYTES_ATTRIBUTE = 'data-jsails-upload-max-bytes';

/** Polling-marker spread onto a component root by `poll(options)`. */
export const POLL_ATTRIBUTE = 'data-jsails-poll';

/**
 * Render-tag marker on a live component root: the opaque tag the server issued
 * for this render. The client echoes it as `have.render` on its next update, so
 * the server can answer `unchanged` when nothing would change.
 *
 * @public
 */
export const COMPONENT_RENDER_ATTRIBUTE = 'data-jsails-component-render';

/**
 * Slot marker on the wrapper `renderNested` emits around a nested child root.
 * Its value names the child's place in the parent's render (`k:<key>` or
 * `p:<component>:<n>`); with {@link NESTED_COMPONENT_ATTRIBUTE} it is the
 * child's identity, which the client reports in `have.slots`.
 */
export const NESTED_SLOT_ATTRIBUTE = 'data-jsails-nested-slot';

/**
 * Component-id marker on a nested child's wrapper, beside {@link NESTED_SLOT_ATTRIBUTE}.
 *
 * @public
 */
export const NESTED_COMPONENT_ATTRIBUTE = 'data-jsails-nested-component';

/**
 * Keep marker: a nested wrapper whose only content is a `<template>` carrying
 * this attribute tells the client to keep the child it already holds in that
 * slot, untouched. The server emits it only for a child the client reported in
 * `have.slots` with the same component and whose `authorize` allowed.
 */
export const NESTED_KEEP_ATTRIBUTE = 'data-jsails-nested-keep';

/**
 * Prefix of a nested wrapper's element id, followed by the parent instance id
 * and a digest of the slot. The id is the same on every render of the parent,
 * so a morph pairs the old and new wrapper of a slot exactly.
 */
export const NESTED_WRAPPER_ID_PREFIX = 'jsails-slot-';

// ---------------------------------------------------------------------------
// Directive markers (server-emitted, client-consumed)
// ---------------------------------------------------------------------------

/** Confirmation-guard marker spread onto an action trigger. */
export const CONFIRM_ATTRIBUTE = 'data-jsails-confirm';

/**
 * Loading-target marker: the client sets the loading marker on the element
 * its selector names inside the same root while an update is in flight, or on
 * the marked element itself when the value is empty (`loadingTarget()`).
 */
export const LOADING_TARGET_ATTRIBUTE = 'data-jsails-loading-target';

/** Conditional-visibility marker keyed to a state field name. */
export const SHOW_ATTRIBUTE = 'data-jsails-show';

/** Text-replacement marker keyed to a state field name. */
export const TEXT_ATTRIBUTE = 'data-jsails-text';

/** Sort-trigger marker keyed to a state field name. */
export const SORT_ATTRIBUTE = 'data-jsails-sort';

/** Intersection-observer marker whose value is the action name to call. */
export const INTERSECT_ATTRIBUTE = 'data-jsails-intersect';

/** Element-reference marker keyed to an element id for client lookups. */
export const REF_ATTRIBUTE = 'data-jsails-ref';

/** Ignore marker that excludes an element from client-side DOM diffing. */
export const IGNORE_ATTRIBUTE = 'data-jsails-ignore';

/** Debounce-marker spread onto a model-bound control by `bind(name, { debounceMs })`. */
export const DEBOUNCE_ATTRIBUTE = 'data-jsails-debounce';

/**
 * Value-modifier markers spread onto a model-bound control by
 * `bind(name, { trim, number, lazy })` (`js-model.trim.number.lazy`): the
 * client trims a text value, reads a numeric text as a number, and takes the
 * value on `change` instead of on every `input`.
 */
export const TRIM_ATTRIBUTE = 'data-jsails-trim';
export const NUMBER_ATTRIBUTE = 'data-jsails-number';
export const LAZY_ATTRIBUTE = 'data-jsails-lazy';

/**
 * Event-modifier markers spread onto an action trigger by the template
 * compiler (`@click.once`). `.once` consumes the binding after one successful
 * dispatch; `.passive` serves a control's edits from a passive listener.
 * `.capture` dispatches the trigger in the capture phase, before listeners on
 * its element and form can stop it; any other trigger is dispatched when its
 * event bubbles back to the document (`client/trigger-queue.ts`).
 * They are inert on a trigger the runtime does not delegate.
 */
export const ONCE_ATTRIBUTE = 'data-jsails-once';
export const CAPTURE_ATTRIBUTE = 'data-jsails-capture';
export const PASSIVE_ATTRIBUTE = 'data-jsails-passive';

/** Loading marker the client sets on a root while an update is in flight. */
export const LOADING_ATTRIBUTE = 'data-jsails-loading';

/** Dirty marker the client sets on a root (and per-field) while local edits differ. */
export const DIRTY_ATTRIBUTE = 'data-jsails-dirty';

/** Built-in no-op action name the runtime accepts for poll/debounce re-renders. */
export const REFRESH_ACTION = '$refresh';

/** Minimum poll interval the runtime accepts, in milliseconds. */
export const MIN_POLL_INTERVAL_MS = 250;

/**
 * Maximum poll interval the runtime accepts, in milliseconds (one day). A
 * browser or Node timer longer than 2^31 - 1 ms fires after about 1 ms, so an
 * unbounded interval (jittered up by 10%) would turn into back-to-back
 * refreshes; this bound keeps every poll delay far below that.
 *
 * @public
 */
export const MAX_POLL_INTERVAL_MS = 86_400_000;

/** Maximum debounce duration the runtime accepts, in milliseconds. */
export const MAX_DEBOUNCE_MS = 60_000;

/** Maximum length of a serialized `data-jsails-poll` marker, in characters. */
export const MAX_POLL_MARKER_LENGTH = 512;

/**
 * What a poll does while the tab is hidden or the browser is offline: `pause`
 * stops ticking and refreshes once on return when a tick came due meanwhile;
 * `continue` keeps ticking.
 *
 * @public
 */
export type PollPolicy = 'pause' | 'continue';

/**
 * Author-facing poll options spread onto a root via `poll(options)`.
 * `intervalMs` is the gap between refreshes, from {@link MIN_POLL_INTERVAL_MS}
 * to {@link MAX_POLL_INTERVAL_MS} (the client spreads it by up to 10% either
 * way so many pages never tick in step); `whenHidden` and
 * `whenOffline` default to `pause`. All of it is advisory to the client, which
 * the server stays authoritative over.
 *
 * @public
 */
export interface ComponentPollOptions {
  readonly intervalMs: number;
  readonly whenHidden?: PollPolicy;
  readonly whenOffline?: PollPolicy;
}

// ---------------------------------------------------------------------------
// Validation metadata (server-derived constraints, client-consumed hints)
// ---------------------------------------------------------------------------

/**
 * Marker spread onto a model-bound control by `bind(name)` when the field's
 * schema yields client-side validation rules. The value is a bounded JSON
 * {@link FieldValidationRules} object; absence means "no client-side rules".
 */
export const RULES_ATTRIBUTE = 'data-jsails-rules';

/**
 * Marker an author places on the element that displays a bound field's error
 * message. Its value names the field; the client sets `textContent` to the
 * current validation message (and clears it when valid) but never creates the
 * element — the author owns its markup and placement.
 */
export const ERROR_FOR_ATTRIBUTE = 'data-jsails-error-for';

/** The kind of native control a bound field should render as. */
export type FieldRuleTypeHint = 'string' | 'number' | 'boolean' | 'email' | 'date';

/**
 * Client-side validation rules derived from a field's Zod schema.
 *
 * These are advisory hints for instant feedback only: the server schema stays
 * the sole authority, and a client-side mismatch is always resolved by the
 * server. `required` means the schema rejects an absent value (the field is not
 * optional/nullable/defaulted) and maps to an "empty value" check on the client;
 * the remaining fields mirror the schema's declared bounds.
 */
export interface FieldValidationRules {
  readonly required: boolean;
  readonly type?: FieldRuleTypeHint;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** JavaScript regex source (no flags) from a `z.string().regex(...)`. */
  readonly pattern?: string;
  readonly min?: number;
  readonly max?: number;
  /** Step increment from a `z.number().multipleOf(...)`. */
  readonly step?: number;
  /** Allowed values from a `z.enum([...])`. */
  readonly options?: readonly string[];
}

/** Maximum length of a serialized `data-jsails-rules` pattern, in characters. */
export const MAX_PATTERN_LENGTH = 256;

/** Maximum number of enum options a field may serialize into its rules. */
export const MAX_OPTIONS = 50;

/** Maximum length of a single enum option value, in characters. */
export const MAX_OPTION_LENGTH = 64;

/** Maximum length of a serialized `data-jsails-rules` marker, in characters. */
export const MAX_RULES_JSON_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Upload and download response shapes
// ---------------------------------------------------------------------------

/** Stable machine codes carried in a failed upload's `error` field. */
export type ComponentUploadErrorCode =
  ComponentBoundaryErrorCode | 'unsupported_content_type' | 'too_large';

/**
 * Stable machine codes carried in a failed download's `error` field.
 *
 * @public
 */
export type ComponentDownloadErrorCode = ComponentBoundaryErrorCode | 'not_found';

/** A top-level upload failure descriptor. Value-free; never echoes raw input. */
export interface ComponentUploadError {
  readonly code: ComponentUploadErrorCode;
  readonly message: string;
}

/**
 * The response to an upload. On success `reference` carries the signed token to
 * store in component state (wrapped as `{ __upload: reference }`); on failure
 * `error` carries a stable code and a value-free message.
 */
export interface ComponentUploadResponse {
  readonly reference?: string;
  readonly error?: ComponentUploadError;
}
