/**
 * `renderList`, the loop a compiled `js-for` calls: `item in items` over an
 * array or any iterable, `(value, key, index) in record` over an object's own
 * enumerable string keys, and `n in 10` over the numbers 1 to 10.
 *
 * Browser-safe and dependency-free. A `null` or `undefined` source renders
 * nothing, as an empty list does, and nothing here throws.
 */

/**
 * Render `render(n, index)` for `n` from 1 to `count` (`js-for="n in 10"`).
 *
 * @public
 */
export function renderList<R>(count: number, render: (value: number, index: number) => R): R[];
/**
 * Render `render(item, index)` for each item of an array, string, `Map`,
 * `Set` or other iterable, in iteration order.
 *
 * @public
 */
export function renderList<T, R>(
  source: Iterable<T> | null | undefined,
  render: (item: T, index: number) => R,
): R[];
/**
 * Render `render(value, key, index)` for each own enumerable string key of a
 * plain object, in `Object.keys` order.
 *
 * @public
 */
export function renderList<T extends object, R>(
  source: T | null | undefined,
  render: (value: T[keyof T & string], key: keyof T & string, index: number) => R,
): R[];
export function renderList(source: unknown, render: (...args: never[]) => unknown): unknown[] {
  const call = render as (value: unknown, keyOrIndex: unknown, index?: number) => unknown;
  const rendered: unknown[] = [];
  if (typeof source === 'number') {
    for (let index = 0; index < source; index += 1) {
      rendered.push(call(index + 1, index));
    }
  } else if (typeof source === 'string' || isIterable(source)) {
    let index = 0;
    for (const item of source as Iterable<unknown>) {
      rendered.push(call(item, index));
      index += 1;
    }
  } else if (source !== null && typeof source === 'object') {
    let index = 0;
    for (const key of Object.keys(source)) {
      rendered.push(call((source as Record<string, unknown>)[key], key, index));
      index += 1;
    }
  }
  return rendered;
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function'
  );
}
