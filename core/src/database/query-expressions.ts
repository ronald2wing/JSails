/**
 * Portable query expressions for the JSails data layer: a typed expression
 * language that compiles through TypeORM's SelectQueryBuilder. Every
 * condition is emitted with bound parameters or column references — never
 * hand-built SQL with inlined literals or quoted identifiers.
 *
 * Boolean combinators (`and`/`or`/`not`) are compiled through TypeORM's
 * `Brackets` and `NotBrackets` for portable, parenthesized rendering with
 * bound parameters — no hand-built SQL.
 *
 * `qLike` takes a raw pattern whose `%` and `_` are wildcards, for a caller
 * that means them. Text from a user goes through `qContains`, `qStartsWith`,
 * or `qEndsWith` instead: they escape `%`, `_`, and the escape character
 * itself and render `LIKE … ESCAPE '!'`. The escape character is `!` rather
 * than a backslash because MySQL and MariaDB read a backslash inside a SQL
 * string literal as an escape of their own, so `ESCAPE '\'` is not portable.
 */

import {
  Brackets,
  NotBrackets,
  type SelectQueryBuilder,
  type WhereExpressionBuilder,
} from 'typeorm';

import { isValidIdentifier } from '../migrations/schema-validation.js';
import { JsailsError } from '../errors/jsails-error.js';

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Machine-readable reason for a {@link QueryExpressionError}. */
export type QueryExpressionErrorCode =
  'invalid_identifier' | 'invalid_expression' | 'unsupported_operator';

/** Raised for expression-compilation failures. Value-free. */
export class QueryExpressionError extends JsailsError {
  constructor(
    readonly code: QueryExpressionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// F — column reference
// ---------------------------------------------------------------------------

/**
 * A column reference on a specific table alias. Use as a comparison value
 * to produce column-to-column comparisons instead of bound parameters.
 */
export class F {
  readonly column: string;

  constructor(column: string) {
    if (!isValidIdentifier(column)) {
      throw new QueryExpressionError('invalid_identifier', 'invalid column identifier');
    }
    this.column = column;
  }

  /** Emit a portable qualified column reference: `alias.column`. */
  toSql(alias: string): string {
    return `${alias}.${this.column}`;
  }
}

// ---------------------------------------------------------------------------
// Bound-parameter names
// ---------------------------------------------------------------------------

let parameterSequence = 0;

/**
 * A bound-parameter name no other call in this process has returned.
 *
 * TypeORM keeps one flat parameter map per query builder, shared with every
 * `Brackets` and subquery built from it and copied by `clone()`, and a later
 * `setParameter` under an existing name silently replaces the earlier value
 * for every placeholder that uses it. A name unique per call (or per builder)
 * is therefore not enough: two `where()` calls on one column, or a scope's
 * filter followed by the caller's, would bind the same name and the second
 * value would overwrite the first. A process-wide sequence cannot collide.
 * `prefix` must already be a valid parameter-name fragment.
 */
export function uniqueParameterName(prefix: string): string {
  parameterSequence = parameterSequence >= Number.MAX_SAFE_INTEGER ? 0 : parameterSequence + 1;
  return `${prefix}_${parameterSequence}`;
}

// ---------------------------------------------------------------------------
// Identifier validation
// ---------------------------------------------------------------------------

export function assertValidColumn(column: string): void {
  if (!isValidIdentifier(column)) {
    throw new QueryExpressionError('invalid_identifier', 'invalid column identifier');
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Recognized comparison operators. */
export type QOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'notIn'
  | 'isNull'
  | 'notNull'
  | 'like'
  | 'contains'
  | 'startsWith'
  | 'endsWith';

/** A single comparison condition. */
export interface QLeaf {
  readonly kind: 'leaf';
  readonly column: string;
  readonly operator: QOperator;
  readonly value?: unknown;
}

/** A compound condition (and/or/not). */
export interface QNode {
  readonly kind: 'and' | 'or' | 'not';
  readonly children: readonly Q[];
}

export type Q = QLeaf | QNode;

// ---------------------------------------------------------------------------
// Generic leaf constructor
// ---------------------------------------------------------------------------

export function q(column: string, operator: QOperator, value?: unknown): Q {
  assertValidColumn(column);
  validateOperator(operator, value);
  return Object.freeze({ kind: 'leaf', column, operator, value });
}

// ---------------------------------------------------------------------------
// Typed leaf constructors
// ---------------------------------------------------------------------------

export function qEq(column: string, value: unknown): Q {
  return q(column, 'eq', value);
}

export function qNe(column: string, value: unknown): Q {
  return q(column, 'ne', value);
}

export function qGt(column: string, value: unknown): Q {
  return q(column, 'gt', value);
}

export function qGte(column: string, value: unknown): Q {
  return q(column, 'gte', value);
}

export function qLt(column: string, value: unknown): Q {
  return q(column, 'lt', value);
}

export function qLte(column: string, value: unknown): Q {
  return q(column, 'lte', value);
}

export function qIn(column: string, values: readonly unknown[]): Q {
  assertValidColumn(column);
  if (!Array.isArray(values) || values.length === 0) {
    throw new QueryExpressionError(
      'invalid_expression',
      'the "in" operator requires a non-empty array of values',
    );
  }
  if (values.some((v) => v instanceof F)) {
    throw new QueryExpressionError(
      'invalid_expression',
      'F references are not supported with the "in" operator',
    );
  }
  return Object.freeze({ kind: 'leaf', column, operator: 'in', value: Object.freeze([...values]) });
}

export function qNotIn(column: string, values: readonly unknown[]): Q {
  assertValidColumn(column);
  if (!Array.isArray(values) || values.length === 0) {
    throw new QueryExpressionError(
      'invalid_expression',
      'the "notIn" operator requires a non-empty array of values',
    );
  }
  if (values.some((v) => v instanceof F)) {
    throw new QueryExpressionError(
      'invalid_expression',
      'F references are not supported with the "notIn" operator',
    );
  }
  return Object.freeze({
    kind: 'leaf',
    column,
    operator: 'notIn',
    value: Object.freeze([...values]),
  });
}

export function qIsNull(column: string): Q {
  assertValidColumn(column);
  return Object.freeze({ kind: 'leaf', column, operator: 'isNull' });
}

export function qNotNull(column: string): Q {
  assertValidColumn(column);
  return Object.freeze({ kind: 'leaf', column, operator: 'notNull' });
}

export function qLike(column: string, pattern: string): Q {
  assertValidColumn(column);
  // The param is typed `string`, so F is rejected at compile time. The
  // generic `q()` path validates F for `like` via validateOperator.
  if (typeof pattern !== 'string') {
    throw new QueryExpressionError(
      'invalid_expression',
      'the "like" operator requires a string pattern',
    );
  }
  return Object.freeze({ kind: 'leaf', column, operator: 'like', value: pattern });
}

/** Matches rows whose `column` contains `text`, taken literally. */
export function qContains(column: string, text: string): Q {
  return literalMatch(column, 'contains', text);
}

/** Matches rows whose `column` starts with `text`, taken literally. */
export function qStartsWith(column: string, text: string): Q {
  return literalMatch(column, 'startsWith', text);
}

/** Matches rows whose `column` ends with `text`, taken literally. */
export function qEndsWith(column: string, text: string): Q {
  return literalMatch(column, 'endsWith', text);
}

function literalMatch(column: string, operator: LiteralMatchOperator, text: string): Q {
  assertValidColumn(column);
  validateOperator(operator, text);
  return Object.freeze({ kind: 'leaf', column, operator, value: text });
}

type LiteralMatchOperator = 'contains' | 'startsWith' | 'endsWith';

function isLiteralMatch(operator: QOperator): operator is LiteralMatchOperator {
  return operator === 'contains' || operator === 'startsWith' || operator === 'endsWith';
}

/** The escape character literal matches declare in their `ESCAPE` clause. */
const LIKE_ESCAPE = '!';

/**
 * `text` as a `LIKE` pattern matching it literally, wrapped for `operator`. A
 * leaf built by hand rather than through a constructor is re-checked here.
 */
function literalPattern(operator: LiteralMatchOperator, text: unknown): string {
  if (typeof text !== 'string') {
    throw new QueryExpressionError(
      'invalid_expression',
      'pattern operators require a string value',
    );
  }
  const escaped = text.replace(/[!%_]/g, (char) => `${LIKE_ESCAPE}${char}`);
  switch (operator) {
    case 'contains':
      return `%${escaped}%`;
    case 'startsWith':
      return `${escaped}%`;
    case 'endsWith':
      return `%${escaped}`;
  }
}

// ---------------------------------------------------------------------------
// Operator validation (for the generic q() path)
// ---------------------------------------------------------------------------

function validateOperator(operator: string, value: unknown): void {
  switch (operator) {
    case 'eq':
    case 'ne':
      if (value == null) {
        throw new QueryExpressionError(
          'invalid_expression',
          'equality comparisons against missing values are not supported',
        );
      }
      return;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      // F is a valid value here (column-to-column comparison). No other
      // validation needed — TypeORM will parameterise or reference accordingly.
      return;
    case 'in':
    case 'notIn':
      if (!Array.isArray(value) || (value as readonly unknown[]).length === 0) {
        throw new QueryExpressionError(
          'invalid_expression',
          'the "in" operator requires a non-empty array of values',
        );
      }
      if ((value as readonly unknown[]).some((v) => v instanceof F)) {
        throw new QueryExpressionError(
          'invalid_expression',
          'F references are not supported with the "in" operator',
        );
      }
      return;
    case 'isNull':
    case 'notNull':
      if (value !== undefined) {
        throw new QueryExpressionError(
          'invalid_expression',
          'isNull and notNull operators do not accept a value',
        );
      }
      return;
    case 'like':
    case 'contains':
    case 'startsWith':
    case 'endsWith':
      if (value instanceof F) {
        throw new QueryExpressionError(
          'invalid_expression',
          'F references are not supported with pattern operators',
        );
      }
      if (typeof value !== 'string') {
        throw new QueryExpressionError(
          'invalid_expression',
          'pattern operators require a string value',
        );
      }
      return;
    default:
      throw new QueryExpressionError('unsupported_operator', 'unknown query operator');
  }
}

// ---------------------------------------------------------------------------
// Case / When — conditional value expression
// ---------------------------------------------------------------------------

/** A single branch of a CASE expression: WHEN <condition> THEN <value>. */
export interface When {
  readonly condition: Q;
  readonly then: unknown;
}

/**
 * A portable `CASE WHEN ... THEN ... ELSE ... END` expression.
 *
 * Conditions are restricted to single leaves in this version because
 * TypeORM's `Brackets` provides no public SQL-extraction API — extracting a
 * compound condition into a standalone SQL fragment is not cleanly possible
 * without hand-building identifier quoting. Compound conditions in a when
 * clause are rejected with a value-free error.
 */
export class Case {
  constructor(
    readonly whens: readonly When[],
    readonly defaultValue?: unknown,
  ) {}

  /**
   * Render a `CASE WHEN ... THEN ... ELSE ... END` expression.
   *
   * Every branch value and the default is a bound parameter (never inlined).
   * Column references (`F`) in `then`/`defaultValue` are emitted as qualified
   * column references. The caller must register the returned params on the
   * query builder. Parameter names come from {@link uniqueParameterName}, so
   * they never collide with another expression on the same builder.
   */
  toSql(alias: string): { sql: string; params: Record<string, unknown> } {
    const params: Record<string, unknown> = {};
    const whenClauses: string[] = [];

    for (const w of this.whens) {
      // Safe cast: isWhen validates condition is a leaf at construction time.
      const { sql: condSql, params: condParams } = renderLeafCondition(w.condition as QLeaf, alias);
      Object.assign(params, condParams);

      if (w.then instanceof F) {
        whenClauses.push(`WHEN ${condSql} THEN ${w.then.toSql(alias)}`);
      } else {
        const thenKey = uniqueParameterName('qe_case');
        whenClauses.push(`WHEN ${condSql} THEN :${thenKey}`);
        params[thenKey] = w.then;
      }
    }

    let elseClause: string;
    if (this.defaultValue === undefined || this.defaultValue === null) {
      elseClause = 'ELSE NULL';
    } else if (this.defaultValue instanceof F) {
      elseClause = `ELSE ${this.defaultValue.toSql(alias)}`;
    } else {
      const elseKey = uniqueParameterName('qe_case');
      elseClause = `ELSE :${elseKey}`;
      params[elseKey] = this.defaultValue;
    }

    const sql = `CASE ${whenClauses.join(' ')} ${elseClause} END`;
    return { sql, params };
  }
}

/**
 * Construct a single CASE branch.
 *
 * The condition must be a leaf predicate (compound conditions are rejected
 * in this version — see `Case`). The `then` value may be a literal or a
 * column reference (`F`).
 */
export function when(condition: Q, then: unknown): When {
  if (!isQ(condition)) {
    throw new QueryExpressionError(
      'invalid_expression',
      'a "when" condition must be a query predicate',
    );
  }
  if (condition.kind !== 'leaf') {
    throw new QueryExpressionError(
      'invalid_expression',
      'only single leaf conditions are supported in "when" clauses',
    );
  }
  return Object.freeze({ condition, then });
}

/**
 * Construct a CASE expression from one or more WHEN branches and an optional
 * ELSE default. Rejects zero branches — a CASE with no branches is meaningless.
 */
export function caseWhen(whens: readonly When[], defaultValue?: unknown): Case {
  if (whens.length === 0) {
    throw new QueryExpressionError(
      'invalid_expression',
      'a "case" expression requires at least one "when" clause',
    );
  }
  for (const w of whens) {
    if (!isWhen(w)) {
      throw new QueryExpressionError('invalid_expression', 'invalid "when" clause');
    }
  }
  return new Case(whens, defaultValue);
}

/** Structural check: does the value have the expected When shape? */
function isWhen(value: unknown): value is When {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  // Must carry the 'then' property — a When without 'then' is a programming
  // error, not a valid NULL THEN.
  return 'then' in obj && isQ(obj.condition) && obj.condition.kind === 'leaf';
}

/**
 * Render a single leaf condition into a portable SQL fragment with bound
 * parameters. Parallels `renderLeaf` but outputs strings instead of writing
 * into a `WhereExpressionBuilder`, for use in CASE WHEN condition rendering.
 */
function renderLeafCondition(
  leaf: QLeaf,
  alias: string,
): { sql: string; params: Record<string, unknown> } {
  const { column, operator, value } = leaf;
  const sql = checkedLeafSql(leaf);
  const params: Record<string, unknown> = {};

  if (operator === 'isNull' || operator === 'notNull') {
    return { sql: `${alias}.${column} ${sql}`, params };
  }

  if (value instanceof F) {
    return { sql: `${alias}.${column} ${sql} ${value.toSql(alias)}`, params };
  }

  const paramKey = leafParameterName(alias, column);

  if (operator === 'in' || operator === 'notIn') {
    params[paramKey] = value;
    return { sql: `${alias}.${column} ${sql} (:...${paramKey})`, params };
  }

  if (isLiteralMatch(operator)) {
    params[paramKey] = literalPattern(operator, value);
    return { sql: `${alias}.${column} ${sql} :${paramKey} ESCAPE '${LIKE_ESCAPE}'`, params };
  }

  params[paramKey] = value;
  return { sql: `${alias}.${column} ${sql} :${paramKey}`, params };
}

/**
 * Add a Case expression to the SELECT list under a selection alias.
 * Registers every bound parameter from the expression on the query builder.
 * Returns the same builder for chaining.
 */
export function addCaseSelect<T extends object>(
  qb: SelectQueryBuilder<T>,
  expression: Case,
  selectionAlias: string,
  alias?: string,
): SelectQueryBuilder<T> {
  const { sql, params } = expression.toSql(alias ?? qb.alias);
  qb.addSelect(sql, selectionAlias);
  if (Object.keys(params).length > 0) {
    qb.setParameters(params);
  }
  return qb;
}

// ---------------------------------------------------------------------------
// Boolean combinators — and / or / not
// ---------------------------------------------------------------------------

/**
 * Logical AND of zero or more predicates. Rejects zero predicates — an empty
 * AND is ambiguous rather than a meaningful identity value.
 */
export function and(...predicates: readonly Q[]): QNode {
  if (predicates.length === 0) {
    throw new QueryExpressionError(
      'invalid_expression',
      'an "and" group requires at least one condition',
    );
  }
  for (const p of predicates) {
    if (!isQ(p)) {
      throw new QueryExpressionError('invalid_expression', 'invalid query predicate');
    }
  }
  return Object.freeze({ kind: 'and', children: predicates });
}

/**
 * Logical OR of zero or more predicates. Rejects zero predicates — an empty
 * OR is ambiguous rather than a meaningful identity value.
 */
export function or(...predicates: readonly Q[]): QNode {
  if (predicates.length === 0) {
    throw new QueryExpressionError(
      'invalid_expression',
      'an "or" group requires at least one condition',
    );
  }
  for (const p of predicates) {
    if (!isQ(p)) {
      throw new QueryExpressionError('invalid_expression', 'invalid query predicate');
    }
  }
  return Object.freeze({ kind: 'or', children: predicates });
}

/** Logical NOT of a single predicate. */
export function not(predicate: Q): QNode {
  if (!isQ(predicate)) {
    throw new QueryExpressionError('invalid_expression', 'invalid query predicate');
  }
  return Object.freeze({ kind: 'not', children: [predicate] });
}

/** Structural check: does the value have a recognized Q discriminant? */
function isQ(value: unknown): value is Q {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false;
  }
  // Narrowed by `in` above; TS infers `kind` as `unknown`.
  const { kind } = value;
  return kind === 'leaf' || kind === 'and' || kind === 'or' || kind === 'not';
}

// ---------------------------------------------------------------------------
// applyQ — integration seam
// ---------------------------------------------------------------------------

/**
 * Apply a query predicate to a TypeORM SelectQueryBuilder.
 *
 * Wraps the compiled expression in `andWhere(new Brackets(...))` so the
 * predicate composes naturally with any pre-existing WHERE condition on
 * the builder. The alias defaults to `qb.alias`; pass an explicit alias
 * when the builder's own alias differs from the intended table reference.
 */
export function applyQ<T extends object>(
  qb: SelectQueryBuilder<T>,
  predicate: Q,
  alias?: string,
): SelectQueryBuilder<T> {
  if (!isQ(predicate)) {
    throw new QueryExpressionError('invalid_expression', 'invalid query predicate');
  }
  return qb.andWhere(new Brackets((w) => renderQ(w, predicate, alias ?? qb.alias)));
}

// ---------------------------------------------------------------------------
// renderQ — internal compiler (leaf + compound)
// ---------------------------------------------------------------------------

/** SQL keyword for each operator. */
const OPERATOR_SQL: Record<QOperator, string> = {
  eq: '=',
  ne: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  in: 'IN',
  notIn: 'NOT IN',
  isNull: 'IS NULL',
  notNull: 'IS NOT NULL',
  like: 'LIKE',
  contains: 'LIKE',
  startsWith: 'LIKE',
  endsWith: 'LIKE',
};

function renderQ(w: WhereExpressionBuilder, predicate: Q, alias: string): void {
  if (!isQ(predicate)) {
    throw new QueryExpressionError('invalid_expression', 'invalid query predicate');
  }
  if (predicate.kind === 'leaf') {
    renderLeaf(w, predicate, alias);
    return;
  }
  // A hand-built `not` with several children would render only the first and
  // silently drop the rest of the predicate.
  if (
    !Array.isArray(predicate.children) ||
    predicate.children.length === 0 ||
    (predicate.kind === 'not' && predicate.children.length !== 1)
  ) {
    throw new QueryExpressionError('invalid_expression', 'invalid query predicate');
  }

  switch (predicate.kind) {
    case 'and':
      w.andWhere(
        new Brackets((inner) => {
          for (const child of predicate.children) {
            renderQ(inner, child, alias);
          }
        }),
      );
      break;
    case 'or':
      // Non-null assertion is safe: the constructor guarantees at least one
      // child, so children[0] always exists at runtime.
      w.andWhere(
        new Brackets((inner) => {
          inner.where(new Brackets((cb) => renderQ(cb, predicate.children[0]!, alias)));
          for (let i = 1; i < predicate.children.length; i++) {
            inner.orWhere(new Brackets((cb) => renderQ(cb, predicate.children[i]!, alias)));
          }
        }),
      );
      break;
    case 'not':
      // NotBrackets extends Brackets; TypeORM renders it as NOT (...).
      w.andWhere(new NotBrackets((inner) => renderQ(inner, predicate.children[0]!, alias)));
      break;
  }
}

/**
 * Re-validate a leaf at render time and return its operator's SQL. The
 * constructors already validate, but `Q` is a plain interface: a leaf built by
 * hand or deserialized from JSON reaches here unchecked, and its column is
 * interpolated into the statement (for `isNull`/`notNull` with no parameter
 * at all), so the identifier and operator are checked again before any SQL is
 * emitted.
 */
function checkedLeafSql(leaf: QLeaf): string {
  if (typeof leaf.column !== 'string') {
    throw new QueryExpressionError('invalid_identifier', 'invalid column identifier');
  }
  assertValidColumn(leaf.column);
  if (typeof leaf.operator !== 'string' || !Object.hasOwn(OPERATOR_SQL, leaf.operator)) {
    throw new QueryExpressionError('unsupported_operator', 'unknown query operator');
  }
  if (!(leaf.value instanceof Case)) {
    validateOperator(leaf.operator, leaf.value);
  }
  return OPERATOR_SQL[leaf.operator];
}

function leafParameterName(alias: string, column: string): string {
  return uniqueParameterName(`qe_${alias}_${column}`);
}

function renderLeaf(w: WhereExpressionBuilder, predicate: QLeaf, alias: string): void {
  const { column, operator, value } = predicate;
  const sql = checkedLeafSql(predicate);

  // isNull / notNull: no parameter, no value.
  if (operator === 'isNull' || operator === 'notNull') {
    w.andWhere(`${alias}.${column} ${sql}`);
    return;
  }

  // Column-to-column comparison: value is an F reference rather than a
  // literal. Emit a direct column reference instead of a bound parameter.
  if (value instanceof F) {
    w.andWhere(`${alias}.${column} ${sql} ${value.toSql(alias)}`);
    return;
  }

  // Case expression as a comparison value: inline the CASE expression and
  // register its bound parameters on the WHERE builder.
  if (value instanceof Case) {
    const { sql: caseSql, params } = value.toSql(alias);
    w.andWhere(`${alias}.${column} ${sql} (${caseSql})`, params);
    return;
  }

  const paramKey = leafParameterName(alias, column);

  // in / notIn: array parameter with spread binding.
  if (operator === 'in' || operator === 'notIn') {
    w.andWhere(`${alias}.${column} ${sql} (:...${paramKey})`, { [paramKey]: value });
    return;
  }

  // Literal match: escape the text into a pattern and declare the escape
  // character, so `%` and `_` in user input match themselves.
  if (isLiteralMatch(operator)) {
    w.andWhere(`${alias}.${column} ${sql} :${paramKey} ESCAPE '${LIKE_ESCAPE}'`, {
      [paramKey]: literalPattern(operator, value),
    });
    return;
  }

  // Scalar comparison: bound parameter.
  w.andWhere(`${alias}.${column} ${sql} :${paramKey}`, { [paramKey]: value });
}
