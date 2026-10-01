/**
 * Service tokens and the registry that backs them.
 *
 * A service token is an opaque, typed identity: the token object itself is the
 * lookup key, so two tokens created with the same name are still distinct
 * services. The phantom `T` carries the service's value type from the
 * `createServiceToken<T>(name)` call to every `get`/`tryGet`/`provide`, so the
 * registry stays dynamically keyed while consumers stay typed.
 *
 * A token is also a family: `token.named('media')` is the keyed member for one
 * configured instance (one disk, one cache store), the same object for the
 * same key, so config and setup name it independently and still meet. A token
 * created with `{ live: true }` names a service that only exists in a live
 * process (a queue worker, a socket server); a static export skips every
 * plugin that provides or needs one.
 *
 * The registry is plain — a `Map`, no reflection, no decorators, no global
 * state. `createServiceRegistry` returns a small controller so the runner can
 * read services, register them, seal the registrar after setup, and wipe the
 * map on shutdown.
 */

import { isIdentifier } from '../errors/context-schema.js';
import { defineErrors, invariant, type ErrorRegistry } from '../errors/registry.js';

declare const serviceTokenBrand: unique symbol;

/**
 * An opaque handle to a service of type `T`. The brand is compile-time only,
 * so tokens are safe to keep, pass around, and compare by identity.
 */
export interface ServiceToken<T> {
  /** Developer-facing label used in error messages only. */
  readonly name: string;
  /** Whether the service only exists in a live process; a static export skips it. */
  readonly live: boolean;
  /** The family a keyed token belongs to; `undefined` for a family itself. */
  readonly family: ServiceTokenFamily<T> | undefined;
  /** The key of a keyed token; `undefined` for a family itself. */
  readonly key: string | undefined;
  /** Phantom type slot; never present at runtime. */
  readonly [serviceTokenBrand]: T;
}

/**
 * A token as {@link createServiceToken} returns it: a service of its own, and
 * the family of its keyed members.
 *
 * @public
 */
export interface ServiceTokenFamily<T> extends ServiceToken<T> {
  /**
   * The keyed member for `key`, an identifier: the same token for the same
   * key, named `<name>:<key>`, live when the family is. A keyed token is not a
   * family, so it has no members of its own.
   */
  named(key: string): ServiceToken<T>;
}

/**
 * Options for {@link createServiceToken}.
 *
 * @public
 */
export interface ServiceTokenOptions {
  /** The service only exists in a live process (see {@link ServiceToken.live}). */
  readonly live?: boolean;
}

/**
 * Create a new service token. Each call produces a distinct identity even when
 * `name` repeats; the name is a label for diagnostics, not a key. It must be an
 * identifier (`jsails.db`, `@acme/billing:client`) because it is the context
 * of every registry error about the token.
 */
export function createServiceToken<T>(
  name: string,
  options: ServiceTokenOptions = {},
): ServiceTokenFamily<T> {
  invariant(isIdentifier(name), ServiceErrors, 'invalid_token_name');
  invariant(
    options !== null &&
      typeof options === 'object' &&
      (options.live === undefined || typeof options.live === 'boolean'),
    ServiceErrors,
    'invalid_token_option',
  );
  const live = options.live === true;
  const members = new Map<string, ServiceToken<T>>();
  const family: ServiceTokenFamily<T> = Object.freeze({
    name,
    live,
    family: undefined,
    key: undefined,
    named(key: string): ServiceToken<T> {
      invariant(
        isIdentifier(key) && isIdentifier(`${name}:${key}`),
        ServiceErrors,
        'invalid_token_key',
      );
      let member = members.get(key);
      if (member === undefined) {
        member = Object.freeze({
          name: `${name}:${key}`,
          live,
          family,
          key,
        }) as unknown as ServiceToken<T>;
        members.set(key, member);
      }
      return member;
    },
  }) as unknown as ServiceTokenFamily<T>;
  return family;
}

/**
 * Whether `value` is a token {@link createServiceToken} made (or one of its
 * keyed members). Structural, so a token from another copy of the framework
 * in the same process is recognised.
 *
 * @public
 */
export function isServiceToken(value: unknown): value is ServiceToken<unknown> {
  if (value === null || typeof value !== 'object') return false;
  const token = value as { readonly name?: unknown; readonly live?: unknown };
  return isIdentifier(token.name) && typeof token.live === 'boolean';
}

const SERVICE_ERRORS = {
  invalid_token_name: {
    kind: 'internal',
    message: 'a service token name must be an identifier',
  },
  invalid_token_option: {
    kind: 'internal',
    message: 'service token options must be an object whose live flag is a boolean',
  },
  invalid_token_key: {
    kind: 'internal',
    message: 'a service token key must be an identifier',
  },
  not_found: {
    kind: 'not_found',
    message: 'no service registered for token {token}',
    context: { token: 'identifier' },
  },
  duplicate: {
    kind: 'conflict',
    message: 'service token {token} is already provided',
    context: { token: 'identifier' },
    suggestion: 'pass { replace: true } to provide() to replace a service on purpose',
  },
  sealed: {
    kind: 'internal',
    message: 'the service registry is sealed; cannot provide {token}',
    context: { token: 'identifier' },
    suggestion: 'provide services during extension setup',
  },
  closed: {
    kind: 'internal',
    message: 'the service registry is closed; cannot resolve {token}',
    context: { token: 'identifier' },
  },
} as const;

/**
 * The service registry's codes, `service.*`: a missing lookup, a duplicate
 * `provide`, an attempt to register after sealing or to read after closing.
 * The context names the token, never the service value.
 *
 * @public
 */
export const ServiceErrors: ErrorRegistry<'service', typeof SERVICE_ERRORS> = defineErrors(
  'service',
  SERVICE_ERRORS,
);

/** Read-only view of a service registry. */
export interface ServiceRegistry {
  /** Whether `token` currently resolves. Throws once the registry is closed. */
  has<T>(token: ServiceToken<T>): boolean;
  /** Resolve `token`, or `undefined` when absent. Throws once closed. */
  tryGet<T>(token: ServiceToken<T>): T | undefined;
  /** Resolve `token`, or throw `service.not_found`/`service.closed`. */
  get<T>(token: ServiceToken<T>): T;
}

/**
 * Options for a {@link ServiceRegistrar.provide} call. At most one extra flag
 * is currently supported; the object form keeps the surface extendable.
 */
export interface ProvideOptions {
  /**
   * When `true`, the value is set unconditionally — any existing registration
   * is overwritten and the duplicate check is skipped. This is the mechanism
   * that lets a contract override provider replace a default implementation.
   * Defaults to `false`.
   */
  readonly replace?: boolean;
}

/** A read registry that can also register services. */
export interface ServiceRegistrar extends ServiceRegistry {
  /**
   * Register `value` under `token`. Without {@link ProvideOptions.replace}, a
   * second registration of the same token (identity, not name) is rejected.
   * With `replace: true` the previous value is overwritten; this is the
   * contract-override mechanism. Any attempt after seal or clear is still
   * rejected regardless of the flag.
   */
  provide<T>(token: ServiceToken<T>, value: T, options?: ProvideOptions): void;
}

/** Owner-facing controller over one registry; the runner drives seal/clear. */
export interface ServiceRegistryController {
  /** Read-only view handed to extension consumers. */
  readonly services: ServiceRegistry;
  /** Write view handed to extension setup. */
  readonly registrar: ServiceRegistrar;
  /** Stop future `provide` calls; reads keep working. */
  seal(): void;
  /** Drop all services and close the registry so reads fail. */
  clear(): void;
}

function closedError(token: ServiceToken<unknown>): Error {
  return new ServiceErrors.Error('closed', { token: token.name });
}

/**
 * Create an isolated service registry. Every call owns its own map: there is
 * no global registry and no cross-app sharing.
 */
export function createServiceRegistry(): ServiceRegistryController {
  const values = new Map<ServiceToken<unknown>, unknown>();
  let sealed = false;
  let closed = false;

  const has = <T>(token: ServiceToken<T>): boolean => {
    if (closed) throw closedError(token);
    return values.has(token);
  };

  const tryGet = <T>(token: ServiceToken<T>): T | undefined => {
    if (closed) throw closedError(token);
    return values.get(token) as T | undefined;
  };

  const get = <T>(token: ServiceToken<T>): T => {
    if (closed) throw closedError(token);
    if (!values.has(token)) {
      throw new ServiceErrors.Error('not_found', { token: token.name });
    }
    return values.get(token) as T;
  };

  const provide = <T>(token: ServiceToken<T>, value: T, options?: ProvideOptions): void => {
    if (closed) throw closedError(token);
    if (sealed) {
      throw new ServiceErrors.Error('sealed', { token: token.name });
    }
    const replace = options?.replace === true;
    if (!replace && values.has(token)) {
      throw new ServiceErrors.Error('duplicate', { token: token.name });
    }
    values.set(token, value);
  };

  return {
    services: { has, tryGet, get },
    registrar: { has, tryGet, get, provide },
    seal(): void {
      sealed = true;
    },
    clear(): void {
      values.clear();
      sealed = true;
      closed = true;
    },
  };
}
