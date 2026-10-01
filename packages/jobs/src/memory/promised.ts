/**
 * The in-memory stores answer synchronously but implement promise-returning
 * capabilities: `promised` runs one operation and turns a thrown refusal into
 * a rejection, so a caller never sees a synchronous throw.
 */

/** Run `operation`, turning a thrown refusal into a rejection. */
export function promised<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error);
  }
}
