/**
 * A write session: what one write of the pipeline (a record save or destroy,
 * or a set write) and its effects share. It runs statements in the write's
 * query context under the ambient tenant scope, reads the effect plans from
 * the data source's full catalog, collects the write's change records, and
 * hands them to the change feed once the write's work is done, inside its
 * transaction, so they are delivered after the outermost commit. What the
 * write changed in memory (a record's state, an attachment it remembers as
 * saved) is undone when the transaction it ran in rolls back, the write's
 * own or the caller's (`onRollback`).
 */

import { decodeColumn, type CodecColumn, type ModelCodecs } from '../../codec/model-codecs.js';
import type { ChangeEmitter } from '../../change/change-feed.js';
import { changeRecord, type ChangeKey, type ChangeRecord } from '../../change/change-record.js';
import type { Engine, QueryResult } from '../../engine/contract.js';
import type { Statement } from '../../engine/statement.js';
import { runStatement, type QueryContext } from '../../query/query-context.js';
import type { StatementCatalog } from '../../statement/statement-catalog.js';
import { currentTenantScope } from '../../statement/tenant-scope.js';
import { boundFrame } from '../../transaction/transaction-scope.js';
import { internalsOf, type DataSourceInternals } from '../data-source.js';
import { effectPlan, type EffectPlan } from './plan.js';

/** The data-source parts a write needs, resolved once. */
export interface WriteSession {
  readonly context: QueryContext;
  readonly internals: DataSourceInternals;
  readonly engine: Engine;
  readonly emitter: ChangeEmitter;
  /** Run `statement` in the write's context. */
  run(statement: Statement): Promise<QueryResult>;
  /** The plan of a model, from the data source's full catalog. */
  plan(codecs: ModelCodecs): EffectPlan;
  /** Collect a change record of `codecs`' model, if anyone listens. */
  record(codecs: ModelCodecs, op: ChangeRecord['op'], key?: ChangeKey, tenant?: unknown): void;
  /** The tenant a set write on `codecs`' model ran for: the scope's, unless unscoped. */
  scopeTenant(codecs: ModelCodecs): unknown;
  /** Hand the collected records to the feed. */
  flush(): Promise<void>;
  /**
   * Run `undo` if the transaction the write runs in rolls back, including an
   * enclosing one after the write's frame released. Undos run newest first
   * and before any afterRollback callback, so two writes of one record in a
   * transaction are undone back to the state before the first. Directly
   * under a `withTestTransaction` root, or outside any transaction, a write
   * that returned has committed, so there is nothing to undo.
   */
  onRollback(undo: () => void): void;
}

/** The tenant value of a record for its change records, when the model is tenant-scoped. */
export function recordTenant(tenant: CodecColumn | undefined, record: object): unknown {
  return tenant === undefined ? undefined : (record as Record<string, unknown>)[tenant.property];
}

/**
 * The current tenant as `codecs`' tenant column holds it, when the model is
 * tenant-scoped and the scope is on with a tenant.
 */
export function scopeTenant(catalog: StatementCatalog, codecs: ModelCodecs): unknown {
  const tenant = catalog.tenant(codecs.spec.table);
  if (tenant === undefined) return undefined;
  const scope = currentTenantScope();
  if (scope.unscoped || scope.tenantId === undefined) return undefined;
  return decodeColumn(
    codecs.property(tenant.property) as CodecColumn,
    tenant.encode(scope.tenantId),
  );
}

function isTenant(value: unknown): value is string | number | bigint {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint';
}

/** A session for a write in `context`. */
export async function openSession(context: QueryContext): Promise<WriteSession> {
  const internals = internalsOf(context.dataSource);
  internals.assertOpen();
  const engine = await internals.engine();
  const emitter = internals.changes;
  const catalog: StatementCatalog = internals.catalog;
  const collected: ChangeRecord[] = [];
  return Object.freeze({
    context,
    internals,
    engine,
    emitter,
    run: (statement: Statement) => runStatement(context, statement),
    plan: (codecs: ModelCodecs) => effectPlan(catalog, codecs),
    record: (codecs: ModelCodecs, op: ChangeRecord['op'], key?: ChangeKey, tenant?: unknown) => {
      if (!emitter.active) return;
      const scoped = codecs.spec.tenant !== undefined && isTenant(tenant) ? tenant : undefined;
      collected.push(changeRecord(codecs.spec.table, op, key, scoped));
    },
    scopeTenant: (codecs: ModelCodecs) => scopeTenant(catalog, codecs),
    flush: async () => {
      const records = collected.splice(0);
      await emitter.emit(engine, records);
    },
    onRollback: (undo: () => void) => {
      const frame = boundFrame(engine);
      if (frame !== undefined && !frame.virtualRoot) frame.registerUndo(undo);
    },
  });
}
