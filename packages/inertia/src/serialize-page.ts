/**
 * The strict page serializer.
 *
 * Only plain data reaches the browser. Allowed: strings, booleans, finite
 * numbers, `null`, plain and null-prototype objects, arrays, valid `Date`s
 * (sent as ISO-8601 strings), and `bigint`s, sent as `{ "$bigint": "digits" }`
 * with `preserveBigIntegers: true` on the page so @inertiajs/core's
 * `parsePage` revives them (`@inertiajs/core/json`). `undefined` drops an
 * object key and becomes `null` in an array, as in `JSON.stringify`.
 *
 * Everything else fails closed in every environment with the value-free
 * `unserializable_prop`, carrying the path (`props.user.tags.2`):
 * class instances (ORM records included, so hidden columns can never leak),
 * `Map`, `Set`, functions, symbols, objects with a `toJSON` function,
 * non-finite numbers, invalid `Date`s, cycles, prop descriptors that were
 * never resolved, the prototype keys `__proto__`/`constructor`/`prototype`,
 * and any object with its own `$bigint` key: the client would revive it into
 * a `BigInt` (or throw on non-digits), silently changing the data's type.
 */

import { InertiaError } from './inertia-error.js';
import type { InertiaPageObject } from './page.js';
import { FORBIDDEN_KEYS, isPlainObject } from './plain-data.js';
import { isInertiaProp } from './props.js';

/** The key @inertiajs/core revives into a `BigInt`. */
export const BIGINT_MARKER = '$bigint';

const OMIT: unique symbol = Symbol('omit');

/** Serialize a page object to JSON, rejecting anything that is not plain data. */
export function serializePage(page: InertiaPageObject): string {
  const encoder = new Encoder();
  const encoded = encoder.encode(page, '');
  if (!isPlainObject(encoded)) throw new InertiaError('unserializable_prop');
  return JSON.stringify(encoder.sawBigInt ? { ...encoded, preserveBigIntegers: true } : encoded);
}

class Encoder {
  sawBigInt = false;
  private readonly ancestors = new Set<object>();

  encode(value: unknown, path: string): unknown {
    switch (typeof value) {
      case 'string':
      case 'boolean':
        return value;
      case 'number':
        if (!Number.isFinite(value)) throw unserializable(path);
        return value;
      case 'bigint':
        this.sawBigInt = true;
        return { [BIGINT_MARKER]: value.toString() };
      case 'undefined':
        return OMIT;
      case 'object':
        return value === null ? null : this.encodeObject(value, path);
      default:
        throw unserializable(path);
    }
  }

  private encodeObject(value: object, path: string): unknown {
    if (value instanceof Date && Object.getPrototypeOf(value) === Date.prototype) {
      if (Number.isNaN(value.getTime())) throw unserializable(path);
      return value.toISOString();
    }
    if (this.ancestors.has(value)) throw unserializable(path);
    if (Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype) {
      return this.within(value, () => {
        const items: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const item = this.encode(value[index] as unknown, join(path, String(index)));
          items.push(item === OMIT ? null : item);
        }
        return items;
      });
    }
    if (!isPlainObject(value) || isInertiaProp(value)) throw unserializable(path);
    return this.within(value, () => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const keyPath = join(path, key);
        if (FORBIDDEN_KEYS.has(key) || key === BIGINT_MARKER) throw unserializable(keyPath);
        const item = this.encode(value[key], keyPath);
        if (item !== OMIT) out[key] = item;
      }
      return out;
    });
  }

  private within<T>(value: object, encode: () => T): T {
    this.ancestors.add(value);
    try {
      return encode();
    } finally {
      this.ancestors.delete(value);
    }
  }
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function unserializable(path: string): InertiaError {
  return new InertiaError('unserializable_prop', path === '' ? {} : { path });
}
