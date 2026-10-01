/**
 * The value-free error raised by the Inertia adapter.
 *
 * Every failure carries one code from {@link INERTIA_ERROR_MESSAGES}; the
 * message is the code's static text and never echoes a prop value, a header,
 * or other input. A prop path, when the failure has one, goes in `context.path`
 * so an operator can find the offending prop without the value reaching a log.
 * The codes live in one table so a move to a registry-based error kernel is a
 * mechanical conversion with no code renamed.
 */

import { JsailsError } from 'jsails/plugin-sdk';

const inertiaErrorMessages = {
  invalid_options: 'Inertia options are invalid',
  invalid_component:
    'an Inertia component name must be a non-empty string without control characters',
  invalid_prop_key: 'an Inertia prop key is reserved or cannot appear on a prop path',
  unserializable_prop: 'an Inertia prop holds a value that is not plain JSON data',
  invalid_props: 'an Inertia prop resolved to a value of the wrong shape',
  invalid_redirect: 'an Inertia redirect target is not a same-origin path',
  carrier_too_large: 'the Inertia flash and errors carrier exceeds its size limit',
  ssr_failed: 'Inertia server-side rendering failed',
  ssr_timeout: 'Inertia server-side rendering timed out',
  not_a_page: 'the response does not carry an Inertia page object',
} as const;
/** Static message for each Inertia error code. */
export const INERTIA_ERROR_MESSAGES: typeof inertiaErrorMessages = Object.freeze(
  inertiaErrorMessages satisfies Readonly<Record<string, string>>,
);

/** A stable, machine-readable Inertia failure code. */
export type InertiaErrorCode = keyof typeof INERTIA_ERROR_MESSAGES;

/** Options for an {@link InertiaError}. */
export interface InertiaErrorOptions {
  /** The dot path of the prop at fault, when there is one. */
  readonly path?: string;
  /** The underlying failure, when this error wraps one. */
  readonly cause?: unknown;
}

/** A value-free Inertia failure with a stable {@link InertiaErrorCode}. */
export class InertiaError extends JsailsError {
  readonly code: InertiaErrorCode;

  constructor(code: InertiaErrorCode, options: InertiaErrorOptions = {}) {
    super(INERTIA_ERROR_MESSAGES[code], {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
      ...(options.path === undefined ? {} : { context: { path: options.path } }),
    });
    this.code = code;
  }
}
