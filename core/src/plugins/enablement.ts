/**
 * Plugin enablement: folding the two independent enable sources into one
 * deterministic, frozen decision.
 *
 * A plugin id can be enabled from either of two sources, and the two are merged
 * here:
 *
 * - the **code list** — `plugins.enabled` in the app config (npm plugins, where
 *   installing the dependency is activating it);
 * - the **managed state** — the persisted `PluginStateStore` document written by
 *   the admin, where each id records an `enabled` flag.
 *
 * `resolvePluginEnablement` is pure and value-free: it never reads the
 * filesystem, never mutates its inputs, and never echoes an invalid id. The
 * result is:
 *
 * - `enabled` — the deterministic sorted union of the code list and every state
 *   id with `enabled === true`, minus any conflicted id;
 * - `conflicts` — ids present in **both** sources. These are excluded from
 *   `enabled` (and from every convenience list) so a caller must fail closed or
 *   report them; the admin refuses to install a code-managed id, so a conflict
 *   is a configuration error, never silently resolved;
 * - `managedEnabled` — state ids with `enabled === true` that are not also
 *   code-enabled (the purely managed subset of `enabled`);
 * - `codeEnabled` — code-list ids that are not also present in state (the
 *   purely code subset of `enabled`);
 * - `disabledManaged` — state ids with `enabled === false` that are not also
 *   code-enabled (installed but turned off; skipped, not enabled).
 *
 * Empty or absent inputs are handled: `codeEnabled` absent becomes `[]`, and an
 * absent `state` contributes no ids. A code id that does not match
 * {@link PLUGIN_ID_PATTERN} is rejected with a value-free
 * {@link PluginEnablementError} (the id is never echoed). State ids are assumed
 * already validated by {@link PluginStateStore}.
 *
 * {@link loadPluginEnablement} is the managed/non-managed switch. A
 * **non-managed** deployment performs no I/O and resolves enablement from the
 * code list only (`state` stays `undefined`); a **managed** deployment requires
 * a state source (a clear, value-free error when one is missing), loads it,
 * then merges it with the code list through {@link resolvePluginEnablement}.
 * The static export is always non-managed. The switch depends on the state
 * source's contract only, so resolving enablement never loads the database
 * store.
 */

import { PLUGIN_ID_PATTERN } from './manifest/plugin-id.js';
import type { PluginState, PluginStateSource } from './state-store.js';
import { JsailsError } from '../errors/jsails-error.js';

/** Inputs to {@link resolvePluginEnablement}. */
export interface ResolvePluginEnablementInput {
  /** Plugin ids enabled in the app config (`plugins.enabled`). Absent means none. */
  readonly codeEnabled?: readonly string[];
  /** Managed plugin state written by the admin. Absent means none. */
  readonly state?: PluginState;
}

/** The merged, deterministic enablement decision. */
export interface PluginEnablement {
  /** Sorted union of code-enabled ids and managed-enabled ids, minus conflicts. */
  readonly enabled: readonly string[];
  /** Sorted ids present in both sources; excluded from `enabled`. */
  readonly conflicts: readonly string[];
  /** Sorted managed ids with `enabled === true` not also code-enabled. */
  readonly managedEnabled: readonly string[];
  /** Sorted code-list ids not also present in state. */
  readonly codeEnabled: readonly string[];
  /** Sorted managed ids with `enabled === false` not also code-enabled. */
  readonly disabledManaged: readonly string[];
}

/** Stable failure code carried by {@link PluginEnablementError}. */
export type PluginEnablementErrorCode = 'invalid_plugin_id' | 'missing_state_source';

/** Raised for an invalid code-enabled id or a managed-state read without a state source. */
export class PluginEnablementError extends JsailsError {
  constructor(
    readonly code: PluginEnablementErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Merge the code list and the managed state into one frozen, deterministic
 * enablement decision. See the module doc for the exact contract.
 */
export function resolvePluginEnablement(input: ResolvePluginEnablementInput): PluginEnablement {
  const code = normalizeCode(input.codeEnabled);
  const codeSet = new Set(code);

  const stateIds = input.state === undefined ? [] : Object.keys(input.state.plugins);
  const stateIdSet = new Set(stateIds);

  const conflicts: string[] = [];
  const codeOnly: string[] = [];
  for (const id of code) {
    if (stateIdSet.has(id)) {
      conflicts.push(id);
    } else {
      codeOnly.push(id);
    }
  }

  const managedEnabled: string[] = [];
  const disabledManaged: string[] = [];
  for (const id of stateIds) {
    if (codeSet.has(id)) continue; // already recorded as a conflict
    const entry = input.state?.plugins[id];
    if (entry?.enabled === true) {
      managedEnabled.push(id);
    } else {
      disabledManaged.push(id);
    }
  }

  return Object.freeze({
    enabled: freezeSorted([...codeOnly, ...managedEnabled]),
    conflicts: freezeSorted(conflicts),
    managedEnabled: freezeSorted(managedEnabled),
    codeEnabled: freezeSorted(codeOnly),
    disabledManaged: freezeSorted(disabledManaged),
  });
}

/**
 * Validate and dedupe the code list. An id that is not a string or does not
 * match {@link PLUGIN_ID_PATTERN} throws a value-free
 * {@link PluginEnablementError}; the offending id is never echoed. Duplicates
 * are collapsed, preserving the first occurrence's position.
 */
function normalizeCode(codeEnabled: readonly string[] | undefined): string[] {
  if (codeEnabled === undefined) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of codeEnabled) {
    if (typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id)) {
      throw new PluginEnablementError(
        'invalid_plugin_id',
        'plugin enablement contains an invalid code-enabled id',
      );
    }
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/** A frozen, sorted copy of a list of unique ids. */
function freezeSorted(ids: readonly string[]): readonly string[] {
  return Object.freeze([...ids].sort());
}

/** Inputs to {@link loadPluginEnablement}. */
export interface LoadPluginEnablementInput {
  /** Plugin ids enabled in the app config (`plugins.enabled`). */
  readonly codeEnabled?: readonly string[];
  /** Whether plugin state is managed in the database. Defaults to `false`. */
  readonly managed?: boolean;
  /** The state source for a managed deployment. Required when `managed` is true. */
  readonly stateSource?: PluginStateSource;
}

/** Enablement plus the managed state it was resolved from (`undefined` when non-managed). */
export interface LoadedPluginEnablement {
  readonly enablement: PluginEnablement;
  readonly state: PluginState | undefined;
}

/**
 * Resolve plugin enablement through the managed/non-managed switch. When
 * `managed` is not exactly `true`, no state source is consulted (zero I/O) and
 * the result is the code-only enablement; when it is `true`, a state source is
 * required (a value-free {@link PluginEnablementError} otherwise) and its state
 * is loaded before {@link resolvePluginEnablement} merges it with the code list.
 */
export async function loadPluginEnablement(
  input: LoadPluginEnablementInput,
): Promise<PluginEnablement> {
  return (await loadPluginEnablementState(input)).enablement;
}

/**
 * {@link loadPluginEnablement}, also returning the loaded managed state so a
 * caller (activation) can read each plugin's recorded active version from the
 * same read that decided enablement.
 */
export async function loadPluginEnablementState(
  input: LoadPluginEnablementInput,
): Promise<LoadedPluginEnablement> {
  if (input.managed !== true) {
    return {
      enablement: resolvePluginEnablement({ codeEnabled: input.codeEnabled, state: undefined }),
      state: undefined,
    };
  }
  if (input.stateSource === undefined) {
    throw new PluginEnablementError(
      'missing_state_source',
      'managed plugin state requires a state source',
    );
  }
  const state = await input.stateSource.load();
  return {
    enablement: resolvePluginEnablement({ codeEnabled: input.codeEnabled, state }),
    state,
  };
}
