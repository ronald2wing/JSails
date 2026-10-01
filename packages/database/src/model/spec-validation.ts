/**
 * The spec validator: checks a {@link ModelSpec} against every rule that
 * needs only the spec itself, makes each derived column explicit (the
 * generated `id`, foreign keys, polymorphic pairs, `lockVersion`) and returns
 * a deep-frozen {@link NormalizedSpec}. Rules that need a relation's target
 * (its primary-key type, the inverse relation) are checked by
 * `physicalTable`, since targets are thunks that may not be loaded yet.
 *
 * Rules held here: physical names are portable identifiers and unique; every
 * type is portable and in range; defaults encode on every dialect (a uuid
 * column takes none, see `checkDefault`); the primary key is non-null and
 * indexable; a tenant column is a non-null,
 * unencrypted key column, and every unique index (and a composite primary
 * key) includes it unless marked `global`; an index names known, indexable
 * columns and its worst-case key fits every dialect; an encrypted column has
 * a supported type, a bounded envelope when deterministic, and is indexed
 * only when deterministic and narrow enough; an `enum` is a non-empty list of
 * distinct values a `string` column stores, its default among them; a data
 * contract sits only on a `json` column; the worst-case row fits MariaDB's
 * row size; `autosave` is `true` or unset on a direct relation; an attachment
 * is a property of its own on a model with a one-column primary key.
 */

import { ColumnValueError, ModelSpecError } from './model-error.js';
import { indexName, PHYSICAL_NAME, PROPERTY_NAME, snakeCase } from './model-naming.js';
import type {
  AttachmentSpec,
  ColumnDataContract,
  ColumnDefault,
  ColumnSpec,
  EncryptionSpec,
  IndexSpec,
  NormalizedSpec,
  RelationSpec,
  ResolvedColumn,
  ResolvedIndex,
} from './model-spec.js';
import { ENCRYPTION_ENVELOPE_OVERHEAD, encryptedStorage } from './encrypted-storage.js';
import { isStorableText, portableCodec } from './portable-codec.js';
import {
  indexEntryBytes,
  indexKeyBytes,
  MAX_BINARY_LENGTH,
  MAX_INDEX_KEY_BYTES,
  MAX_ROW_BYTES,
  plaintextBytes,
  portableType,
  rowBytes,
  type PortableType,
} from './portable-type.js';

const SPEC_KEYS = new Set([
  'table',
  'name',
  'columns',
  'primaryKey',
  'relations',
  'indexes',
  'tenant',
  'lockVersion',
  'attachments',
]);
const COLUMN_KEYS = new Set(['type', 'nullable', 'default', 'column', 'encrypted', 'enum', 'data']);
const ENCRYPTION_KEYS = new Set(['mode', 'maxLength', 'acceptPlaintext', 'aad']);
const INDEX_KEYS = new Set(['columns', 'unique', 'name', 'global']);
const BELONGS_TO_KEYS = new Set([
  'kind',
  'target',
  'foreignKey',
  'column',
  'nullable',
  'onDelete',
  'index',
  'counterCache',
  'touch',
  'autosave',
]);
const POLYMORPHIC_KEYS = new Set(['kind', 'polymorphic', 'nullable', 'index']);
const INVERSE_KEYS = new Set(['kind', 'target', 'inverse', 'dependent', 'autosave']);
const ATTACHMENT_KEYS = new Set(['kind']);
const THROUGH_KEYS = new Set(['kind', 'target', 'through', 'source']);
const ENCRYPTABLE: ReadonlySet<PortableType['kind']> = new Set([
  'string',
  'text',
  'json',
  'integer',
  'bigint',
  'decimal',
  'float',
]);
const TENANT_TYPES: ReadonlySet<PortableType['kind']> = new Set([
  'id',
  'integer',
  'bigint',
  'string',
  'uuid',
]);
const KEY_UNSUITABLE: ReadonlySet<PortableType['kind']> = new Set(['float', 'json', 'text']);
const MODEL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
/** The polymorphic type column holds a model name. */
const POLYMORPHIC_TYPE: PortableType = Object.freeze({ kind: 'string', length: 100 });
const ID: PortableType = Object.freeze({ kind: 'id' });
const INTEGER: PortableType = Object.freeze({ kind: 'integer' });
const DIALECTS = ['postgres', 'mariadb', 'sqlite'] as const;

type Fields = Readonly<Record<string, unknown>>;

class Checker {
  constructor(readonly model: string) {}

  fail(code: ConstructorParameters<typeof ModelSpecError>[0], field?: string): never {
    throw new ModelSpecError(code, { model: this.model, field });
  }

  record(value: unknown, field: string): Fields {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.fail('invalid_spec', field);
    }
    return value as Fields;
  }

  keys(value: Fields, allowed: ReadonlySet<string>, field: string): void {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) this.fail('invalid_spec', `${field}.${key}`);
    }
  }

  optionalTrue(value: unknown, field: string): boolean {
    if (value === undefined) return false;
    if (value !== true) this.fail('invalid_spec', field);
    return true;
  }

  optionalBoolean(value: unknown, field: string): boolean {
    if (value === undefined) return false;
    if (typeof value !== 'boolean') this.fail('invalid_spec', field);
    return value;
  }

  property(value: unknown, field: string): string {
    if (typeof value !== 'string' || !PROPERTY_NAME.test(value)) {
      this.fail('invalid_identifier', field);
    }
    return value;
  }

  physical(value: unknown, field: string): string {
    if (typeof value !== 'string' || !PHYSICAL_NAME.test(value)) {
      this.fail('invalid_identifier', field);
    }
    return value;
  }
}

function checkEncryption(
  check: Checker,
  value: unknown,
  type: PortableType,
  field: string,
): EncryptionSpec {
  const spec = check.record(value, field);
  check.keys(spec, ENCRYPTION_KEYS, field);
  if (!ENCRYPTABLE.has(type.kind)) check.fail('invalid_encryption', field);
  const mode = spec.mode;
  if (mode !== 'deterministic' && mode !== 'random') check.fail('invalid_encryption', field);
  const result: { -readonly [K in keyof EncryptionSpec]: EncryptionSpec[K] } = { mode };
  if (spec.maxLength !== undefined) {
    const max = spec.maxLength;
    if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1) {
      check.fail('invalid_encryption', field);
    }
    result.maxLength = max;
  }
  if (check.optionalTrue(spec.acceptPlaintext, `${field}.acceptPlaintext`)) {
    result.acceptPlaintext = true;
  }
  if (spec.aad !== undefined) {
    const aad = spec.aad;
    if (typeof aad !== 'string' || aad === '' || aad.length > 255 || !isStorableText(aad)) {
      check.fail('invalid_encryption', `${field}.aad`);
    }
    result.aad = aad;
  }
  const own = plaintextBytes(type);
  if (result.maxLength !== undefined && own !== undefined && result.maxLength > own) {
    check.fail('invalid_encryption', `${field}.maxLength`);
  }
  const capacity = result.maxLength ?? own;
  if (mode === 'deterministic' && capacity === undefined) check.fail('invalid_encryption', field);
  if (capacity !== undefined && capacity + ENCRYPTION_ENVELOPE_OVERHEAD > MAX_BINARY_LENGTH) {
    check.fail('invalid_encryption', field);
  }
  return Object.freeze(result);
}

function checkDefault(
  check: Checker,
  value: unknown,
  type: PortableType,
  field: string,
): ColumnDefault {
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length !== 1 || (value as Fields).now !== true || type.kind !== 'timestamp') {
      check.fail('invalid_default', field);
    }
    return Object.freeze({ now: true });
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    check.fail('invalid_default', field);
  }
  let probe: unknown = value;
  if (type.kind === 'bigint') {
    if (typeof value === 'boolean') check.fail('invalid_default', field);
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      check.fail('invalid_default', field);
    }
    if (typeof value === 'string' && !/^-?\d+$/.test(value)) check.fail('invalid_default', field);
    probe = BigInt(value);
  }
  if (type.kind === 'timestamp') check.fail('invalid_default', field);
  // MariaDB stores a uuid as binary(16), and its catalog reports a binary
  // default through a character set that mangles it, so the schema could
  // never confirm such a default was applied.
  if (type.kind === 'uuid') check.fail('invalid_default', field);
  for (const dialect of DIALECTS) {
    try {
      portableCodec(type, dialect).encode(probe as never);
    } catch (error) {
      if (error instanceof ColumnValueError) check.fail('invalid_default', field);
      throw error;
    }
  }
  return value;
}

/** The type a column is stored as: its own, or `binary` when encrypted. */
export function storedType(column: ResolvedColumn): PortableType {
  return column.encrypted === undefined
    ? column.type
    : encryptedStorage(column.type, column.encrypted);
}

interface Columns {
  readonly list: ResolvedColumn[];
  readonly byProperty: Map<string, ResolvedColumn>;
}

function addColumn(check: Checker, columns: Columns, column: ResolvedColumn): void {
  if (columns.byProperty.has(column.property)) check.fail('duplicate_column', column.property);
  if (columns.list.some((existing) => existing.column === column.column)) {
    check.fail('duplicate_column', column.property);
  }
  columns.list.push(Object.freeze(column));
  columns.byProperty.set(column.property, column);
}

function declaredColumn(check: Checker, property: string, value: unknown): ResolvedColumn {
  const field = `columns.${property}`;
  const spec = check.record(value, field) as Partial<ColumnSpec>;
  check.keys(spec, COLUMN_KEYS, field);
  const type = portableType(spec.type, check.model, field);
  const nullable = check.optionalBoolean(spec.nullable, `${field}.nullable`);
  const physical =
    spec.column === undefined
      ? snakeCase(property)
      : check.physical(spec.column, `${field}.column`);
  if (!PHYSICAL_NAME.test(physical)) check.fail('invalid_identifier', field);
  const column: { -readonly [K in keyof ResolvedColumn]: ResolvedColumn[K] } = {
    property,
    column: physical,
    type,
    nullable,
    origin: 'declared',
  };
  if (spec.encrypted !== undefined) {
    column.encrypted = checkEncryption(check, spec.encrypted, type, `${field}.encrypted`);
  }
  if (spec.enum !== undefined) column.enum = checkEnum(check, spec.enum, type, `${field}.enum`);
  if (spec.data !== undefined) column.data = checkData(check, spec.data, type, `${field}.data`);
  if (spec.default !== undefined) {
    if (column.encrypted !== undefined) check.fail('invalid_default', `${field}.default`);
    column.default = checkDefault(check, spec.default, type, `${field}.default`);
    if (column.enum !== undefined && !column.enum.includes(column.default as string)) {
      check.fail('invalid_default', `${field}.default`);
    }
  }
  return column;
}

/** A non-empty list of distinct values a `string` column of `type` stores. */
function checkEnum(
  check: Checker,
  value: unknown,
  type: PortableType,
  field: string,
): readonly string[] {
  if (type.kind !== 'string' || !Array.isArray(value) || value.length === 0) {
    check.fail('invalid_spec', field);
  }
  const codec = portableCodec(type, 'postgres', field);
  const seen = new Set<string>();
  for (const member of value as readonly unknown[]) {
    if (typeof member !== 'string' || seen.has(member)) check.fail('invalid_spec', field);
    try {
      codec.encode(member);
    } catch (error) {
      if (error instanceof ColumnValueError) check.fail('invalid_spec', field);
      throw error;
    }
    seen.add(member);
  }
  return Object.freeze([...seen]);
}

/** A data contract on a `json` column: a name and a synchronous `safeParse`. */
function checkData(
  check: Checker,
  value: unknown,
  type: PortableType,
  field: string,
): ColumnDataContract {
  if (type.kind !== 'json' || value === null || typeof value !== 'object') {
    check.fail('invalid_spec', field);
  }
  const contract = value as Partial<ColumnDataContract>;
  const schema = contract.schema as Partial<ColumnDataContract['schema']> | null | undefined;
  if (
    typeof contract.name !== 'string' ||
    contract.name === '' ||
    schema === null ||
    typeof schema !== 'object' ||
    typeof schema.safeParse !== 'function'
  ) {
    check.fail('invalid_spec', field);
  }
  return contract as ColumnDataContract;
}

function checkRelation(check: Checker, name: string, value: unknown): RelationSpec {
  const field = `relations.${name}`;
  const spec = check.record(value, field);
  if (spec.kind === 'belongsTo') {
    if (spec.polymorphic !== undefined) {
      check.keys(spec, POLYMORPHIC_KEYS, field);
      if (spec.polymorphic !== true) check.fail('invalid_relation', field);
      check.optionalBoolean(spec.nullable, `${field}.nullable`);
      if (spec.index !== undefined && spec.index !== false) check.fail('invalid_relation', field);
      return Object.freeze({ ...spec }) as unknown as RelationSpec;
    }
    check.keys(spec, BELONGS_TO_KEYS, field);
    if (typeof spec.target !== 'function') check.fail('invalid_relation', `${field}.target`);
    if (spec.foreignKey !== undefined) check.property(spec.foreignKey, `${field}.foreignKey`);
    if (spec.column !== undefined) check.physical(spec.column, `${field}.column`);
    check.optionalBoolean(spec.nullable, `${field}.nullable`);
    const onDelete = spec.onDelete;
    if (onDelete !== undefined && onDelete !== 'cascade' && onDelete !== 'set null') {
      if (onDelete !== 'restrict') check.fail('invalid_relation', `${field}.onDelete`);
    }
    if (spec.index !== undefined && spec.index !== false) check.fail('invalid_relation', field);
    if (spec.counterCache !== undefined) check.property(spec.counterCache, `${field}.counterCache`);
    if (spec.touch !== undefined) check.property(spec.touch, `${field}.touch`);
    check.optionalTrue(spec.autosave, `${field}.autosave`);
    return Object.freeze({ ...spec }) as unknown as RelationSpec;
  }
  if (spec.kind !== 'hasMany' && spec.kind !== 'hasOne') check.fail('invalid_relation', field);
  if (typeof spec.target !== 'function') check.fail('invalid_relation', `${field}.target`);
  if (spec.through !== undefined) {
    check.keys(spec, THROUGH_KEYS, field);
    check.property(spec.through, `${field}.through`);
    check.property(spec.source, `${field}.source`);
    return Object.freeze({ ...spec }) as unknown as RelationSpec;
  }
  check.keys(spec, INVERSE_KEYS, field);
  if (spec.inverse === undefined) check.fail('invalid_relation', `${field}.inverse`);
  check.property(spec.inverse, `${field}.inverse`);
  const dependent = spec.dependent;
  if (dependent !== undefined && dependent !== 'nullify' && dependent !== 'destroy') {
    check.fail('invalid_relation', `${field}.dependent`);
  }
  check.optionalTrue(spec.autosave, `${field}.autosave`);
  return Object.freeze({ ...spec }) as unknown as RelationSpec;
}

function relationColumns(
  check: Checker,
  columns: Columns,
  name: string,
  relation: RelationSpec,
): void {
  if (relation.kind !== 'belongsTo') return;
  const field = `relations.${name}`;
  if ('polymorphic' in relation) {
    const nullable = relation.nullable === true;
    addColumn(check, columns, {
      property: `${name}Type`,
      column: snakeCase(`${name}Type`),
      type: POLYMORPHIC_TYPE,
      nullable,
      origin: 'polymorphic-type',
      relation: name,
    });
    addColumn(check, columns, {
      property: `${name}Id`,
      column: snakeCase(`${name}Id`),
      type: ID,
      nullable,
      origin: 'polymorphic-id',
      relation: name,
    });
    return;
  }
  const property = relation.foreignKey ?? `${name}Id`;
  const declared = columns.byProperty.get(property);
  if (declared !== undefined) {
    // A declared foreign-key column carries its own name and nullability.
    if (relation.column !== undefined || relation.nullable !== undefined) {
      check.fail('invalid_relation', field);
    }
    if (declared.origin !== 'declared' || declared.encrypted !== undefined) {
      check.fail('invalid_relation', field);
    }
    if (relation.onDelete === 'set null' && !declared.nullable) {
      check.fail('invalid_relation', `${field}.onDelete`);
    }
    const index = columns.list.indexOf(declared);
    const linked = Object.freeze({ ...declared, origin: 'foreign-key' as const, relation: name });
    columns.list[index] = linked;
    columns.byProperty.set(property, linked);
    return;
  }
  if (relation.onDelete === 'set null' && relation.nullable !== true) {
    check.fail('invalid_relation', `${field}.onDelete`);
  }
  addColumn(check, columns, {
    property,
    column: relation.column ?? snakeCase(property),
    type: ID,
    nullable: relation.nullable === true,
    origin: 'foreign-key',
    relation: name,
  });
}

function checkKeyColumn(check: Checker, column: ResolvedColumn | undefined, field: string): void {
  if (column === undefined) check.fail('unknown_column', field);
  if (column.nullable || column.encrypted !== undefined || KEY_UNSUITABLE.has(column.type.kind)) {
    check.fail('invalid_primary_key', field);
  }
  if (indexKeyBytes(column.type) === undefined) check.fail('invalid_primary_key', field);
}

/** The worst-case index entry over `columns` (see `indexEntryBytes`). */
function keyWidth(check: Checker, columns: readonly ResolvedColumn[], field: string): number {
  for (const column of columns) {
    if (column.encrypted?.mode === 'random') check.fail('encrypted_not_indexable', field);
    if (indexKeyBytes(storedType(column)) === undefined) {
      check.fail(
        column.encrypted === undefined ? 'unindexable_column' : 'encrypted_not_indexable',
        field,
      );
    }
  }
  return indexEntryBytes(columns.map(storedType)) ?? check.fail('unindexable_column', field);
}

function checkIndexes(
  check: Checker,
  table: string,
  value: unknown,
  columns: Columns,
  tenant: string | undefined,
): ResolvedIndex[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) check.fail('invalid_spec', 'indexes');
  const indexes: ResolvedIndex[] = [];
  value.forEach((item: unknown, position) => {
    const field = `indexes[${position}]`;
    const spec = check.record(item, field) as Partial<IndexSpec>;
    check.keys(spec, INDEX_KEYS, field);
    const properties = spec.columns;
    if (!Array.isArray(properties) || properties.length === 0) check.fail('invalid_index', field);
    if (new Set(properties).size !== properties.length) check.fail('invalid_index', field);
    const resolved = properties.map((property: unknown) => {
      const column = typeof property === 'string' ? columns.byProperty.get(property) : undefined;
      if (column === undefined) return check.fail('unknown_column', field);
      return column;
    });
    const unique = check.optionalTrue(spec.unique, `${field}.unique`);
    const global = check.optionalTrue(spec.global, `${field}.global`);
    if (global && (!unique || tenant === undefined)) check.fail('invalid_index', `${field}.global`);
    const width = keyWidth(check, resolved, field);
    if (width > MAX_INDEX_KEY_BYTES) {
      check.fail(
        resolved.some((column) => column.encrypted !== undefined)
          ? 'encrypted_not_indexable'
          : 'index_too_wide',
        field,
      );
    }
    if (unique && tenant !== undefined && !global && !properties.includes(tenant)) {
      check.fail('unique_without_tenant', field);
    }
    const name =
      spec.name === undefined
        ? indexName(
            table,
            resolved.map((column) => column.column),
            unique,
          )
        : check.physical(spec.name, `${field}.name`);
    const shape = `${unique}:${properties.join(',')}`;
    for (const existing of indexes) {
      if (existing.name === name || `${existing.unique}:${existing.columns.join(',')}` === shape) {
        check.fail('duplicate_index', field);
      }
    }
    indexes.push(
      Object.freeze({ name, columns: Object.freeze([...properties] as string[]), unique, global }),
    );
  });
  return indexes;
}

/** The named attachments of a spec: properties of their own, each `{ kind: 'one' }`. */
function checkAttachments(
  check: Checker,
  value: unknown,
  columns: Columns,
  relations: Readonly<Record<string, RelationSpec>>,
): Readonly<Record<string, AttachmentSpec>> {
  if (value === undefined) return Object.freeze({});
  const specs = check.record(value, 'attachments');
  const attachments: Record<string, AttachmentSpec> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const field = `attachments.${name}`;
    check.property(name, field);
    if (columns.byProperty.has(name) || Object.hasOwn(relations, name)) {
      check.fail('duplicate_column', field);
    }
    const fields = check.record(spec, field);
    check.keys(fields, ATTACHMENT_KEYS, field);
    if (fields.kind !== 'one') check.fail('invalid_spec', `${field}.kind`);
    attachments[name] = Object.freeze({ kind: 'one' });
  }
  return Object.freeze(attachments);
}

/**
 * Validate `value` as a {@link ModelSpec} and normalize it. `fallbackName`
 * is the model's name when the spec sets none (the class name, or the table).
 */
export function normalizeSpec(value: unknown, fallbackName: string | undefined): NormalizedSpec {
  const raw =
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {};
  const label = typeof raw.table === 'string' ? raw.table : (fallbackName ?? 'model');
  const check = new Checker(
    typeof raw.name === 'string' && raw.name !== '' ? raw.name : (fallbackName ?? label),
  );
  const spec = check.record(value, 'spec');
  check.keys(spec, SPEC_KEYS, 'spec');
  const table = check.physical(spec.table, 'table');
  const name: unknown = spec.name ?? fallbackName ?? table;
  if (typeof name !== 'string' || !MODEL_NAME.test(name)) return check.fail('invalid_spec', 'name');

  const declared = check.record(spec.columns, 'columns');
  const relationSpecs =
    spec.relations === undefined ? {} : check.record(spec.relations, 'relations');
  const lockVersion = check.optionalTrue(spec.lockVersion, 'lockVersion');

  const primaryKeyValue = spec.primaryKey ?? 'id';
  const primaryKey: unknown =
    typeof primaryKeyValue === 'string' ? [primaryKeyValue] : primaryKeyValue;
  if (!Array.isArray(primaryKey) || primaryKey.length === 0) {
    check.fail('invalid_primary_key', 'primaryKey');
  }
  const keyProperties = (primaryKey as readonly unknown[]).map((property, position) =>
    check.property(property, `primaryKey[${position}]`),
  );
  if (new Set(keyProperties).size !== keyProperties.length) {
    check.fail('invalid_primary_key', 'primaryKey');
  }

  const columns: Columns = { list: [], byProperty: new Map() };
  const implicitId = spec.primaryKey === undefined && !Object.hasOwn(declared, 'id');
  if (implicitId) {
    addColumn(check, columns, {
      property: 'id',
      column: 'id',
      type: ID,
      nullable: false,
      origin: 'primary-key',
    });
  }
  for (const [property, columnSpec] of Object.entries(declared)) {
    check.property(property, `columns.${property}`);
    addColumn(check, columns, declaredColumn(check, property, columnSpec));
  }

  const relations: Record<string, RelationSpec> = {};
  for (const [relationName, relationValue] of Object.entries(relationSpecs)) {
    check.property(relationName, `relations.${relationName}`);
    if (Object.hasOwn(declared, relationName) || relationName === 'lockVersion') {
      check.fail('duplicate_column', `relations.${relationName}`);
    }
    relations[relationName] = checkRelation(check, relationName, relationValue);
  }
  for (const [relationName, relation] of Object.entries(relations)) {
    relationColumns(check, columns, relationName, relation);
  }
  for (const [relationName, relation] of Object.entries(relations)) {
    if (!('through' in relation)) continue;
    const via = Object.hasOwn(relations, relation.through)
      ? relations[relation.through]
      : undefined;
    if (via === undefined || 'through' in via || 'polymorphic' in via) {
      check.fail('invalid_relation', `relations.${relationName}.through`);
    }
  }
  if (lockVersion) {
    addColumn(check, columns, {
      property: 'lockVersion',
      column: 'lock_version',
      type: INTEGER,
      nullable: false,
      default: 0,
      origin: 'lock-version',
    });
  }
  for (const column of columns.list) {
    if (Object.hasOwn(relations, column.property)) check.fail('duplicate_column', column.property);
  }
  const attachments = checkAttachments(check, spec.attachments, columns, relations);
  if (Object.keys(attachments).length > 0 && keyProperties.length !== 1) {
    check.fail('invalid_spec', 'attachments');
  }

  const keyColumns = keyProperties.map((property, position) => {
    const column = columns.byProperty.get(property);
    checkKeyColumn(check, column, `primaryKey[${position}]`);
    return column as ResolvedColumn;
  });
  const generatedKey = keyColumns.length === 1 && keyColumns[0]?.type.kind === 'id';
  if (generatedKey && keyColumns[0]?.default !== undefined) {
    check.fail('invalid_primary_key', 'primaryKey');
  }
  if (keyWidth(check, keyColumns, 'primaryKey') > MAX_INDEX_KEY_BYTES) {
    check.fail('index_too_wide', 'primaryKey');
  }

  let tenant: string | undefined;
  if (spec.tenant !== undefined) {
    tenant = check.property(spec.tenant, 'tenant');
    const column = columns.byProperty.get(tenant);
    if (
      column === undefined ||
      column.nullable ||
      column.encrypted !== undefined ||
      !TENANT_TYPES.has(column.type.kind) ||
      (generatedKey && keyProperties[0] === tenant)
    ) {
      check.fail('invalid_tenant', 'tenant');
    }
    if (!generatedKey && !keyProperties.includes(tenant)) {
      check.fail('unique_without_tenant', 'primaryKey');
    }
  }

  const indexes = checkIndexes(check, table, spec.indexes, columns, tenant);

  // Primary key first, then the rest in declaration order.
  const ordered = [
    ...keyColumns,
    ...columns.list.filter((column) => !keyProperties.includes(column.property)),
  ].map((column) =>
    keyProperties.includes(column.property) && column.origin === 'declared'
      ? Object.freeze({ ...column, origin: 'primary-key' as const })
      : column,
  );
  const width = ordered.reduce((sum, column) => sum + rowBytes(storedType(column)), 0);
  if (width > MAX_ROW_BYTES) check.fail('row_too_wide', 'columns');

  return Object.freeze({
    name,
    table,
    columns: Object.freeze(ordered),
    primaryKey: Object.freeze([...keyProperties]),
    generatedKey,
    relations: Object.freeze(relations),
    indexes: Object.freeze(indexes),
    tenant,
    lockVersion,
    attachments,
  });
}
