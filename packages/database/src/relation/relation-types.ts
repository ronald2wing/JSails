/**
 * The types of relations on a record class. A class declares each relation
 * as `Relation<V>`, the value it holds once loaded or `NotLoaded`:
 *
 * ```ts
 * class Post extends ApplicationRecord {
 *   declare id: number;
 *   declare comments: Relation<Comment[]>;
 *   declare author: Relation<Author | null>;
 * }
 * const posts = await Post.all().includes({ comments: { include: ['author'] } }).getMany();
 * posts[0]?.comments[0]?.author?.name; // compiles: Loaded<Post, ...>
 * ```
 *
 * Reading `post.comments` as an array does not compile on a plain `Post`:
 * `NotLoaded` has no members. A query's `includes`, and `loadRelation`,
 * return `Loaded<T, S>`, where the included relations hold their value,
 * nested includes included. Assigning a value (for autosave) compiles
 * either way, and `Loaded<T, S>` is still a `T`.
 *
 * `S`, the include spec, is a relation name, a list of names, or an object
 * naming relations with `true` or their load options, whose `include` nests.
 */

import type { OrderBy, WhereInput } from '../statement/where.js';

declare const NOT_LOADED: unique symbol;

/** The state of a relation that was not loaded: it has nothing to read. */
export interface NotLoaded {
  readonly [NOT_LOADED]: 'not loaded';
}

/** A relation property holding `V` once loaded or assigned. */
export type Relation<V> = V | NotLoaded;

/**
 * The relation properties of `T`: those declared `Relation<V>` (every string
 * key of an untyped row, whose values are `unknown`).
 */
export type RelationKey<T> = {
  [K in keyof T]-?: K extends string
    ? unknown extends T[K]
      ? K
      : NotLoaded extends T[K]
        ? K
        : never
    : never;
}[keyof T];

/** The value a relation property holds once loaded. */
export type RelationValue<V> = Exclude<V, NotLoaded>;

/** The record type at the far end of a relation property: its element, or its non-null value. */
export type RelationTarget<V> =
  RelationValue<V> extends readonly (infer E)[] ? E : Exclude<RelationValue<V>, null>;

/** How one relation is loaded. */
export interface RelationLoadOptions<S> {
  /** Load only the target rows matching this condition. */
  readonly where?: WhereInput<S>;
  /** The order of a to-many relation's records per parent (the primary key breaks ties). */
  readonly order?: OrderBy<S> | readonly OrderBy<S>[];
  /** At most this many records per parent, in `order`; to-many relations only. */
  readonly limit?: number;
  /** Fail with `relation.too_many_rows` when the level would read more rows than this. */
  readonly maxRows?: number;
  /** Relations of the loaded records to load with them. */
  readonly include?: IncludeSpec<S>;
}

/** Relations of `T` by name, each `true` or its load options. */
export type IncludeTree<T> = {
  readonly [K in RelationKey<T>]?: true | RelationLoadOptions<RelationTarget<T[K]>>;
};

/** Which relations of `T` to load: a name, a list of names, or an {@link IncludeTree}. */
export type IncludeSpec<T> = RelationKey<T> | readonly RelationKey<T>[] | IncludeTree<T>;

type Nested<V, N> = V extends readonly (infer E)[]
  ? Loaded<E, N>[]
  : V extends null
    ? null
    : Loaded<V, N>;

type LoadedPart<T, S> = [S] extends [string]
  ? { [K in S & keyof T]: RelationValue<T[K]> }
  : [S] extends [readonly (infer K)[]]
    ? { [P in K & keyof T]: RelationValue<T[P]> }
    : {
        [K in keyof S & keyof T]: S[K] extends { readonly include: infer N }
          ? Nested<RelationValue<T[K]>, N>
          : RelationValue<T[K]>;
      };

/** `T` with the relations of the include spec `S` loaded. */
export type Loaded<T, S> = T & LoadedPart<T, S>;
