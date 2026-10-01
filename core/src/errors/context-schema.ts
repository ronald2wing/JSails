/**
 * The value kinds a registered error's context may hold, and their validation.
 *
 * The set is closed so that no context slot can carry free text: an
 * identifier, a count, a project-relative path, or one member of a declared
 * enum. Free text is where secrets and raw input leak into logs and responses;
 * a slot that needs it is a sign the information belongs in the payload or
 * nowhere.
 *
 * Browser-safe: no runtime imports.
 */

/**
 * One context slot's value kind:
 *
 * - `identifier`: a name the code chose or a registry keyed (a token, a model,
 *   a package name): 1 to 128 of `A-Z a-z 0-9 _ . : @ / -`, starting with a
 *   letter, a digit, `_` or `@`.
 * - `count`: a non-negative safe integer.
 * - `relative-path`: a path relative to the project root: no leading `/`, `\`
 *   or drive letter, no `..` segment, no control character, at most 1024
 *   characters.
 * - a non-empty list of strings: one of those members.
 *
 * @public
 */
export type ContextKind = 'identifier' | 'count' | 'relative-path' | readonly string[];

/**
 * A code's declared context: slot name to value kind.
 *
 * @public
 */
export type ContextSchema = Readonly<Record<string, ContextKind>>;

/**
 * The TypeScript type of one context value kind.
 *
 * @public
 */
export type ContextValueOf<K> = K extends 'count'
  ? number
  : K extends readonly (infer M extends string)[]
    ? M
    : string;

/**
 * The context object a schema describes.
 *
 * @public
 */
export type ContextOf<S> = S extends ContextSchema
  ? { readonly [P in keyof S]: ContextValueOf<S[P]> }
  : Readonly<Record<string, never>>;

const IDENTIFIER = /^[A-Za-z0-9_@][A-Za-z0-9_.:@/-]{0,127}$/;
const DRIVE = /^[A-Za-z]:/;
const MAX_PATH = 1024;

/**
 * True when `kind` is a well-formed {@link ContextKind}.
 *
 * @public
 */
export function isContextKind(kind: unknown): kind is ContextKind {
  if (kind === 'identifier' || kind === 'count' || kind === 'relative-path') return true;
  return (
    Array.isArray(kind) &&
    kind.length > 0 &&
    kind.every((member) => typeof member === 'string' && member.length > 0)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f)) return true;
  }
  return false;
}

function isRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PATH) return false;
  if (hasControlCharacter(value)) return false;
  if (value.startsWith('/') || value.startsWith('\\') || DRIVE.test(value)) return false;
  return !value.split(/[\\/]/).includes('..');
}

/**
 * True when `value` satisfies `kind`.
 *
 * @public
 */
export function isContextValue(kind: ContextKind, value: unknown): boolean {
  if (kind === 'count') {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }
  if (typeof value !== 'string') return false;
  if (kind === 'identifier') return IDENTIFIER.test(value);
  if (kind === 'relative-path') return isRelativePath(value);
  return kind.includes(value);
}

/** True when `value` is a valid `identifier` context value. */
export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}
