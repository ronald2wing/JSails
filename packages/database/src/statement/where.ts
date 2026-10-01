/**
 * The predicate compiler: `Where<T>` conditions and `Q` combinators lowered
 * to the IR's predicate tree for one model, with every value encoded by its
 * column's codec at build time.
 *
 * ```ts
 * compileWhere(codecs, { status: 'live', views: { gte: 10 }, deletedAt: null });
 * compileWhere(codecs, Q.or({ authorId: [1, 2] }, Q.not({ title: { like: 'Draft%' } })));
 * ```
 *
 * A condition is a value (equality), `null` (`IS NULL`), an array (`IN`), or
 * an object of operators, ANDed: `eq ne lt lte gt gte in notIn like notLike
 * isNull`. Several properties of one object are ANDed too. `ne` and `notIn`
 * never match `NULL`, as in SQL; add `isNull` for that.
 *
 * A property or an operator present with the value `undefined` throws
 * `statement.invalid_where`; it is never dropped. Dropping it would widen the
 * predicate (`{ id: undefined }` would become "every row", `{ gte: a, lt:
 * undefined }` an open range), so a value missing from a request could turn
 * a lookup or an `updateAll` into one that matches everything. `{}` is the
 * one way to say "every row". (`Values<T>` differs: there `undefined` means
 * "not written".)
 *
 * What a column's codec can answer is enforced here: a value condition on a
 * `queryable: 'none'` column (json, a data contract, random encryption), or
 * a range, `like` or order on an `equality` column (deterministic
 * encryption), throws `statement.unsupported_predicate` before any SQL
 * exists. Null tests bind no value and apply to every column. An equality on
 * a column whose codec states several stored forms (a key rotation) becomes
 * `IN` over all of them.
 */

import type { SqlValue } from '../engine/contract.js';
import type { ColumnRef, OrderTerm, Predicate, SelectColumn } from '../engine/statement.js';
import { reportedName } from '../codec/codec-errors.js';
import { supports } from '../codec/column-codec.js';
import { encodeColumn, type CodecColumn, type ModelCodecs } from '../codec/model-codecs.js';
import { and, col, compare, inList, isNull, like, not, or } from './builders.js';
import type { NotLoaded } from '../relation/relation-types.js';
import { StatementErrors } from './statement-errors.js';

/**
 * The keys of `T` that can hold column values: string keys whose values are
 * neither functions nor relations (`Relation<V>`).
 */
export type ColumnKey<T> = {
  [K in keyof T]-?: K extends string
    ? T[K] extends (...args: never[]) => unknown
      ? never
      : unknown extends T[K]
        ? K
        : NotLoaded extends T[K]
          ? never
          : K
    : never;
}[keyof T];

type Present<V> = Exclude<V, null | undefined>;

/** The operators of a condition on a column of values `V`. */
export interface ComparisonOperators<V> {
  readonly eq?: V;
  readonly ne?: V;
  readonly lt?: V;
  readonly lte?: V;
  readonly gt?: V;
  readonly gte?: V;
  readonly in?: readonly V[];
  readonly notIn?: readonly V[];
  /** `true` for `IS NULL`, `false` for `IS NOT NULL`. */
  readonly isNull?: boolean;
}

/** `LIKE` patterns (`%`, `_`, and `\` as the escape), on text columns only. */
export interface PatternOperators {
  readonly like?: string;
  readonly notLike?: string;
}

/** Every operator a column of values `V` accepts. */
export type Operators<V> = ComparisonOperators<V> &
  ([V] extends [string] ? PatternOperators : unknown);

/** A condition on a column whose values are `V`. */
export type Condition<V> =
  Present<V> | (null extends V ? null : never) | readonly Present<V>[] | Operators<Present<V>>;

/** Conditions on the columns of rows `T`, ANDed; a property set to `undefined` throws, so leave it out. */
export type Where<T> = { readonly [K in ColumnKey<T>]?: Condition<T[K]> };

const Q_NODE: unique symbol = Symbol.for('jsails.database.q') as never;

/** A `Q` combination of conditions. */
export interface QNode<T> {
  readonly [Q_NODE]: 'and' | 'or' | 'not';
  readonly items: readonly WhereInput<T>[];
}

/** A `Where<T>` object or a `Q` combination of them. */
export type WhereInput<T> = Where<T> | QNode<T>;

function node<T>(kind: 'and' | 'or' | 'not', items: readonly WhereInput<T>[]): QNode<T> {
  return Object.freeze({ [Q_NODE]: kind, items: Object.freeze([...items]) });
}

/**
 * Combinators for conditions: `Q.or(a, b)`, `Q.and(a, b)`, `Q.not(a)`.
 *
 * The row type comes from where the combination is used (a `WhereInput<T>`
 * annotation, or the parameter it is passed to), never from its items:
 * inferring it from them costs the compiler about three times the work for
 * every call, and an item cannot name the model anyway.
 */
export const Q: {
  and<T>(...items: readonly NoInfer<WhereInput<T>>[]): QNode<T>;
  or<T>(...items: readonly NoInfer<WhereInput<T>>[]): QNode<T>;
  not<T>(item: NoInfer<WhereInput<T>>): QNode<T>;
} = Object.freeze({
  and: <T>(...items: readonly WhereInput<T>[]) => node('and', items),
  or: <T>(...items: readonly WhereInput<T>[]) => node('or', items),
  not: <T>(item: WhereInput<T>) => node('not', [item]),
});

/** One ordering term on rows `T`: a column, or a column with a direction. */
export type OrderBy<T> =
  | ColumnKey<T>
  | {
      readonly column: ColumnKey<T>;
      readonly direction?: 'asc' | 'desc';
      readonly nulls?: 'first' | 'last';
    };

const OPERATORS = new Set([
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'notIn',
  'like',
  'notLike',
  'isNull',
]);

type Operator = 'eq' | 'ne' | 'in' | 'notIn' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'orderBy';

function isQNode(value: unknown): value is QNode<unknown> {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, Q_NODE);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Compiles conditions for one model. */
class WhereCompiler {
  constructor(
    private readonly codecs: ModelCodecs,
    private readonly qualifier: string | undefined,
  ) {}

  invalid(field: string): never {
    throw new StatementErrors.Error('invalid_where', { model: this.codecs.spec.name, field });
  }

  unsupported(column: CodecColumn, operator: Operator): never {
    throw new StatementErrors.Error('unsupported_predicate', {
      model: this.codecs.spec.name,
      field: column.property,
      operator,
    });
  }

  column(property: string): CodecColumn {
    const column = this.codecs.property(property);
    if (column === undefined) {
      throw new StatementErrors.Error('unknown_column', {
        model: this.codecs.spec.name,
        field: reportedName(property),
      });
    }
    return column;
  }

  ref(column: CodecColumn): ColumnRef {
    return this.qualifier === undefined ? column.column : col(this.qualifier, column.column);
  }

  /** Every stored form of a non-null `value` an equality must match. */
  forms(column: CodecColumn, value: unknown, operator: Operator): readonly SqlValue[] {
    if (!supports(column.codec.queryable, 'equality')) this.unsupported(column, operator);
    if (value === null || value === undefined) this.invalid(column.property);
    const lookup = column.codec.encodeForLookup;
    return lookup === undefined ? [encodeColumn(column, value)] : lookup(value);
  }

  ordered(column: CodecColumn, value: unknown, operator: Operator): SqlValue {
    if (!supports(column.codec.queryable, 'full')) this.unsupported(column, operator);
    if (value === null || value === undefined) this.invalid(column.property);
    return encodeColumn(column, value);
  }

  list(column: CodecColumn, values: unknown, operator: 'in' | 'notIn'): readonly SqlValue[] {
    if (!Array.isArray(values)) this.invalid(column.property);
    if (!supports(column.codec.queryable, 'equality')) this.unsupported(column, operator);
    return (values as readonly unknown[]).flatMap((value) => this.forms(column, value, operator));
  }

  equality(column: CodecColumn, value: unknown, negate: boolean): Predicate {
    const forms = this.forms(column, value, negate ? 'ne' : 'eq');
    if (forms.length === 1) {
      return compare(this.ref(column), negate ? '<>' : '=', forms[0] as SqlValue);
    }
    return inList(this.ref(column), forms, negate);
  }

  pattern(column: CodecColumn, pattern: unknown, negate: boolean): Predicate {
    const kind = column.codec.dbType.kind;
    if (!supports(column.codec.queryable, 'full') || (kind !== 'string' && kind !== 'text')) {
      this.unsupported(column, 'like');
    }
    if (typeof pattern !== 'string') this.invalid(column.property);
    return like(this.ref(column), pattern, negate);
  }

  operators(column: CodecColumn, operators: Readonly<Record<string, unknown>>): Predicate {
    const terms: Predicate[] = [];
    for (const [operator, value] of Object.entries(operators)) {
      if (value === undefined) this.invalid(column.property);
      switch (operator) {
        case 'eq':
        case 'ne':
          terms.push(this.equality(column, value, operator === 'ne'));
          break;
        case 'lt':
          terms.push(compare(this.ref(column), '<', this.ordered(column, value, operator)));
          break;
        case 'lte':
          terms.push(compare(this.ref(column), '<=', this.ordered(column, value, operator)));
          break;
        case 'gt':
          terms.push(compare(this.ref(column), '>', this.ordered(column, value, operator)));
          break;
        case 'gte':
          terms.push(compare(this.ref(column), '>=', this.ordered(column, value, operator)));
          break;
        case 'in':
        case 'notIn':
          terms.push(
            inList(this.ref(column), this.list(column, value, operator), operator === 'notIn'),
          );
          break;
        case 'like':
        case 'notLike':
          terms.push(this.pattern(column, value, operator === 'notLike'));
          break;
        case 'isNull':
          if (typeof value !== 'boolean') this.invalid(column.property);
          terms.push(isNull(this.ref(column), !value));
          break;
        default:
          this.invalid(column.property);
      }
    }
    if (terms.length === 0) this.invalid(column.property);
    return and(...terms);
  }

  condition(property: string, condition: unknown): Predicate {
    const column = this.column(property);
    if (condition === undefined) this.invalid(column.property);
    if (condition === null) return isNull(this.ref(column));
    if (Array.isArray(condition))
      return inList(this.ref(column), this.list(column, condition, 'in'));
    if (isPlainObject(condition)) {
      const keys = Object.keys(condition);
      if (keys.length === 0 || !keys.every((key) => OPERATORS.has(key))) {
        // Only a json column holds plain objects, and it answers no value condition.
        if (!supports(column.codec.queryable, 'equality')) this.unsupported(column, 'eq');
        this.invalid(column.property);
      }
      return this.operators(column, condition);
    }
    return this.equality(column, condition, false);
  }

  input(input: unknown): Predicate {
    if (isQNode(input)) {
      const items = input.items.map((item) => this.input(item));
      switch (input[Q_NODE]) {
        case 'and':
          return and(...items);
        case 'or':
          return or(...items);
        case 'not':
          return not(items[0] as Predicate);
      }
    }
    if (!isPlainObject(input)) this.invalid('where');
    const terms: Predicate[] = [];
    for (const [property, condition] of Object.entries(input)) {
      terms.push(this.condition(property, condition));
    }
    return and(...terms);
  }

  order(term: unknown): OrderTerm {
    const spec =
      typeof term === 'string'
        ? { column: term }
        : isPlainObject(term)
          ? term
          : this.invalid('orderBy');
    if (typeof spec.column !== 'string') this.invalid('orderBy');
    const column = this.column(spec.column);
    if (!supports(column.codec.queryable, 'full')) this.unsupported(column, 'orderBy');
    const { direction, nulls } = spec;
    if (direction !== undefined && direction !== 'asc' && direction !== 'desc') {
      this.invalid(column.property);
    }
    if (nulls !== undefined && nulls !== 'first' && nulls !== 'last') this.invalid(column.property);
    return Object.freeze({
      column: this.ref(column),
      ...(direction === undefined ? {} : { direction }),
      ...(nulls === undefined ? {} : { nulls }),
    });
  }
}

/**
 * The predicate of `where` on `codecs`' model, its columns qualified by
 * `qualifier` when given (an alias, or the table, for a statement that
 * reads several tables).
 *
 * @throws `statement.unknown_column`, `statement.unsupported_predicate` and
 *   `statement.invalid_where` (an `undefined` condition or operator value
 *   included), and `ColumnValueError` for a value its column's codec refuses.
 */
export function compileWhere<T>(
  codecs: ModelCodecs,
  where: WhereInput<T>,
  qualifier?: string,
): Predicate {
  return new WhereCompiler(codecs, qualifier).input(where);
}

/**
 * The ordering terms of `order` on `codecs`' model.
 *
 * @throws `statement.unknown_column`, `statement.invalid_where`, and
 *   `statement.unsupported_predicate` for a column its codec cannot order.
 */
export function compileOrder<T>(
  codecs: ModelCodecs,
  order: OrderBy<T> | readonly OrderBy<T>[],
  qualifier?: string,
): readonly OrderTerm[] {
  const compiler = new WhereCompiler(codecs, qualifier);
  const terms: readonly unknown[] = Array.isArray(order) ? order : [order];
  return Object.freeze(terms.map((term) => compiler.order(term)));
}

/**
 * Every column of `codecs`' model as select output, named by its physical
 * column so the hydrator reads it: the explicit list a window limit needs.
 */
export function modelColumns(codecs: ModelCodecs, qualifier?: string): readonly SelectColumn[] {
  return Object.freeze(
    codecs.columns.map((column) =>
      Object.freeze(
        qualifier === undefined
          ? { column: column.column }
          : { column: col(qualifier, column.column), as: column.column },
      ),
    ),
  );
}
