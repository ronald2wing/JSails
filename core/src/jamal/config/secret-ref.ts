/**
 * Secret references for the jamal config: a branded `SecretRef` that names a
 * secret without holding its value, plus the `secret()` constructor and the
 * name validation both share.
 */

import { CONTROL_CHARS } from '../../support/strings.js';

import { JamalConfigError } from '../error.js';

/**
 * A branded reference to a secret by name. It never holds, resolves, or
 * serializes a secret value: `toString`/`toJSON` render the redacted
 * `secret(<name>)` form, so a `SecretRef` can be stringified for plans and
 * logs without leaking anything beyond its name. Class identity (`instanceof`)
 * is the brand — a plain `{ name: 'X' }` object is never a `SecretRef`.
 *
 * Resolving the value is `resolveJamalEnv`'s job (`jamal/env-resolve.ts`); the
 * config layer treats the reference as opaque.
 */
export class SecretRef {
  /** The secret's name, e.g. `DB_PASSWORD`. */
  readonly name: string;

  constructor(name: string) {
    assertSecretName(name);
    this.name = name;
  }

  /** Redacted form; never a resolved value. */
  toString(): string {
    return `secret(${this.name})`;
  }

  /** Keep `JSON.stringify` value-free: render the redacted form, not the name object. */
  toJSON(): string {
    return this.toString();
  }
}

/** A name is an identifier: non-empty, no whitespace or control characters. */
function assertSecretName(name: string): void {
  if (name.length === 0 || /\s/.test(name) || CONTROL_CHARS.test(name)) {
    throw new JamalConfigError(
      'secret names must be non-empty and contain no whitespace or control characters',
    );
  }
}

/** Build a {@link SecretRef} for the given secret name. */
export function secret(name: string): SecretRef {
  return new SecretRef(name);
}
