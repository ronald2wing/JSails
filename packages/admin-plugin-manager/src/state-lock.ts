/**
 * Serialization of the plugin manager's writes to one plugin state source.
 *
 * Enable/disable, settings saves, and the installer each write only the one
 * plugin entry they change, so no mutation can drop another plugin's entry.
 * Each is still a load-modify-write of that one entry, though: two overlapping
 * mutations of the same plugin (a toggle during its upgrade) would each write
 * their own copy and the later one would revert the earlier change. Every
 * mutation the plugin manager starts, installer calls included, runs through
 * {@link withStateLock} keyed by the state source, so they apply one after
 * another within this process.
 */

/** The tail of each state source's mutation chain. */
const chains = new WeakMap<object, Promise<unknown>>();

/**
 * Run `task` after every earlier task for the same `source` has settled
 * (success or failure), and return its result.
 */
export function withStateLock<T>(source: object, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(source) ?? Promise.resolve();
  const run = previous.then(task, task);
  chains.set(
    source,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
