/**
 * Serialization of the plugin manager's writes to one plugin state source.
 *
 * Enable/disable and settings saves are load-modify-save of the whole state
 * document, and the installer rewrites the same document. Two overlapping
 * mutations would otherwise each save their own copy and the later one would
 * drop the earlier change (for example a just-recorded install entry). Every
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
