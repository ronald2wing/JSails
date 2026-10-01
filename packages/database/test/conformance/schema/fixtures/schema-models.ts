/**
 * Models for the schema conformance suite: one table per concern, together
 * covering every portable type, every default form and every index form the
 * model layer lowers (declared unique and composite, the automatic
 * foreign-key, polymorphic and tenant indexes, a foreign key that opts out of
 * its index, a composite primary key, an encrypted column), plus second
 * versions of tables for the change suite: one with column, index and key
 * changes, a named unique index whose columns change, and a foreign key
 * whose columns change type on both sides.
 */

import { column, defineModel, defineTable, type ModelTarget } from '../../../../src/model/index.js';

/** Every portable type, with every kind of default. */
export const CatalogTypes = defineTable({
  table: 'catalog_types',
  columns: {
    label: column.string(40, { default: "it's a \\ label" }),
    body: column.text({ nullable: true }),
    count: column.integer({ default: -3 }),
    big: column.bigint({ default: '9007199254740993' }),
    price: column.decimal(12, 2, { default: '10.50' }),
    wide: column.decimal(30, 10, { nullable: true, default: '1.5' }),
    ratio: column.float({ default: 0.25 }),
    done: column.boolean({ default: true }),
    at: column.timestamp({ default: { now: true } }),
    day: column.date({ default: '2001-02-03' }),
    clock: column.time({ default: '04:05:06.007' }),
    doc: column.json({ default: '{"b":1,"a":[true,null]}' }),
    token: column.uuid({ nullable: true }),
    sized: column.binary(24, { nullable: true }),
    blob: column.binary(undefined, { nullable: true }),
    secret: column.text({ nullable: true, encrypted: { mode: 'random' } }),
  },
  indexes: [{ columns: ['label'], unique: true }, { columns: ['count', 'done'] }],
});

export class CatalogAuthor {}
export class CatalogPost {}

defineModel(CatalogAuthor, {
  table: 'catalog_authors',
  columns: { name: column.string(100) },
  relations: {
    posts: { kind: 'hasMany', target: () => CatalogPost, inverse: 'author', dependent: 'destroy' },
  },
});

/** A tenant-scoped table with an automatic foreign-key, polymorphic and tenant index. */
defineModel(CatalogPost, {
  table: 'catalog_posts',
  columns: { title: column.string(200), tenantId: column.integer(), slug: column.string(60) },
  tenant: 'tenantId',
  relations: {
    author: { kind: 'belongsTo', target: () => CatalogAuthor },
    subject: { kind: 'belongsTo', polymorphic: true, nullable: true },
  },
  indexes: [{ columns: ['tenantId', 'slug'], unique: true }],
});

/** A foreign key without its automatic index: MariaDB creates its own, named after the key. */
export const CatalogLoose = defineTable({
  table: 'catalog_loose',
  columns: { note: column.string(10, { nullable: true }) },
  relations: {
    owner: { kind: 'belongsTo', target: () => CatalogAuthor, nullable: true, index: false },
  },
});

/** A composite primary key, no generated id. */
export const CatalogLinks = defineTable({
  table: 'catalog_links',
  primaryKey: ['left', 'right'],
  columns: { left: column.integer(), right: column.integer(), weight: column.float() },
});

/** The full catalog. */
export const CATALOG: readonly ModelTarget[] = Object.freeze([
  CatalogTypes,
  CatalogAuthor,
  CatalogPost,
  CatalogLoose,
  CatalogLinks,
]);

/** `catalog_notes`, version 1. */
export const NotesV1 = defineTable({
  table: 'catalog_notes',
  columns: {
    title: column.string(40),
    body: column.text({ nullable: true }),
    legacy: column.integer({ nullable: true }),
    priority: column.integer({ default: 0 }),
  },
  indexes: [{ columns: ['title'] }],
});

/** `catalog_notes`, version 2: widened, loosened, a column added and one dropped, an index replaced. */
export const NotesV2 = defineTable({
  table: 'catalog_notes',
  columns: {
    title: column.string(120),
    body: column.text(),
    priority: column.integer({ default: 5 }),
    extra: column.string(10, { nullable: true }),
  },
  indexes: [{ columns: ['title'], unique: true }, { columns: ['priority'] }],
});

/** A table that exists only in some declarations. */
export const Scratch = defineTable({
  table: 'catalog_scratch',
  columns: { value: column.integer({ nullable: true }) },
});

/** A second table that exists only in some declarations. */
export const Scratch2 = defineTable({
  table: 'catalog_scratch2',
  columns: { value: column.integer({ nullable: true }) },
});

/** `catalog_members`, version 1: a named unique index over `email`. */
export const MembersV1 = defineTable({
  table: 'catalog_members',
  columns: { email: column.string(80), team: column.string(20) },
  indexes: [{ columns: ['email'], unique: true, name: 'catalog_members_login' }],
});

/** `catalog_members`, version 2: the same index name over `email` and `team`. */
export const MembersV2 = defineTable({
  table: 'catalog_members',
  columns: { email: column.string(80), team: column.string(20) },
  indexes: [{ columns: ['email', 'team'], unique: true, name: 'catalog_members_login' }],
});

export class TeamV1 {}
export class TeamV2 {}

/** `catalog_teams`, version 1: an integer key that `catalog_players` references. */
defineModel(TeamV1, {
  table: 'catalog_teams',
  primaryKey: ['code'],
  columns: { code: column.integer() },
});

/** `catalog_teams`, version 2: the key widened to bigint. */
defineModel(TeamV2, {
  table: 'catalog_teams',
  primaryKey: ['code'],
  columns: { code: column.bigint() },
});

/** `catalog_players`, version 1: an integer foreign key to `catalog_teams`. */
export const PlayersV1 = defineTable({
  table: 'catalog_players',
  columns: { teamCode: column.integer() },
  relations: { team: { kind: 'belongsTo', target: () => TeamV1, foreignKey: 'teamCode' } },
});

/** `catalog_players`, version 2: the foreign key widened with the key it references. */
export const PlayersV2 = defineTable({
  table: 'catalog_players',
  columns: { teamCode: column.bigint() },
  relations: { team: { kind: 'belongsTo', target: () => TeamV2, foreignKey: 'teamCode' } },
});
