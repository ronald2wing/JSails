/**
 * Coalescing: the records of one commit folded to what a consumer needs to
 * know, per collection, tenant and key: the key records in the order each key
 * first changed, then the invalidations.
 *
 * - insert, then update: insert. insert, then delete: nothing (no other
 *   session ever saw the row).
 * - update, then update: update. update, then delete: delete.
 * - delete, then insert: update (the row was replaced).
 * - An `invalidate` absorbs every key record of its collection for its tenant
 *   (an `invalidate` without a tenant absorbs every tenant's), and repeated
 *   ones fold into one.
 */

import { keyIdentity, type ChangeOp, type ChangeRecord } from './change-record.js';

function tenantIdentity(record: ChangeRecord): string {
  return record.tenant === undefined ? '*' : `${typeof record.tenant}:${record.tenant}`;
}

/** The op a key ends with after `next` follows `current`; `undefined` when nothing is left. */
function fold(current: ChangeOp | undefined, next: ChangeOp): ChangeOp | undefined {
  if (current === undefined) return next;
  if (current === 'insert') return next === 'delete' ? undefined : 'insert';
  if (current === 'delete') return next === 'insert' ? 'update' : 'delete';
  return next === 'delete' ? 'delete' : 'update';
}

interface Slot {
  readonly record: ChangeRecord;
  op: ChangeOp | undefined;
}

/** The records of one commit, coalesced. */
export function coalesceChanges(records: readonly ChangeRecord[]): readonly ChangeRecord[] {
  const invalidated = new Map<string, Set<string>>();
  const invalidations: ChangeRecord[] = [];
  for (const record of records) {
    if (record.op !== 'invalidate') continue;
    let tenants = invalidated.get(record.collection);
    if (tenants === undefined) {
      tenants = new Set();
      invalidated.set(record.collection, tenants);
    }
    const tenant = tenantIdentity(record);
    if (tenants.has(tenant)) continue;
    tenants.add(tenant);
    invalidations.push(record);
  }
  const absorbed = (record: ChangeRecord): boolean => {
    const tenants = invalidated.get(record.collection);
    return tenants !== undefined && (tenants.has('*') || tenants.has(tenantIdentity(record)));
  };
  const slots = new Map<string, Slot>();
  for (const record of records) {
    if (record.op === 'invalidate' || record.key === undefined || absorbed(record)) continue;
    const identity = `${record.collection}\u0000${tenantIdentity(record)}\u0000${keyIdentity(record.key)}`;
    const slot = slots.get(identity);
    if (slot === undefined) slots.set(identity, { record, op: record.op });
    else slot.op = fold(slot.op, record.op);
  }
  const keyed: ChangeRecord[] = [];
  for (const { record, op } of slots.values()) {
    if (op === undefined) continue;
    keyed.push(op === record.op ? record : Object.freeze({ ...record, op }));
  }
  const invalidTenants = (record: ChangeRecord): boolean =>
    record.tenant !== undefined && invalidated.get(record.collection)?.has('*') === true;
  return Object.freeze([...keyed, ...invalidations.filter((record) => !invalidTenants(record))]);
}
