/**
 * Which plugins only work in a live process.
 *
 * A plugin on the contract is live-only when it provides or requires a live
 * token (`createServiceToken(name, { live: true })`), or when it requires a
 * token that only live-only plugins provide: a static export drops it with
 * them instead of failing on a missing service. A plugin on the extension
 * contract (`JsailsPlugin`) still says so through `describe().needsLive`
 * until it is converted; a `describe()` that throws counts as live-only, so a
 * misbehaving plugin is dropped from a static export rather than kept.
 *
 * The kernel's `resolvePlugins` is the one caller: it takes the set over
 * every declared plugin (framework, `plugins.use` and extensions), reports it
 * as `PluginGraph.liveOnly` (which `jsails describe` prints), and leaves it
 * out of a static export, so the export and its description cannot disagree.
 */

import { isPluginInstance, type PluginInstance } from './instance.js';

/** The structural shape of a plugin that reports liveness through `describe()`. */
interface LiveDescriptor {
  readonly describe?: () => { readonly needsLive?: boolean } | undefined;
}

function describesLive(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object') return false;
  const describe = (entry as LiveDescriptor).describe;
  if (typeof describe !== 'function') return false;
  try {
    return describe()?.needsLive === true;
  } catch {
    return true;
  }
}

function touchesLiveToken(instance: PluginInstance): boolean {
  return [...instance.provides, ...instance.requires].some((token) => token.live);
}

/**
 * The entries of `entries` that only work in a live process, in their
 * original order.
 */
export function selectLiveOnly<T>(entries: readonly T[]): readonly T[] {
  const live = new Set<T>(
    entries.filter((entry) =>
      isPluginInstance(entry) ? touchesLiveToken(entry) : describesLive(entry),
    ),
  );
  const instances = entries.filter(isPluginInstance) as (T & PluginInstance)[];
  let changed = true;
  while (changed) {
    changed = false;
    for (const instance of instances) {
      if (live.has(instance)) continue;
      const stranded = instance.requires.some((token) => {
        const providers = instances.filter((candidate) => candidate.provides.includes(token));
        return providers.length > 0 && providers.every((provider) => live.has(provider));
      });
      if (stranded) {
        live.add(instance);
        changed = true;
      }
    }
  }
  return Object.freeze(entries.filter((entry) => live.has(entry)));
}
