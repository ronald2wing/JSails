/**
 * Ambient application scope over the service registry.
 *
 * A facade (`facade(token)`) must resolve to *this* application's service without
 * a global instance slot, so the registry rides in the execution context
 * (`jsails/context`) under a key of its own, never propagated: a registry is a
 * live object of this process, and a job restored in a worker gets the
 * worker's registry from the runtime that runs it.
 *
 * The scope is opened once per unit of work — extension setup, a request, a
 * static-export render, a job handler — and holds the application's **live**
 * registry, not a snapshot: `runExtensions` populates the registry while the
 * setup scope is already open, so a copy would miss late `provide` calls. A
 * request and a job attempt set it in the one context they enter
 * ({@link appScopeEntry}); the other units open it with {@link withAppScope}.
 *
 * Nested scopes shadow outer ones (LIFO), which is what lets a job that runs
 * inside a request resolve facades against the job's own registry without
 * disturbing the request scope.
 */

import {
  contextEntry,
  createContextKey,
  getContext,
  withContext,
  type ContextEntry,
} from '../context/execution-context.js';
import type { ServiceRegistry } from '../extensions/services.js';

/** The active application scope: the registry facades resolve against. */
export interface AppScope {
  readonly services: ServiceRegistry;
}

const appScopeKey = createContextKey<AppScope>('jsails.app-scope');

/**
 * The context entry that makes `services` the application scope, for a unit
 * of work that builds its execution context in one step.
 */
export function appScopeEntry(services: ServiceRegistry): ContextEntry<unknown> {
  return contextEntry<unknown>(appScopeKey, Object.freeze({ services }));
}

/**
 * Run `fn` with `services` as the ambient application scope. The scope is active
 * for the synchronous body and every async continuation it awaits, and is
 * restored on return/throw. Nested calls shadow the outer scope.
 */
export function withAppScope<T>(services: ServiceRegistry, fn: () => T): T {
  return withContext(appScopeKey, Object.freeze({ services }), fn);
}

/**
 * The active application scope, or `undefined` when no application work is in
 * progress (a top-level CLI script, pre-app code). Facades use the scoped form
 * there instead of the ambient one.
 */
export function currentAppScope(): AppScope | undefined {
  return getContext(appScopeKey);
}
