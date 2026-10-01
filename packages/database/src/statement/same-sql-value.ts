/**
 * Equality of bound values as the database stores them: bytes by content,
 * an integer the same whether it is a `number` or a `bigint`, everything
 * else by identity. The tenant policy compares a row's tenant with the
 * current one through it, and so does the coverage checker.
 */

import type { SqlValue } from '../engine/contract.js';

function integral(value: SqlValue): value is number | bigint {
  return typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value));
}

/** Whether two bound values are the same stored value. */
export function sameSqlValue(a: SqlValue, b: SqlValue): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length) {
      return false;
    }
    return a.every((byte, index) => byte === b[index]);
  }
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return integral(a) && integral(b) && BigInt(a) === BigInt(b);
  }
  return a === b;
}
