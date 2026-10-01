/**
 * The statement catalog: everything the guarded compiler knows about the
 * models of one data source on one dialect. It maps each physical table to
 * its model and, for a tenant-scoped model, to its tenant column and the
 * encoder of a tenant id into that column's stored form; it builds each
 * model's column codecs on first use and keeps them.
 *
 * The table list is closed: a statement naming a table the catalog does not
 * know is refused by the guarded compiler, so a tenant-scoped table left out
 * of the model list can never be read unscoped. Link tables of `through`
 * relations are models too (`defineTable`), and belong in the list.
 */

import type { Dialect, SqlValue } from '../engine/contract.js';
import { modelCodecs, type ModelCodecs } from '../codec/model-codecs.js';
import type { SealProvider } from '../codec/seal-provider.js';
import { modelDefinition } from '../model/define-model.js';
import { ColumnValueError } from '../model/model-error.js';
import type { ModelTarget, NormalizedSpec, ResolvedColumn } from '../model/model-spec.js';
import { portableCodec } from '../model/portable-codec.js';
import { StatementErrors, TenantScopeErrors } from './statement-errors.js';
import type { TenantId } from './tenant-scope.js';

/** The tenant column of a tenant-scoped table. */
export interface TenantTable {
  readonly table: string;
  /** The physical tenant column. */
  readonly column: string;
  /** The model property of the tenant column. */
  readonly property: string;
  /**
   * The stored form of `tenantId` in this column.
   *
   * @throws `tenant_scope.invalid_tenant` for an id the column cannot store.
   */
  encode(tenantId: TenantId): SqlValue;
}

/** What the tenant policy needs to know about tables. */
export interface PolicyTables {
  /** Whether the catalog declares `table`. */
  has(table: string): boolean;
  /** The tenant column of `table`, or `undefined` when it is not tenant-scoped. */
  tenant(table: string): TenantTable | undefined;
}

/** The models of one data source on one dialect. */
export interface StatementCatalog extends PolicyTables {
  readonly dialect: Dialect;
  readonly models: readonly ModelTarget[];
  /** The model of a physical table, or `undefined`. */
  model(table: string): ModelTarget | undefined;
  /**
   * The column codecs of `target`, built on first use.
   *
   * @throws `statement.unknown_table` for a model outside the catalog.
   */
  codecs(target: ModelTarget): ModelCodecs;
}

/** Options of {@link createStatementCatalog}. */
export interface StatementCatalogOptions {
  readonly dialect: Dialect;
  /** Every model and link table the data source reads or writes. */
  readonly models: readonly ModelTarget[];
  /** Builds the seal layer of encrypted columns (the encryption keyring). */
  readonly seal?: SealProvider;
}

const INTEGER_TEXT = /^-?\d+$/;

/** A tenant id as the application value of a column of `column`'s type, if it has one. */
function tenantValue(column: ResolvedColumn, tenantId: TenantId): unknown {
  switch (column.type.kind) {
    case 'id':
    case 'integer':
      if (typeof tenantId === 'number') return tenantId;
      return INTEGER_TEXT.test(tenantId) ? Number(tenantId) : undefined;
    case 'bigint':
      if (typeof tenantId === 'number') {
        return Number.isSafeInteger(tenantId) ? BigInt(tenantId) : undefined;
      }
      return INTEGER_TEXT.test(tenantId) ? BigInt(tenantId) : undefined;
    default:
      return typeof tenantId === 'number' ? String(tenantId) : tenantId;
  }
}

function tenantTable(spec: NormalizedSpec, dialect: Dialect): TenantTable | undefined {
  if (spec.tenant === undefined) return undefined;
  const column = spec.columns.find((candidate) => candidate.property === spec.tenant);
  if (column === undefined) return undefined;
  const codec = portableCodec(column.type, dialect, column.property);
  const table = spec.table;
  return Object.freeze({
    table,
    column: column.column,
    property: column.property,
    encode: (tenantId: TenantId): SqlValue => {
      const value = tenantValue(column, tenantId);
      if (value === undefined || (typeof value === 'number' && !Number.isSafeInteger(value))) {
        throw new TenantScopeErrors.Error('invalid_tenant', { table });
      }
      try {
        return codec.encode(value as never);
      } catch (error) {
        if (error instanceof ColumnValueError) {
          throw new TenantScopeErrors.Error('invalid_tenant', { table });
        }
        throw error;
      }
    },
  });
}

/**
 * The catalog of `options.models` on `options.dialect`.
 *
 * @throws `statement.invalid_catalog` for a target that is not a model, and
 *   `statement.duplicate_table` for two models of one table.
 */
export function createStatementCatalog(options: StatementCatalogOptions): StatementCatalog {
  const { dialect, seal } = options;
  if (dialect !== 'postgres' && dialect !== 'mariadb' && dialect !== 'sqlite') {
    throw new StatementErrors.Error('invalid_catalog', { field: 'dialect' });
  }
  if (!Array.isArray(options.models)) {
    throw new StatementErrors.Error('invalid_catalog', { field: 'models' });
  }
  const byTable = new Map<string, ModelTarget>();
  const tenants = new Map<string, TenantTable>();
  const known = new Set<ModelTarget>();
  for (const target of options.models) {
    const definition = modelDefinition(target);
    if (definition === undefined) {
      throw new StatementErrors.Error('invalid_catalog', { field: 'models' });
    }
    if (known.has(target)) continue;
    const { spec } = definition;
    if (byTable.has(spec.table)) {
      throw new StatementErrors.Error('duplicate_table', { table: spec.table });
    }
    known.add(target);
    byTable.set(spec.table, target);
    const tenant = tenantTable(spec, dialect);
    if (tenant !== undefined) tenants.set(spec.table, tenant);
  }
  const codecs = new Map<ModelTarget, ModelCodecs>();
  return Object.freeze({
    dialect,
    models: Object.freeze([...known]),
    has: (table: string) => byTable.has(table),
    tenant: (table: string) => tenants.get(table),
    model: (table: string) => byTable.get(table),
    codecs: (target: ModelTarget): ModelCodecs => {
      let built = codecs.get(target);
      if (built === undefined) {
        if (!known.has(target)) {
          const name = modelDefinition(target)?.spec.table ?? 'unknown';
          throw new StatementErrors.Error('unknown_table', { table: name });
        }
        built = modelCodecs(target, dialect, seal === undefined ? {} : { seal });
        codecs.set(target, built);
      }
      return built;
    },
  });
}
