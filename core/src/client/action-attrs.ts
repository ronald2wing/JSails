/**
 * Browser-safe action attribute builders shared by the server-component
 * directive helpers and the client island runtime.
 *
 * The server renders these markers (`intersectAttrs`, `pagerAttrs`, and the
 * directive builders) and a client island consumes them (`useIslandTools`).
 * Keeping the builders here — rather than in `server-components/` — lets
 * `jsails/client` re-export them without pulling the server-component runtime
 * into a browser bundle. `server-components/directives.ts` and `pagination.ts`
 * re-export the same bindings, so their public surface is unchanged.
 *
 * Every builder validates its argument and throws a value-free
 * {@link ServerComponentRuntimeError} on invalid input, matching the server
 * helpers' existing contract. That error class is runtime-browser-safe: its
 * only eager import is the dependency-free `internal/json-safe.js` (the Zod
 * import in `value-errors.ts` is type-only).
 */

import type { Page, PaginationOptions } from '../api/pagination.js';
import type { JsonObject, JsonValue } from '../contracts/http.js';
import type {
  ServerComponentBindOptions,
  ServerComponentCallAttrs,
  ServerComponentModelAttrs,
  ServerComponentPollAttrs,
  ServerComponentPollOptions,
  ServerComponentSubmitAttrs,
} from '../server-components/component.js';
import {
  ARGS_ATTRIBUTE,
  CALL_ATTRIBUTE,
  CONFIRM_ATTRIBUTE,
  DEBOUNCE_ATTRIBUTE,
  IGNORE_ATTRIBUTE,
  INTERSECT_ATTRIBUTE,
  LOADING_TARGET_ATTRIBUTE,
  MAX_DEBOUNCE_MS,
  MIN_POLL_INTERVAL_MS,
  MODEL_ATTRIBUTE,
  POLL_ATTRIBUTE,
  REF_ATTRIBUTE,
  SHOW_ATTRIBUTE,
  SORT_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
  TEXT_ATTRIBUTE,
} from '../server-components/protocol.js';
import { ServerComponentRuntimeError } from '../server-components/runtime/value-errors.js';

export { INTERSECT_ATTRIBUTE };
export type { PaginationOptions };
export type {
  ServerComponentBindOptions,
  ServerComponentCallAttrs,
  ServerComponentModelAttrs,
  ServerComponentPollAttrs,
  ServerComponentPollOptions,
  ServerComponentSubmitAttrs,
};

/**
 * Upper bound for the page size emitted in call args. Mirrors
 * `DEFAULT_MAX_PAGE_SIZE` in `api/pagination.ts`; duplicated rather than
 * imported because that module eagerly imports Zod through `validation.js`.
 */
const DEFAULT_MAX_PAGE_SIZE = 100;

/** Validate that a string argument is a non-empty trimmed string. */
function validateNonEmpty(arg: unknown, label: string): asserts arg is string {
  if (typeof arg !== 'string' || arg.trim() === '') {
    throw new ServerComponentRuntimeError(`invalid ${label} argument`);
  }
}

/**
 * Parse an element's explicit `data-jsails-args` JSON. Absent or empty yields
 * an empty object; malformed JSON or a non-object yields `null` so the caller
 * can reject the action without dispatching.
 */
export function parseActionArgs(raw: string | null): JsonObject | null {
  if (raw === null || raw === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  return parsed as JsonObject;
}

/**
 * Build an intersection-observer attribute map. The client calls the named
 * `action` when the element enters the viewport.
 */
export function intersectAttrs(action: string): Record<string, string> {
  if (typeof action !== 'string' || action.trim() === '') {
    throw new ServerComponentRuntimeError('invalid intersect action argument');
  }
  return { [INTERSECT_ATTRIBUTE]: action };
}

/**
 * Build a confirmation-guard attribute map. The client will show a
 * `window.confirm` dialog keyed to this message before dispatching an action.
 */
export function confirmAttrs(message: string): Record<string, string> {
  validateNonEmpty(message, 'confirm message');
  return { [CONFIRM_ATTRIBUTE]: message };
}

/**
 * Build a loading-target attribute map. The client will toggle a loading
 * indicator on the element referenced by `target` while an update is in
 * flight.
 */
export function loadingTargetAttrs(target: string): Record<string, string> {
  validateNonEmpty(target, 'loading target');
  return { [LOADING_TARGET_ATTRIBUTE]: target };
}

/**
 * Build a conditional-visibility attribute map. The client will show or hide
 * the element based on the truthiness of the named state `field`.
 */
export function showAttrs(field: string): Record<string, string> {
  validateNonEmpty(field, 'show field');
  return { [SHOW_ATTRIBUTE]: field };
}

/**
 * Build a text-replacement attribute map. The client will set the element's
 * `textContent` to the value of the named state `field`.
 */
export function textAttrs(field: string): Record<string, string> {
  validateNonEmpty(field, 'text field');
  return { [TEXT_ATTRIBUTE]: field };
}

/**
 * Build a sort-trigger attribute map. The client will dispatch a named
 * action when the element is clicked, toggling sort state.
 */
export function sortAttrs(field: string): Record<string, string> {
  validateNonEmpty(field, 'sort field');
  return { [SORT_ATTRIBUTE]: field };
}

/**
 * Build a reference-key attribute map. `name` identifies the element so the
 * client can look it up by id. The value must be a non-empty string without
 * whitespace, quotes, or control characters — it names an element id.
 */
export function refAttrs(name: string): Record<string, string> {
  if (typeof name !== 'string' || name.trim() === '' || /[\s"<>]/.test(name)) {
    throw new ServerComponentRuntimeError('invalid ref name');
  }
  return { [REF_ATTRIBUTE]: name };
}

/**
 * Build an ignore attribute map. An element carrying this marker is excluded
 * from the client's DOM-diffing pass — the client skips it during morph.
 */
export function ignoreAttrs(): Record<string, string> {
  return { [IGNORE_ATTRIBUTE]: '' };
}

/**
 * Build a model-binding attribute map. `name` names the top-level state field
 * the element binds to. An optional `debounceMs` adds a client-side debounce
 * window; it must be a safe integer between 1 and {@link MAX_DEBOUNCE_MS}.
 */
export function bindAttrs(
  name: string,
  options?: ServerComponentBindOptions,
): ServerComponentModelAttrs {
  validateNonEmpty(name, 'model name');
  const attrs: Record<string, string> = { [MODEL_ATTRIBUTE]: name };
  if (options?.debounceMs !== undefined) {
    const debounceMs = options.debounceMs;
    if (!Number.isSafeInteger(debounceMs) || debounceMs < 1 || debounceMs > MAX_DEBOUNCE_MS) {
      throw new ServerComponentRuntimeError('invalid debounce duration');
    }
    attrs[DEBOUNCE_ATTRIBUTE] = String(debounceMs);
  }
  return attrs as unknown as ServerComponentModelAttrs;
}

/**
 * Build an action-call attribute map. The client dispatches `action` when the
 * element is activated. Optional `args` are serialized as JSON into the args
 * attribute; omit them when the action takes no arguments.
 */
export function callAttrs(action: string, args?: JsonValue): ServerComponentCallAttrs {
  validateNonEmpty(action, 'call action');
  const attrs: Record<string, string> = { [CALL_ATTRIBUTE]: action };
  if (args !== undefined) {
    const serialized = JSON.stringify(args);
    if (serialized !== undefined) {
      attrs[ARGS_ATTRIBUTE] = serialized;
    }
  }
  return attrs as unknown as ServerComponentCallAttrs;
}

/**
 * Build a form-submit attribute map. The client submits `action` when the form
 * is submitted. Optional `args` are serialized as JSON into the args attribute.
 * The server tool adds `data-turbo="false"`; this builder only emits the action
 * marker so it stays usable from a client island.
 */
export function submitAttrs(
  action: string,
  args?: JsonValue,
): Omit<ServerComponentSubmitAttrs, 'data-turbo'> {
  validateNonEmpty(action, 'submit action');
  const attrs: Record<string, string> = { [SUBMIT_ATTRIBUTE]: action };
  if (args !== undefined) {
    const serialized = JSON.stringify(args);
    if (serialized !== undefined) {
      attrs[ARGS_ATTRIBUTE] = serialized;
    }
  }
  return attrs as unknown as Omit<ServerComponentSubmitAttrs, 'data-turbo'>;
}

/**
 * Build a poll attribute map. The client polls the component at `intervalMs`
 * (a safe integer at least {@link MIN_POLL_INTERVAL_MS}) and may pause while
 * the tab is hidden or the network is offline.
 */
export function pollAttrs(options: ServerComponentPollOptions): ServerComponentPollAttrs {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < MIN_POLL_INTERVAL_MS) {
    throw new ServerComponentRuntimeError('invalid poll interval');
  }
  const serialized = JSON.stringify({
    intervalMs: options.intervalMs,
    ...(options.pauseWhenHidden === undefined ? {} : { pauseWhenHidden: options.pauseWhenHidden }),
    ...(options.pauseWhenOffline === undefined
      ? {}
      : { pauseWhenOffline: options.pauseWhenOffline }),
  });
  return { [POLL_ATTRIBUTE]: serialized };
}

/**
 * Options for {@link pagerAttrs}.
 *
 * Every field is optional and defaults to a conventional name so a component
 * using `page`/`pageSize` state fields and a `page` action needs no options.
 */
export interface ServerComponentPagerOptions {
  /** Action name the pager calls. Defaults to `'page'`. */
  action?: string;
  /** State field name for the page number. Defaults to `'page'`. */
  pageField?: string;
  /** State field name for the page size. Defaults to `'pageSize'`. */
  pageSizeField?: string;
  /** Upper bound for the page size emitted in call args. Defaults to 100. */
  maxPageSize?: number;
}

/**
 * Build prev/next {@link ServerComponentCallAttrs} from a {@link Page}.
 *
 * Each direction returns `null` when the page has no link in that direction
 * (`page.previous` or `page.next` is `null`), so the component can skip that
 * button entirely. Otherwise the returned map calls the configured action with
 * `{ <pageField>: <target page>, <pageSizeField>: <clamped pageSize> }`.
 *
 * The emitted `pageSize` is clamped to `maxPageSize` as a defensive bound,
 * even though the component author owns the real bound on the state field.
 */
export function pagerAttrs(
  page: Page<unknown>,
  options: ServerComponentPagerOptions = {},
): { previous: ServerComponentCallAttrs | null; next: ServerComponentCallAttrs | null } {
  const action = options.action ?? 'page';
  const pageField = options.pageField ?? 'page';
  const pageSizeField = options.pageSizeField ?? 'pageSize';
  const maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;

  validatePagerOptions(action, pageField, pageSizeField, maxPageSize);

  const clampedPageSize = Math.min(page.pageSize, maxPageSize);

  const build = (targetPage: number | null): ServerComponentCallAttrs | null => {
    if (targetPage === null) {
      return null;
    }
    return callAttrs(action, {
      [pageField]: targetPage,
      [pageSizeField]: clampedPageSize,
    });
  };

  return { previous: build(page.previous), next: build(page.next) };
}

function validatePagerOptions(
  action: string,
  pageField: string,
  pageSizeField: string,
  maxPageSize: number,
): void {
  if (typeof action !== 'string' || action.trim() === '') {
    throw new ServerComponentRuntimeError('pager action must be a non-empty string');
  }
  if (typeof pageField !== 'string' || pageField.trim() === '') {
    throw new ServerComponentRuntimeError('pager page field must be a non-empty string');
  }
  if (typeof pageSizeField !== 'string' || pageSizeField.trim() === '') {
    throw new ServerComponentRuntimeError('pager page size field must be a non-empty string');
  }
  if (!Number.isInteger(maxPageSize) || maxPageSize < 1) {
    throw new ServerComponentRuntimeError('pager max page size must be a positive integer');
  }
}
