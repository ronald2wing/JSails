/**
 * The error kernel's lint (KRN-07): in a converted unit, every failure is
 * declared in an error registry (`defineErrors` from `jsails/errors`), so
 * every error carries a kind, an audience and a code, and its message is
 * rendered from validated context only.
 *
 * - `jsails/no-raw-error`: no `new Error(…)`, `new TypeError(…)`,
 *   `new RangeError(…)` or their call forms, `reject(new Error())` included.
 * - `jsails/no-raw-error-class`: no class extending `Error`, `TypeError` or
 *   `RangeError`.
 * - `jsails/no-hand-written-error-class`: no class extending `JsailsError`.
 *
 * The two class bans skip the error kernel (`core/src/errors`), where the base
 * class and the registry classes live.
 *
 * A unit is a top-level entry of `core/src` or one package's `src`. The units
 * not yet converted are the `adoption:<unit>` entries of
 * `scripts/expected-failures/error-registry.json`, read here, so the lint is on
 * in every other unit, a new unit starts converted, and removing a ledger
 * entry (which the `error-registry` gate demands once the unit is clean)
 * switches the lint on for it. Tests are not covered: a test builds foreign
 * errors on purpose.
 */
import { readFileSync } from 'node:fs';

const ledger = JSON.parse(
  readFileSync(
    new URL('../scripts/expected-failures/error-registry.json', import.meta.url),
    'utf8',
  ),
);

const PREFIX = 'adoption:';

/** The ignore globs of the units the ledger lists. */
const UNCONVERTED = ledger.entries
  .map((entry) => entry.id)
  .filter((id) => id.startsWith(PREFIX))
  .map((id) => id.slice(PREFIX.length))
  .map((unit) => (/\.tsx?$/.test(unit) ? unit : `${unit}/**`));

const SOURCES = ['core/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'];
/** The error kernel: the base class and the registry classes live here. */
const KERNEL = 'core/src/errors/**';
const RAW = '/^(Error|TypeError|RangeError)$/';

export const restrictedSyntax = [
  {
    name: 'no-raw-error',
    files: SOURCES,
    ignores: UNCONVERTED,
    selector: `:matches(NewExpression, CallExpression)[callee.type='Identifier'][callee.name=${RAW}]`,
    message:
      'Declare this failure in an error registry (defineErrors from jsails/errors) and throw its code; use invariant() for an argument check.',
  },
  {
    name: 'no-raw-error-class',
    files: SOURCES,
    ignores: [...UNCONVERTED, KERNEL],
    selector: `:matches(ClassDeclaration, ClassExpression)[superClass.type='Identifier'][superClass.name=${RAW}]`,
    message: 'Declare the codes with defineErrors (jsails/errors) instead of an Error subclass.',
  },
  {
    name: 'no-hand-written-error-class',
    files: SOURCES,
    ignores: [...UNCONVERTED, KERNEL],
    selector:
      ":matches(ClassDeclaration, ClassExpression)[superClass.type='Identifier'][superClass.name='JsailsError']",
    message:
      'Declare the codes with defineErrors (jsails/errors) instead of a hand-written JsailsError subclass.',
  },
];

export default [];
