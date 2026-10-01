/**
 * Labelled form field wrapper.
 *
 * Accessibility linkage is explicit and id-based: `label` gets `for={id}`, and
 * help/error paragraphs get derived ids (`${id}-help`, `${id}-error`). The
 * caller passes the same id to the control and references those ids from its
 * `aria-describedby`. Without an id, the label renders without `for`; wrap the
 * control in the label instead.
 */

import type { ComponentChildren, HTMLAttributes } from 'preact';

import { cx } from './class-names.js';

/** Props accepted by {@link UiField}. */
export interface UiFieldProps extends HTMLAttributes<HTMLDivElement> {
  /** Explicit id of the control this field labels. */
  id?: string;
  /** Visible label text. */
  label: ComponentChildren;
  /** Optional helper text, linked via `aria-describedby`. */
  help?: ComponentChildren;
  /** Optional error text; adds invalid styling and a `role="alert"` message. */
  error?: ComponentChildren;
  /** The control to render. */
  children: ComponentChildren;
}

/** A labelled form control with optional help and error text. */
export function UiField({
  id,
  label,
  help,
  error,
  children,
  class: className,
  ...rest
}: UiFieldProps) {
  const helpId = id ? `${id}-help` : undefined;
  const errorId = id ? `${id}-error` : undefined;

  return (
    <div {...rest} class={cx('fieldset gap-1.5', className)}>
      <label class="label" for={id}>
        {label}
      </label>
      {children}
      {help ? (
        <p class="label text-xs text-base-content/55" id={helpId}>
          {help}
        </p>
      ) : null}
      {error ? (
        <p class="label text-xs text-error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
