/**
 * Named-slot style contract for the authoring layer.
 *
 * Tailwind class strings are the tokens; the contract owns the slot names so
 * `render` can dereference `style.slot('header')` instead of threading a raw
 * class list through component props.  A raw Tailwind class string where a slot
 * is required is rejected at the type level: slot returns a single class string,
 * not an open string union.
 *
 * This module validates only the slot map and slot lookups; nothing statically
 * rejects a bare class string written where a slot reference was intended.
 */

import { JsailsError } from '../../errors/jsails-error.js';

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Raised when a style definition fails structural validation. Messages are value-free. */
export class StyleError extends JsailsError {
  constructor(
    readonly code: StyleErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Stable machine codes carried on a {@link StyleError}. */
export type StyleErrorCode = 'invalid_slots' | 'unknown_slot';

// ---------------------------------------------------------------------------
// Style contract
// ---------------------------------------------------------------------------

/**
 * A named-slot style contract. Each slot maps to a Tailwind class string the
 * component's `render` consumes via `style.slot(name)`.
 */
export interface StyleContract<Slots extends string = string> {
  readonly slots: Readonly<Record<Slots, string>>;
  slot(name: Slots): string;
}

// ---------------------------------------------------------------------------
// defineStyle
// ---------------------------------------------------------------------------

/**
 * Define a named-slot style contract from a flat map of slot name to Tailwind
 * class string.  Every value must be a non-empty string; every key must be a
 * non-empty string that is not an inherited object property (e.g. `__proto__`).
 *
 * Returns a frozen contract; `slot('x')` returns the registered class string.
 * An unknown slot throws a value-free {@link StyleError} (`unknown_slot`).
 */
export function defineStyle<const S extends Record<string, string>>(
  slots: S,
): StyleContract<keyof S & string> {
  if (slots === null || typeof slots !== 'object') {
    throw new StyleError('invalid_slots', 'slots must be a plain object');
  }

  const prototype = Object.getPrototypeOf(slots);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StyleError('invalid_slots', 'slots must be a plain object');
  }

  const entries = Object.entries(slots);

  // Reject empty maps (a style with zero slots is an author mistake, not a
  // valid definition).
  if (entries.length === 0) {
    throw new StyleError('invalid_slots', 'slots must have at least one entry');
  }

  const frozenSlots: Record<string, string> = {};

  for (const [key, value] of entries) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new StyleError('invalid_slots', 'slot name must be a non-empty string');
    }
    if (key in Object.prototype) {
      throw new StyleError(
        'invalid_slots',
        'slot name must not shadow an inherited object property',
      );
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new StyleError('invalid_slots', 'slot value must be a non-empty string');
    }
    frozenSlots[key] = value;
  }

  const frozen = Object.freeze(frozenSlots);

  return Object.freeze({
    slots: frozen,
    slot(name: keyof S & string): string {
      const value = (frozen as Record<string, string>)[name];
      if (value === undefined) {
        throw new StyleError('unknown_slot', 'unknown slot');
      }
      return value;
    },
  });
}
