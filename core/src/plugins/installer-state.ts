/**
 * The installer's view of the persisted plugin state: every read and write
 * goes through the configured {@link PluginStateSource}, and a store failure
 * surfaces as a value-free {@link PluginInstallerError} (`state_failed`) so a
 * caller never sees the store's own error or the state file's path.
 */

import { PluginInstallerError } from './installer-error.js';
import { PluginStateError, type PluginState, type PluginStateSource } from './state-store.js';

/** The state operations the installer performs. */
export interface InstallerState {
  /** The current persisted state. */
  load(): Promise<PluginState>;
  /** Replace the persisted state. */
  save(state: PluginState): Promise<void>;
  /** Record `version` as the active, enabled version of `id`. */
  recordInstall(id: string, version: string): Promise<void>;
  /** Drop the entry for `id`; a no-op when absent. */
  removeEntry(id: string): Promise<void>;
}

/** Wrap a state source with the installer's error discipline. */
export function createInstallerState(stateStore: PluginStateSource): InstallerState {
  async function load(): Promise<PluginState> {
    try {
      return await stateStore.load();
    } catch (error) {
      if (error instanceof PluginStateError) {
        throw new PluginInstallerError('state_failed', 'plugin state could not be read');
      }
      throw error;
    }
  }

  async function save(state: PluginState): Promise<void> {
    try {
      await stateStore.save(state);
    } catch (error) {
      if (error instanceof PluginStateError) {
        throw new PluginInstallerError('state_failed', 'plugin state could not be updated');
      }
      throw error;
    }
  }

  return {
    load,
    save,
    async recordInstall(id, version) {
      const state = await load();
      await save({
        ...state,
        plugins: {
          ...state.plugins,
          [id]: { active: version, enabled: true },
        },
      });
    },
    async removeEntry(id) {
      const state = await load();
      if (!(id in state.plugins)) return;
      const { [id]: _removed, ...remaining } = state.plugins;
      await save({ ...state, plugins: remaining });
    },
  };
}
