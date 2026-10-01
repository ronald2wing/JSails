/**
 * Change records: what the write pipeline reports about a committed write,
 * keys only. A record names the collection (the model's table, unique within
 * a data source), what happened, the primary key of the row when the write
 * knew it, and the tenant the write ran for on a tenant-scoped model. It
 * never carries a column value, so a consumer that needs the row reads it
 * again under its own access rules.
 *
 * `invalidate` says "rows of this collection changed and the write cannot say
 * which": a set write whose condition is not a primary-key lookup, a
 * dependent nullified or destroyed by condition, and every row a database
 * foreign-key action changed.
 */

/** What happened to the rows a record names. */
export type ChangeOp = 'insert' | 'update' | 'delete' | 'invalidate';

/**
 * A primary-key value as the application holds it: the value of a one-column
 * key, or a frozen object naming each column of a composite key.
 */
export type ChangeKey = string | number | bigint | Uint8Array | Readonly<Record<string, unknown>>;

/** The tenant a record belongs to, as the tenant column holds it. */
export type ChangeTenant = string | number | bigint;

/** One committed change, keys only. */
export interface ChangeRecord {
  /** The model's table. */
  readonly collection: string;
  readonly op: ChangeOp;
  /** The row's primary key; absent for `invalidate`. */
  readonly key?: ChangeKey;
  /** The tenant of the write on a tenant-scoped model; absent when the write was unscoped. */
  readonly tenant?: ChangeTenant;
}

/** A frozen record; `key` and `tenant` only when given. */
export function changeRecord(
  collection: string,
  op: ChangeOp,
  key?: ChangeKey,
  tenant?: ChangeTenant,
): ChangeRecord {
  return Object.freeze({
    collection,
    op,
    ...(key === undefined ? {} : { key }),
    ...(tenant === undefined ? {} : { tenant }),
  });
}

function scalarIdentity(value: unknown): string {
  if (typeof value === 'bigint') return `b:${value}`;
  if (typeof value === 'number') return `n:${value}`;
  if (typeof value === 'string') return `s:${value}`;
  if (value instanceof Uint8Array) return `x:${Buffer.from(value).toString('hex')}`;
  if (value instanceof Date) return `d:${value.getTime()}`;
  return `j:${JSON.stringify(value)}`;
}

/** A string that two equal keys, and only they, share. */
export function keyIdentity(key: ChangeKey): string {
  if (typeof key === 'object' && !(key instanceof Uint8Array)) {
    return `{${Object.keys(key)
      .toSorted()
      .map((name) => `${name}=${scalarIdentity(key[name])}`)
      .join(',')}}`;
  }
  return scalarIdentity(key);
}
