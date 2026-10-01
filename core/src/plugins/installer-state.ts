/**
 * The installer's view of the persisted plugin state: every read and write
 * goes through the configured {@link PluginStateSource}, and a store failure
 * surfaces as a value-free {@link PluginInstallerError} (`state_failed`) so a
 * caller never sees the store's own error or the state file's path. Writes
 * touch one plugin id at a time, never the whole document.
 */

import { PluginInstallerError } from './installer-error.js';
import {
  PluginStateError,
  type PluginState,
  type PluginStateEntry,
  type PluginStateSource,
} from './state-store.js';

/** The state operations the installer performs. */
export interface InstallerState {
  /** The current persisted state. */
  load(): Promise<PluginState>;
  /** Write the entry for one id, leaving every other id as stored. */
  putEntry(id: string, entry: PluginStateEntry): Promise<void>;
  /**
   * Record `version` as the active version of `id`. An existing entry keeps its
   * settings and enabled flag; a first install is enabled.
   */
  recordInstall(id: string, version: string): Promise<void>;
  /** Drop the entry for `id`; a no-op when absent. */
  removeEntry(id: string): Promise<void>;
}

/** Wrap a state source with the installer's error discipline. */
export function createInstallerState(stateStore: PluginStateSource): InstallerState {
  async function guarded<T>(task: () => Promise<T>, message: string): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (error instanceof PluginStateError) {
        throw new PluginInstallerError('state_failed', message);
      }
      throw error;
    }
  }

  function load(): Promise<PluginState> {
    return guarded(async () => stateStore.load(), 'plugin state could not be read');
  }

  function putEntry(id: string, entry: PluginStateEntry): Promise<void> {
    return guarded(async () => stateStore.putEntry(id, entry), 'plugin state could not be updated');
  }

  return {
    load,
    putEntry,
    async recordInstall(id, version) {
      const existing = (await load()).plugins[id];
      await putEntry(id, { ...existing, active: version, enabled: existing?.enabled ?? true });
    },
    removeEntry(id) {
      return guarded(async () => stateStore.removeEntry(id), 'plugin state could not be updated');
    },
  };
}
