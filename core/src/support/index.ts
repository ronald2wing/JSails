/**
 * Browser-safe core barrel for jsails/support.
 *
 * Explicit named exports only (no `export *`): the framework-symbol catalog
 * scanner enumerates a barrel's value exports by name, and a wildcard would
 * make the browser-safety import-graph walk opaque. See the design doc §4.1.
 *
 * This barrel must stay free of `node:*` and server-only packages. The
 * server addendum lives in `jsails/support/server` and is reached only through
 * a dynamic import from a server-only call path, never statically from here.
 *
 * The surface is the eight namespace objects plus their domain error
 * registries, and `detach` (with its `escalate` reporter), the one sanctioned
 * way to leave a promise un-awaited.
 * Individual helper functions stay reachable through their namespace
 * (`Str.slug`, `Num.bytes`) rather than as bare barrel exports: several names
 * (`add`, `compact`, `format`, `limit`, `parse`, `subtract`) exist in two
 * namespaces, and a barrel cannot re-export two same-named symbols. Each
 * concept module still exports its functions individually for tree-shaking.
 */

export { StrErrors, Str, CONTROL_CHARS } from './strings.js';
export { NumErrors, Num, type FormatMoneyOptions } from './numbers.js';
export { TimeErrors, Time, type TimeUnit, type DateInput } from './time.js';
export { ArrErrors, Arr, compareStrings } from './collections.js';
export {
  AsyncErrors,
  Async,
  type DebounceOptions,
  type ThrottleOptions,
  type RetryOptions,
  type MapConcurrentOptions,
} from './async.js';
export { detach, escalate } from './detach.js';
export { EncodingErrors, Encoding, type DataUrlParts } from './encoding.js';
export { UrlErrors, Url, type QsOptions } from './urls.js';
export { CryptographyErrors, Cryptography, type HashAlgorithm } from './cryptography.js';
