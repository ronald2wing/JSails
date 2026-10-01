/**
 * Error registries: `defineErrors(domain, codes)` declares a domain's codes once
 * and returns the error class that raises them and the predicate that
 * recognizes them.
 *
 * Each code declares its kind, its audience (default `operator`), a message
 * template whose `{slot}` placeholders name its context slots, the value kind
 * of each slot, an optional static suggestion, and an optional typed payload.
 * Construction validates the context against the declared kinds and renders
 * the message from it, so a message can only ever contain identifiers, counts,
 * relative paths and enum members.
 *
 * An error's code is `domain.code`; identity is the brand plus that string
 * (`registry.is(error, code)`), never `instanceof`.
 *
 * Every defined domain is recorded in a process-wide table shared by every
 * copy of `jsails` in the process (keyed by `Symbol.for`), which the
 * `error-registry` gate reads to hold codes unique and snake_case and to
 * generate the error reference. Defining a domain again with the same codes
 * replaces it (a module re-evaluated by a dev server); defining it with
 * different codes records a conflict the gate reports, and the later
 * definition wins.
 *
 * A registry exported from a module that compiles under
 * `isolatedDeclarations` states its type:
 *
 * ```ts
 * const QUEUE_ERRORS = {
 *   unknown_queue: { kind: 'internal', message: 'queue {queue} is not declared', context: { queue: 'identifier' } },
 * } as const;
 * export const QueueErrors: ErrorRegistry<'queue', typeof QUEUE_ERRORS> = defineErrors('queue', QUEUE_ERRORS);
 * ```
 *
 * Browser-safe: no runtime imports beyond the error kernel's own leaves.
 */

import {
  isContextKind,
  isContextValue,
  type ContextKind,
  type ContextOf,
  type ContextSchema,
} from './context-schema.js';
import { isJsailsError, JsailsError, type JsailsErrorContextValue } from './jsails-error.js';
import { isErrorKind, type ErrorAudience, type ErrorKind } from './kinds.js';

declare const PAYLOAD_TYPE: unique symbol;

/**
 * Declares a code's payload type `P`. `expose` names the members a
 * client-audience error puts on the wire as problem extension members; every
 * other member stays in the process. The declaration is a type assertion on a
 * plain object, so a definitions literal stays inferable:
 * `payload: { expose: ['issues'] } as Payload<{ issues: readonly ErrorIssue[] }>`.
 *
 * @public
 */
export interface Payload<P extends object> extends PayloadDeclaration {
  readonly expose?: readonly (keyof P & string)[];
  readonly [PAYLOAD_TYPE]?: P;
}

/**
 * The runtime shape of a payload declaration, whatever its type.
 *
 * @public
 */
export interface PayloadDeclaration {
  readonly expose?: readonly string[];
}

/**
 * One code's declaration.
 *
 * @public
 */
export interface ErrorCodeDefinition {
  /** What went wrong, as a boundary treats it. */
  readonly kind: ErrorKind;
  /** Who may read the error. Defaults to `operator`. */
  readonly audience?: ErrorAudience;
  /** The message, with a `{slot}` placeholder per context slot it shows. */
  readonly message: string;
  /** The context slots and the value kind of each. */
  readonly context?: ContextSchema;
  /** The one-line fix to try next. Static text. */
  readonly suggestion?: string;
  /** The payload's type and its client-exposed members. */
  readonly payload?: PayloadDeclaration;
}

/**
 * A domain's declarations: code to definition.
 *
 * @public
 */
export type ErrorCodeDefinitions = Readonly<Record<string, ErrorCodeDefinition>>;

/**
 * The `{slot}` names a message template uses.
 *
 * @public
 */
export type MessageSlots<M extends string> = M extends `${string}{${infer S}}${infer Rest}`
  ? S | MessageSlots<Rest>
  : never;

type SchemaOf<Def> = Def extends { readonly context: infer S extends ContextSchema }
  ? S
  : Readonly<Record<never, ContextKind>>;

/**
 * The payload type a definition declares, or `undefined`.
 *
 * @public
 */
export type PayloadOf<Def> = Def extends { readonly payload: Payload<infer P> } ? P : undefined;

type MissingSlots<Def> = Def extends { readonly message: infer M extends string }
  ? Exclude<MessageSlots<M>, keyof SchemaOf<Def>>
  : never;

/**
 * Definitions whose every message slot names a declared context slot.
 *
 * @public
 */
export type CheckedDefinitions<D> = {
  readonly [C in keyof D]: [MissingSlots<D[C]>] extends [never]
    ? D[C]
    : { readonly message: `message slot {${MissingSlots<D[C]> & string}} has no context entry` };
};

/**
 * Options a registry error accepts besides its context.
 *
 * @public
 */
export type RegistryErrorOptions<Def> =
  PayloadOf<Def> extends undefined
    ? { readonly cause?: unknown }
    : { readonly cause?: unknown; readonly payload: PayloadOf<Def> };

type ContextArgument<Def> = keyof SchemaOf<Def> extends never
  ? [context?: Readonly<Record<string, never>>]
  : [context: ContextOf<SchemaOf<Def>>];

/**
 * The constructor arguments after the code, for one definition.
 *
 * @public
 */
export type RegistryErrorArguments<Def> =
  PayloadOf<Def> extends undefined
    ? [...ContextArgument<Def>, options?: RegistryErrorOptions<Def>]
    : [context: ContextOf<SchemaOf<Def>>, options: RegistryErrorOptions<Def>];

/**
 * An error raised through a registry, narrowed to one code.
 *
 * @public
 */
export type RegistryError<
  Domain extends string,
  D extends ErrorCodeDefinitions,
  C extends keyof D & string,
> = JsailsError & {
  readonly code: `${Domain}.${C}`;
  readonly domain: Domain;
  readonly context: ContextOf<SchemaOf<D[C]>>;
  readonly payload: PayloadOf<D[C]>;
};

/**
 * The error class a registry returns.
 *
 * @public
 */
export interface RegistryErrorClass<Domain extends string, D extends ErrorCodeDefinitions> {
  new <C extends keyof D & string>(
    code: C,
    ...args: RegistryErrorArguments<D[C]>
  ): RegistryError<Domain, D, C>;
  readonly prototype: JsailsError;
}

/**
 * What {@link defineErrors} returns.
 *
 * @public
 */
export interface ErrorRegistry<Domain extends string, D extends ErrorCodeDefinitions> {
  /** The domain every code of this registry is prefixed with. */
  readonly domain: Domain;
  /** The declarations, frozen. */
  readonly codes: D;
  /** The error class: `new Registry.Error(code, context, options)`. */
  readonly Error: RegistryErrorClass<Domain, D>;
  /** True when `error` is one of this registry's codes (or exactly `code`). */
  is(error: unknown): error is RegistryError<Domain, D, keyof D & string>;
  is<C extends keyof D & string>(error: unknown, code: C): error is RegistryError<Domain, D, C>;
}

/**
 * One registered code, as the error reference and the registry gate read it.
 *
 * @public
 */
export interface RegisteredErrorCode {
  /** `domain.code`. */
  readonly code: string;
  readonly kind: ErrorKind;
  readonly audience: ErrorAudience;
  readonly message: string;
  readonly context: ContextSchema;
  readonly suggestion: string | undefined;
  /** The payload members a client-audience error exposes. */
  readonly exposes: readonly string[];
}

const NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const SLOT = /\{([^{}]*)\}/g;
const SLOT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Members a problem document owns; a payload may not expose them. */
const RESERVED_MEMBERS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'code',
  'traceId',
]);

interface DomainRecord {
  readonly fingerprint: string;
  readonly codes: ErrorCodeDefinitions;
}

interface RegistryTable {
  readonly domains: Map<string, DomainRecord>;
  readonly conflicts: Set<string>;
}

const TABLE_KEY = Symbol.for('jsails.errors.registry');

/**
 * The mark a registry's error class puts on its prototype. Shared through
 * `Symbol.for`, so an error from another copy of `jsails` is recognized.
 */
const REGISTERED = Symbol.for('jsails.error.registered');

function registryTable(): RegistryTable {
  const holder = globalThis as { [TABLE_KEY]?: RegistryTable };
  holder[TABLE_KEY] ??= { domains: new Map(), conflicts: new Set() };
  return holder[TABLE_KEY];
}

function pascalCase(name: string): string {
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

type DefinitionProblem =
  | 'shape'
  | 'kind'
  | 'audience'
  | 'message'
  | 'slot'
  | 'context_kind'
  | 'suggestion'
  | 'payload'
  | 'expose';

function definitionProblem(definition: unknown): DefinitionProblem | undefined {
  if (typeof definition !== 'object' || definition === null) return 'shape';
  const { kind, audience, message, context, suggestion, payload } = definition as Partial<
    Record<keyof ErrorCodeDefinition, unknown>
  >;
  if (!isErrorKind(kind)) return 'kind';
  if (audience !== undefined && audience !== 'client' && audience !== 'operator') {
    return 'audience';
  }
  if (typeof message !== 'string' || message.trim().length === 0) return 'message';
  if (context !== undefined && (typeof context !== 'object' || context === null)) {
    return 'context_kind';
  }
  const schema = (context ?? {}) as Record<string, unknown>;
  for (const [slot, slotKind] of Object.entries(schema)) {
    if (!SLOT_NAME.test(slot) || !isContextKind(slotKind)) return 'context_kind';
  }
  const withoutSlots = message.replace(SLOT, (match: string, slot: string) => {
    return SLOT_NAME.test(slot) && Object.hasOwn(schema, slot) ? '' : match;
  });
  if (withoutSlots.includes('{') || withoutSlots.includes('}')) return 'slot';
  if (suggestion !== undefined && (typeof suggestion !== 'string' || suggestion.length === 0)) {
    return 'suggestion';
  }
  if (payload !== undefined) {
    if (typeof payload !== 'object' || payload === null) return 'payload';
    const expose = (payload as { readonly expose?: unknown }).expose;
    if (expose !== undefined) {
      if (!Array.isArray(expose)) return 'expose';
      for (const member of expose) {
        if (typeof member !== 'string' || !SLOT_NAME.test(member)) return 'expose';
        if (RESERVED_MEMBERS.has(member)) return 'expose';
      }
    }
  }
  return undefined;
}

function freezeDefinition(definition: ErrorCodeDefinition): ErrorCodeDefinition {
  const context =
    definition.context === undefined
      ? undefined
      : Object.freeze(
          Object.fromEntries(
            Object.entries(definition.context).map(([slot, kind]) => [
              slot,
              typeof kind === 'string' ? kind : Object.freeze([...kind]),
            ]),
          ),
        );
  const expose = definition.payload?.expose;
  return Object.freeze({
    ...definition,
    ...(context === undefined ? {} : { context }),
    ...(definition.payload === undefined
      ? {}
      : { payload: Object.freeze({ expose: Object.freeze([...(expose ?? [])]) }) }),
  });
}

function assertDefinitions(domain: unknown, codes: unknown): asserts codes is ErrorCodeDefinitions {
  if (typeof domain !== 'string' || !NAME.test(domain)) {
    throw new KernelErrors.Error('invalid_domain');
  }
  if (typeof codes !== 'object' || codes === null || Array.isArray(codes)) {
    throw new KernelErrors.Error('invalid_definition', { domain, code: '_', problem: 'shape' });
  }
  for (const [code, definition] of Object.entries(codes)) {
    if (!NAME.test(code)) throw new KernelErrors.Error('invalid_code_name', { domain });
    const problem = definitionProblem(definition);
    if (problem !== undefined) {
      throw new KernelErrors.Error('invalid_definition', { domain, code, problem });
    }
  }
}

function checkedContext(
  qualified: string,
  definition: ErrorCodeDefinition,
  context: unknown,
): Readonly<Record<string, JsailsErrorContextValue>> {
  const schema = definition.context ?? {};
  const given = (context ?? {}) as Record<string, unknown>;
  if (typeof given !== 'object' || given === null) {
    throw new KernelErrors.Error('unexpected_context', { code: qualified });
  }
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(schema, key)) {
      throw new KernelErrors.Error('unexpected_context', { code: qualified });
    }
  }
  const checked: Record<string, JsailsErrorContextValue> = {};
  for (const [slot, kind] of Object.entries(schema)) {
    const value = given[slot];
    if (value === undefined) {
      throw new KernelErrors.Error('invalid_context', {
        code: qualified,
        slot,
        problem: 'missing',
      });
    }
    if (!isContextValue(kind, value)) {
      throw new KernelErrors.Error('invalid_context', {
        code: qualified,
        slot,
        problem: 'invalid',
      });
    }
    checked[slot] = value as JsailsErrorContextValue;
  }
  return Object.freeze(checked);
}

function renderMessage(
  template: string,
  context: Readonly<Record<string, JsailsErrorContextValue>>,
): string {
  return template.replace(SLOT, (_match: string, slot: string) => String(context[slot]));
}

function exposedFields(
  definition: ErrorCodeDefinition,
  payload: unknown,
): Readonly<Record<string, unknown>> | undefined {
  const expose = definition.payload?.expose ?? [];
  if ((definition.audience ?? 'operator') !== 'client' || expose.length === 0) return undefined;
  const source = payload as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const member of expose) {
    if (source[member] !== undefined) fields[member] = source[member];
  }
  return Object.freeze(fields);
}

function record(domain: string, codes: ErrorCodeDefinitions): void {
  const table = registryTable();
  const fingerprint = JSON.stringify(codes);
  const existing = table.domains.get(domain);
  if (existing !== undefined && existing.fingerprint !== fingerprint) table.conflicts.add(domain);
  table.domains.set(domain, { fingerprint, codes });
}

/**
 * Declare a domain's error codes. `domain` and every code are snake_case;
 * see the module documentation for each definition field. Throws
 * `errors.invalid_domain`, `errors.invalid_code_name` or
 * `errors.invalid_definition` for a malformed declaration.
 *
 * @public
 */
export function defineErrors<const Domain extends string, const D extends ErrorCodeDefinitions>(
  domain: Domain,
  codes: D & CheckedDefinitions<D>,
): ErrorRegistry<Domain, D> {
  assertDefinitions(domain, codes);
  const frozen = Object.freeze(
    Object.fromEntries(
      Object.entries(codes as ErrorCodeDefinitions).map(([code, definition]) => [
        code,
        freezeDefinition(definition),
      ]),
    ),
  ) as ErrorCodeDefinitions;
  const prefix = `${domain}.`;
  const className = `${pascalCase(domain)}Error`;

  class RegisteredError extends JsailsError {
    readonly code: string;
    readonly domain: string;

    constructor(
      code: string,
      context?: unknown,
      options?: { readonly cause?: unknown; readonly payload?: unknown },
    ) {
      const definition = Object.hasOwn(frozen, code) ? frozen[code] : undefined;
      if (definition === undefined) throw new KernelErrors.Error('unknown_code', { domain });
      const qualified = prefix + code;
      const checked = checkedContext(qualified, definition, context);
      if (definition.payload !== undefined && options?.payload === undefined) {
        throw new KernelErrors.Error('missing_payload', { code: qualified });
      }
      const clientFields = exposedFields(definition, options?.payload);
      super(renderMessage(definition.message, checked), {
        context: checked,
        kind: definition.kind,
        audience: definition.audience ?? 'operator',
        ...(options?.cause === undefined ? {} : { cause: options.cause }),
        ...(definition.suggestion === undefined ? {} : { suggestion: definition.suggestion }),
        ...(options?.payload === undefined ? {} : { payload: options.payload }),
        ...(clientFields === undefined ? {} : { clientFields }),
      });
      this.code = qualified;
      this.domain = domain;
      this.name = className;
    }
  }
  Object.defineProperty(RegisteredError, 'name', { value: className });
  Object.defineProperty(RegisteredError.prototype, REGISTERED, { value: true });

  record(domain, frozen);

  return Object.freeze({
    domain,
    codes: frozen as D,
    Error: RegisteredError as unknown as RegistryErrorClass<Domain, D>,
    is(error: unknown, code?: string): boolean {
      if (!isJsailsError(error)) return false;
      if (code !== undefined) return error.code === prefix + code;
      return (
        error.code.startsWith(prefix) && Object.hasOwn(frozen, error.code.slice(prefix.length))
      );
    },
  }) as ErrorRegistry<Domain, D>;
}

/**
 * True when `value` was raised through a registry: its message was rendered
 * from the code's template and validated context, so it is value-free by
 * construction and safe to show the operator. A hand-written `JsailsError`
 * subclass is not: its message is whatever its author passed.
 *
 * @public
 */
export function isRegistryError(value: unknown): value is JsailsError {
  if (!isJsailsError(value)) return false;
  return (value as { readonly [REGISTERED]?: unknown })[REGISTERED] === true;
}

/**
 * The text a registry error may show: its message and suggestion rendered
 * again from its code's definition in the process-wide table and its context,
 * each context value checked against the slot's declared kind once more.
 * `undefined` when `value` is no registry error, its code is in no recorded
 * domain, or its context does not fit the definition.
 *
 * The error's own `message` and `suggestion` are never read: both are
 * ordinary writable properties, and code that appends to a caught error's
 * message (`error.message += ` …) is common enough that a report trusting
 * them would print whatever was appended. The brand is a global symbol too,
 * so a forged error passes {@link isRegistryError}; it gets no text here
 * unless its code and context render through a recorded definition, which
 * makes the text value-free whoever built the object.
 *
 * @internal
 */
export function registryErrorText(
  value: unknown,
): { readonly message: string; readonly suggestion: string | undefined } | undefined {
  try {
    if (!isRegistryError(value)) return undefined;
    const qualified: unknown = value.code;
    if (typeof qualified !== 'string') return undefined;
    const dot = qualified.indexOf('.');
    if (dot === -1) return undefined;
    const record = registryTable().domains.get(qualified.slice(0, dot));
    const code = qualified.slice(dot + 1);
    if (record === undefined || !Object.hasOwn(record.codes, code)) return undefined;
    const definition = record.codes[code] as ErrorCodeDefinition;
    const context: unknown = value.context;
    if (typeof context !== 'object' || context === null) return undefined;
    const checked: Record<string, JsailsErrorContextValue> = {};
    for (const [slot, kind] of Object.entries(definition.context ?? {})) {
      const slotValue: unknown = Object.hasOwn(context, slot)
        ? (context as Record<string, unknown>)[slot]
        : undefined;
      if (!isContextValue(kind, slotValue)) return undefined;
      checked[slot] = slotValue as JsailsErrorContextValue;
    }
    return {
      message: renderMessage(definition.message, checked),
      suggestion: definition.suggestion,
    };
  } catch {
    // A proxy or a throwing getter posing as an error: it has no text a
    // report could trust.
    return undefined;
  }
}

/**
 * Options for {@link failureHead}.
 *
 * @internal
 */
export interface FailureHeadOptions {
  /**
   * Whether a thrown value that is no registry error may have its message
   * printed. Defaults to `isJsailsError`. A reporter whose errors come from
   * code it does not own (a project command, an extension) narrows it to the
   * framework errors it knows are value-free.
   */
  readonly allow?: (error: unknown) => boolean;
  /** The line printed for a withheld message. Defaults to `the command failed`. */
  readonly fallback?: string;
}

/**
 * A failure report's top line.
 *
 * @internal
 */
export interface FailureHead {
  /** The message, then a `  hint:` line when there is a suggestion. */
  readonly lines: readonly string[];
  /** False when the message was withheld; the cause chain then summarises the error. */
  readonly shown: boolean;
}

function withheldHead(options: FailureHeadOptions): FailureHead {
  return { lines: [options.fallback ?? 'the command failed'], shown: false };
}

function headLines(message: string, suggestion: unknown): readonly string[] {
  return typeof suggestion === 'string' && suggestion.length > 0
    ? [message, `  hint: ${suggestion}`]
    : [message];
}

/**
 * The top line of a command-line failure report for `thrown`, the policy
 * every first-party reporter shares (the `jsails` CLI, the `jamal` bin, the
 * dev MCP server's log):
 *
 * - a registry error prints its text as {@link registryErrorText} renders it,
 *   or is withheld when it renders through no definition;
 * - any other value prints its own message and suggestion when `allow`
 *   accepts it: by default a framework error, which the command threw itself
 *   and whose message follows the value-free rule;
 * - everything else (a driver's error, whatever a user's code threw, a
 *   thrown non-error) is withheld: the line is a fixed `fallback`, and the
 *   cause-chain renderer prints the error's value-free facts under it.
 *
 * Here rather than beside the renderer because every failure path has loaded
 * this module already, so deciding the top line loads nothing more.
 *
 * @internal
 */
export function failureHead(thrown: unknown, options: FailureHeadOptions = {}): FailureHead {
  if (isRegistryError(thrown)) {
    const text = registryErrorText(thrown);
    return text === undefined
      ? withheldHead(options)
      : { lines: headLines(text.message, text.suggestion), shown: true };
  }
  try {
    if (!(options.allow ?? isJsailsError)(thrown) || !(thrown instanceof Error)) {
      return withheldHead(options);
    }
    const suggestion: unknown = (thrown as { readonly suggestion?: unknown }).suggestion;
    return { lines: headLines(thrown.message, suggestion), shown: true };
  } catch {
    // A getter that throws on `message` or `suggestion`, or a predicate
    // that does: nothing about the value can be printed as its message.
    return withheldHead(options);
  }
}

/**
 * Throw `registry`'s `code` with `context` unless `condition` holds. The
 * argument check that replaces a hand-written `TypeError`:
 * `invariant(name.length > 0, ServiceErrors, 'invalid_token_name')`.
 *
 * @public
 */
export function invariant<
  Domain extends string,
  D extends ErrorCodeDefinitions,
  C extends keyof D & string,
>(
  condition: unknown,
  registry: ErrorRegistry<Domain, D>,
  code: C,
  ...args: RegistryErrorArguments<D[C]>
): asserts condition {
  if (condition) return;
  throw new registry.Error(code, ...args);
}

/**
 * Every code of every domain defined in this process, sorted by code.
 *
 * @public
 */
export function registeredErrorCodes(): readonly RegisteredErrorCode[] {
  const codes: RegisteredErrorCode[] = [];
  for (const [domain, { codes: definitions }] of registryTable().domains) {
    for (const [code, definition] of Object.entries(definitions)) {
      codes.push(
        Object.freeze({
          code: `${domain}.${code}`,
          kind: definition.kind,
          audience: definition.audience ?? 'operator',
          message: definition.message,
          context: definition.context ?? Object.freeze({}),
          suggestion: definition.suggestion,
          exposes: definition.payload?.expose ?? Object.freeze([]),
        }),
      );
    }
  }
  return Object.freeze(codes.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)));
}

/**
 * The domains defined more than once with different codes in this process.
 *
 * @public
 */
export function errorRegistryConflicts(): readonly string[] {
  return Object.freeze([...registryTable().conflicts].sort());
}

const KERNEL_ERRORS = {
  invalid_domain: {
    kind: 'internal',
    message: 'an error domain must be a snake_case name',
  },
  invalid_code_name: {
    kind: 'internal',
    message: 'error domain {domain} declares a code that is not a snake_case name',
    context: { domain: 'identifier' },
  },
  invalid_definition: {
    kind: 'internal',
    message: 'error code {domain}.{code} has an invalid {problem}',
    context: {
      domain: 'identifier',
      code: 'identifier',
      problem: [
        'shape',
        'kind',
        'audience',
        'message',
        'slot',
        'context_kind',
        'suggestion',
        'payload',
        'expose',
      ],
    },
  },
  unknown_code: {
    kind: 'internal',
    message: 'error domain {domain} has no such code',
    context: { domain: 'identifier' },
  },
  invalid_context: {
    kind: 'internal',
    message: 'error {code} context slot {slot} is {problem}',
    context: { code: 'identifier', slot: 'identifier', problem: ['missing', 'invalid'] },
  },
  unexpected_context: {
    kind: 'internal',
    message: 'error {code} was given a context slot it does not declare',
    context: { code: 'identifier' },
  },
  missing_payload: {
    kind: 'internal',
    message: 'error {code} requires a payload',
    context: { code: 'identifier' },
  },
  invalid_argument: {
    kind: 'internal',
    message: '{function} was given an invalid {argument}',
    context: { function: 'identifier', argument: 'identifier' },
  },
  internal: {
    kind: 'internal',
    message: 'an unexpected error occurred',
  },
  aborted: {
    kind: 'aborted',
    message: 'the operation was aborted',
  },
  timeout: {
    kind: 'timeout',
    message: 'the operation timed out',
  },
  unique_violation: {
    kind: 'conflict',
    message: 'a write violated a unique constraint',
  },
} as const;

/**
 * The error kernel's own codes: malformed declarations and constructions, and
 * the codes `normalizeError` gives a foreign error.
 *
 * @public
 */
export const KernelErrors: ErrorRegistry<'errors', typeof KERNEL_ERRORS> = defineErrors(
  'errors',
  KERNEL_ERRORS,
);
