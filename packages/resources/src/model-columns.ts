/**
 * Connection-free facts about a model's columns, read from TypeORM's
 * decorator metadata and the JSails model registry.
 *
 * A model's decorators run when its module is evaluated, so by the time a
 * resource file imports the model, its columns are known without a live
 * DataSource. That lets every column rule fail when the resource is defined,
 * at startup, instead of on the first request. Columns declared on a base
 * class count; relations and their join columns are not columns here, so a
 * foreign key is exposed only through an explicit `@Column`.
 */

import { getMetadataArgsStorage } from 'typeorm';

import { registeredModels } from 'jsails/models';

/** What a column holds, as far as querying it is concerned. */
export type ColumnKind = 'text' | 'json' | 'other';

/** The facts the resource rules need about one column. */
export interface ColumnFacts {
  readonly kind: ColumnKind;
  readonly primary: boolean;
}

/** How a primary key travels in a URL. */
export type PrimaryKeyKind = 'integer' | 'string';

const TEXT_TYPES = new Set([
  'varchar',
  'nvarchar',
  'character varying',
  'char',
  'nchar',
  'character',
  'text',
  'tinytext',
  'mediumtext',
  'longtext',
  'ntext',
  'citext',
  'string',
]);

const JSON_TYPES = new Set(['json', 'jsonb', 'simple-json', 'simple-array']);

const INTEGER_TYPES = new Set([
  'int',
  'integer',
  'int2',
  'int4',
  'int8',
  'tinyint',
  'smallint',
  'mediumint',
  'bigint',
]);

/** Every class from `model` up its prototype chain: inherited columns count. */
function lineage(model: Function): Function[] {
  const chain: Function[] = [];
  for (
    let target: unknown = model;
    typeof target === 'function' && target !== Function.prototype;
    target = Object.getPrototypeOf(target)
  ) {
    chain.push(target);
  }
  return chain;
}

function typeName(type: unknown): string | undefined {
  if (typeof type === 'string') return type.toLowerCase();
  if (type === String) return 'string';
  if (type === Number) return 'number';
  if (type === Boolean) return 'boolean';
  if (type === Date) return 'datetime';
  return undefined;
}

function kindOf(type: unknown): ColumnKind {
  const name = typeName(type);
  if (name === undefined) return 'other';
  if (TEXT_TYPES.has(name)) return 'text';
  if (JSON_TYPES.has(name)) return 'json';
  return 'other';
}

/** The model's columns by property name. Empty when `model` is not an entity. */
export function modelColumns(model: Function): ReadonlyMap<string, ColumnFacts> {
  const targets = new Set(lineage(model));
  const columns = new Map<string, ColumnFacts>();
  for (const column of getMetadataArgsStorage().columns) {
    if (typeof column.target !== 'function' || !targets.has(column.target)) continue;
    if (columns.has(column.propertyName)) continue;
    columns.set(column.propertyName, {
      kind: kindOf(column.options.type),
      primary: column.options.primary === true,
    });
  }
  return columns;
}

/**
 * The property names a `@Unique`/`@Index` lists. The JSails schema tool refuses
 * the function form, so only a name list counts.
 */
function constraintColumns(columns: unknown): readonly string[] | undefined {
  return Array.isArray(columns) && columns.every((name) => typeof name === 'string')
    ? columns
    : undefined;
}

/**
 * The model's unique constraints, each as the property names it spans: a
 * `unique` column, a `@Unique`, or a unique `@Index`.
 */
export function uniqueConstraints(model: Function): readonly (readonly string[])[] {
  const targets = new Set(lineage(model));
  const storage = getMetadataArgsStorage();
  const owned = (target: unknown): boolean => typeof target === 'function' && targets.has(target);
  const sets = new Map<string, readonly string[]>();
  const add = (names: readonly string[] | undefined): void => {
    if (names === undefined || names.length === 0) return;
    const sorted = [...new Set(names)].sort();
    sets.set(sorted.join('\0'), Object.freeze(sorted));
  };
  for (const column of storage.columns) {
    if (owned(column.target) && column.options.unique === true) add([column.propertyName]);
  }
  for (const unique of storage.uniques) {
    if (owned(unique.target)) add(constraintColumns(unique.columns));
  }
  for (const index of storage.indices) {
    if (owned(index.target) && index.unique === true) {
      add(constraintColumns(index.columns));
    }
  }
  return Object.freeze([...sets.values()]);
}

/**
 * How the `id` primary key is written in a URL: a generated uuid or a text
 * column is a string, anything else an integer.
 */
export function primaryKeyKind(model: Function): PrimaryKeyKind {
  const targets = new Set(lineage(model));
  const storage = getMetadataArgsStorage();
  const generation = storage.generations.find(
    (entry) =>
      typeof entry.target === 'function' &&
      targets.has(entry.target) &&
      entry.propertyName === 'id',
  );
  if (generation !== undefined) {
    return generation.strategy === 'uuid' ? 'string' : 'integer';
  }
  const column = storage.columns.find(
    (entry) =>
      typeof entry.target === 'function' &&
      targets.has(entry.target) &&
      entry.propertyName === 'id',
  );
  const name = typeName(column?.options.type);
  if (name === undefined || name === 'number' || INTEGER_TYPES.has(name)) return 'integer';
  return 'string';
}

/** The fields a JSails model encrypts with `@jsails.encrypts()`. */
export function encryptedFields(model: Function): ReadonlySet<string> {
  const entry = registeredModels().find((registered) => registered.entity === model);
  return new Set(entry?.spec.encrypted ?? []);
}
