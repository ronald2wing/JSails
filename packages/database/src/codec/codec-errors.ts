/**
 * The codec layer's error codes, `codec.*`: a column whose codec cannot be
 * built, and a result row the hydrator cannot map. A value a codec refuses is
 * a `ColumnValueError` from the model layer instead, so every value failure,
 * whichever layer raised it, is caught one way. Messages are fixed text; the
 * context holds only model, property and column names, and a caller's key
 * reaches it only through {@link reportedName}.
 */

import { defineErrors, isContextValue, type ErrorRegistry } from 'jsails/errors';

const CODEC_ERRORS = {
  missing_seal: {
    kind: 'unavailable',
    message: 'column {model}.{field} is encrypted and no seal provider is configured',
    context: { model: 'identifier', field: 'identifier' },
    suggestion:
      'configure the encryption keyring; an encrypted column is never read or written as plaintext',
  },
  invalid_chain: {
    kind: 'internal',
    message: 'a column codec chain needs at least one layer',
  },
  incomplete_row: {
    kind: 'internal',
    message: 'a result row of {model} has no column {column}',
    context: { model: 'identifier', column: 'identifier' },
    suggestion: 'select every column of the model to hydrate a record; project plain rows instead',
  },
  unknown_property: {
    kind: 'internal',
    message: 'model {model} has no column property {field}',
    context: { model: 'identifier', field: 'identifier' },
  },
  not_a_model: {
    kind: 'internal',
    message: 'the target is not a model or table defined with defineModel or defineTable',
  },
} as const;

/**
 * The codec layer's codes: an encrypted column with no seal provider, an
 * empty codec chain, a row that lacks a model column, a projection of a
 * property the model does not have, and a target that is not a model.
 */
export const CodecErrors: ErrorRegistry<'codec', typeof CODEC_ERRORS> = defineErrors(
  'codec',
  CODEC_ERRORS,
);

/** What {@link reportedName} reports for a key that is no identifier. */
export const UNREPORTABLE_NAME = '@not-an-identifier';

/**
 * The name an error's `identifier` context slot carries for `name`, a key of
 * a caller's object (a filter or a projection, possibly built from a
 * request): `name` itself when it is an identifier, else
 * {@link UNREPORTABLE_NAME}. A key with a space, a quote or past 128
 * characters would fail the slot's check and turn the error into the kernel's
 * `errors.invalid_context`; reported this way the error keeps its own code
 * and never echoes such a key.
 */
export function reportedName(name: string): string {
  return isContextValue('identifier', name) ? name : UNREPORTABLE_NAME;
}
