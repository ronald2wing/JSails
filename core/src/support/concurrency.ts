/**
 * Concurrency limiter: runs at most `concurrency` tasks at once.
 *
 * Returns a function that runs at most `concurrency` tasks at once; extra calls
 * queue and start as slots free. Rejections free the slot and propagate to the
 * caller.
 */

type Limiter = <T>(fn: () => Promise<T> | T) => Promise<T>;

/** Create a limiter that runs at most `concurrency` tasks at once. */
export function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    active -= 1;
    const next = queue.shift();
    if (next !== undefined) next();
  };

  return <T>(fn: () => Promise<T> | T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = (): void => {
        active += 1;
        Promise.resolve()
          .then(fn)
          .then(
            (value) => {
              resolve(value);
              release();
            },
            (error: unknown) => {
              reject(error);
              release();
            },
          );
      };

      if (active < concurrency) run();
      else queue.push(run);
    });
}
