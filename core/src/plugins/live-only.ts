/**
 * Live-only plugin introspection.
 *
 * A plugin declares `needsLive: true` in its `describe()` when it cannot run
 * under a `static` shape. Three places must agree on that set:
 *
 * - the runtime shape filter (`src/app/application.ts`), which drops it;
 * - `jsails describe` (`plugins.liveOnly`);
 * - `jsails app:shape` (which reports what a target shape drops).
 *
 * This module is the single source of that check, so the report and the runtime
 * can never disagree. It reads only `config.extensions` (already-constructed
 * objects): `plugins.use` entries are bare specifiers that the read-only
 * commands never import, so a live-declared plugin reached *only* through `use`
 * is not reported — an honest limitation shared by both commands.
 */

/** The minimal structural shape this module reads from a plugin. */
interface LiveDescriptor {
  readonly describe?: () => { readonly needsLive?: boolean };
}

/**
 * Whether a plugin is live-only.
 *
 * Fails closed to `true` when `describe()` throws: the runtime shape filter
 * treats a throwing descriptor as live (`describeRuntime` in
 * `src/app/application.ts`), so such a plugin IS dropped under `static` — and
 * the report must say so rather than silently omitting it.
 */
function isLiveOnlyPlugin(plugin: unknown): boolean {
  if (typeof plugin !== 'object' || plugin === null) return false;
  const describe = (plugin as LiveDescriptor).describe;
  if (typeof describe !== 'function') return false;
  try {
    return describe()?.needsLive === true;
  } catch {
    return true;
  }
}

/**
 * The live-only plugin ids among a resolved app config's constructed
 * extensions, trimmed and frozen in declaration order.
 */
export function collectLiveOnlyPluginIds(config: {
  readonly extensions: readonly unknown[];
}): readonly string[] {
  const ids: string[] = [];
  for (const extension of config.extensions) {
    if (!isLiveOnlyPlugin(extension)) continue;
    const name = (extension as { readonly name?: unknown }).name;
    if (typeof name === 'string' && name.trim() !== '') {
      ids.push(name.trim());
    }
  }
  return Object.freeze(ids);
}
