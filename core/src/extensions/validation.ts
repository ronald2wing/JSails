/**
 * Shared structural validation for extension and module entries.
 *
 * Both the extension runner (`runExtensions`) and the app-config resolver
 * (`resolveExtensions`) must reject the same malformed entries before any setup
 * runs or any side effect occurs. This module centralizes that shape check so
 * the two callers stay in lock-step; each caller maps the returned error code to
 * its own error: the runner raises an `extension.*` code whose context names the
 * entry, the config resolver keeps every message value-free. A name must be an
 * identifier, so it can be that context. A plugin instance (`definePlugin`) was
 * validated when its definition and options were, so only its name joins the
 * shared uniqueness check: a keyed plugin's instances are named
 * `<plugin>:<key>`, so it admits one instance per key, and an unkeyed plugin
 * one instance per application.
 */

import { isIdentifier } from '../errors/context-schema.js';
import { isRecord } from '../json/shape.js';
import { isPluginInstance } from '../plugins/contract/instance.js';

/** Machine-readable reason an extension/module entry was rejected. */
export type ExtensionEntryErrorCode =
  | 'not_object'
  | 'invalid_name'
  | 'invalid_priority'
  | 'invalid_disabled'
  | 'duplicate_name'
  | 'missing_setup'
  | 'requires_not_array'
  | 'invalid_token'
  | 'provides_not_array'
  | 'invalid_provides_entry'
  | 'invalid_provides_override'
  | 'invalid_requires_union'
  | 'invalid_readiness'
  | 'duplicate_readiness_probe';

/** The first structural problem found in an entry list, or none when valid. */
export interface ExtensionEntryError {
  readonly code: ExtensionEntryErrorCode;
  /** 0-based index of the offending entry. */
  readonly index: number;
  /** The entry's name, when it is known at the point the error was detected. */
  readonly name: string | undefined;
}

/** The fields the shared check reads; callers cast the broader entry type. */
interface EntryLike {
  readonly name?: unknown;
  readonly priority?: unknown;
  readonly disabled?: unknown;
  readonly setup?: unknown;
  readonly requires?: unknown;
  readonly provides?: unknown;
  readonly readiness?: unknown;
}

/** A service-token-shaped object: an object with a non-empty string `name`. */
export function isTokenLike(token: unknown): token is { readonly name: string } {
  return isRecord(token) && typeof token.name === 'string' && token.name.trim() !== '';
}

/**
 * Validate a list of extension/module entries, returning the first structural
 * error (or `undefined` when every entry is well-formed). Validation is
 * side-effect free: nothing is invoked and no entry value is echoed. Callers
 * decide how to surface the error.
 */
export function validateExtensionEntries(
  entries: readonly unknown[],
): ExtensionEntryError | undefined {
  const names = new Set<string>();
  // Probe names share one namespace across entries because the readiness
  // report lists every probe by name.
  const probeNames = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!isRecord(entry)) {
      return { code: 'not_object', index, name: undefined };
    }
    const candidate = entry as EntryLike;
    const name = candidate.name;
    if (!isIdentifier(name)) {
      return { code: 'invalid_name', index, name: undefined };
    }
    if (isPluginInstance(entry)) {
      if (names.has(name)) return { code: 'duplicate_name', index, name };
      names.add(name);
      continue;
    }
    const priority = candidate.priority;
    if (priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority))) {
      return { code: 'invalid_priority', index, name };
    }
    const disabled = candidate.disabled;
    if (disabled !== undefined && typeof disabled !== 'boolean') {
      return { code: 'invalid_disabled', index, name };
    }
    if (names.has(name)) {
      return { code: 'duplicate_name', index, name };
    }
    names.add(name);
    if (typeof candidate.setup !== 'function') {
      return { code: 'missing_setup', index, name };
    }
    const requires = candidate.requires;
    if (requires !== undefined) {
      if (!Array.isArray(requires)) {
        return { code: 'requires_not_array', index, name };
      }
      for (const token of requires) {
        if (!isTokenLike(token)) {
          return { code: 'invalid_token', index, name };
        }
      }
    }
    const provides = candidate.provides;
    if (provides !== undefined) {
      if (!Array.isArray(provides)) {
        return { code: 'provides_not_array', index, name };
      }
      for (const entry_ of provides) {
        if (entry_ === null || typeof entry_ !== 'object' || Array.isArray(entry_)) {
          return { code: 'invalid_provides_entry', index, name };
        }
        const provideEntry = entry_ as { contract?: unknown; override?: unknown };
        if (!isTokenLike(provideEntry.contract)) {
          return { code: 'invalid_provides_entry', index, name };
        }
        if (provideEntry.override !== undefined && typeof provideEntry.override !== 'boolean') {
          return { code: 'invalid_provides_override', index, name };
        }
      }
    }
    const readiness = candidate.readiness;
    if (readiness !== undefined) {
      if (!isRecord(readiness)) {
        return { code: 'invalid_readiness', index, name };
      }
      for (const [probeName, probe] of Object.entries(readiness)) {
        if (probeName.trim() === '' || typeof probe !== 'function') {
          return { code: 'invalid_readiness', index, name };
        }
        if (probeNames.has(probeName)) {
          return { code: 'duplicate_readiness_probe', index, name };
        }
        probeNames.add(probeName);
      }
    }
  }
  return undefined;
}
