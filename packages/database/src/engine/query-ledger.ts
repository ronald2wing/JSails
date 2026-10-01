/**
 * The query ledger: every statement a {@link Conn} runs is recorded in each
 * ledger active in its async context. It is the one place all statements
 * pass and where their duration is known, so the request timing header, the
 * development N+1 warning, statement budgets in tests, and `countStatements`
 * all read from it instead of hooking the drivers.
 *
 * A record never holds parameter values. A ledger without `detail` (the
 * production setting) keeps only the count and the total time; with `detail`
 * it also keeps each statement's SQL, origin and duration, and computes its
 * shape (literals and parameter lists collapsed) only when asked.
 *
 * The async context lives under a `Symbol.for` key, so duplicate copies of
 * this package in one process record into the same ledgers.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** One recorded statement. */
export interface QueryRecord {
  readonly sql: string;
  /** The SQL with literals, placeholders and repeated value lists collapsed. */
  readonly shape: string;
  /** Wall time from send to result, in milliseconds. */
  readonly ms: number;
  /** Who issued it (see `QueryOptions.origin`). */
  readonly origin: string;
}

/** A shape that ran more than once, with how often. */
export interface RepeatedShape {
  readonly shape: string;
  readonly count: number;
}

/** Statements recorded while a {@link withQueryLedger} scope was active. */
export interface QueryLedger {
  /** Whether records are kept, or only the count and total. */
  readonly detail: boolean;
  readonly count: number;
  readonly totalMs: number;
  /** Each statement, oldest first; empty without `detail`. */
  readonly records: readonly QueryRecord[];
  /** Records not kept because the ledger reached its record cap. */
  readonly dropped: number;
  /** Shapes recorded at least `minimum` times (default 2), most frequent first. */
  repeatedShapes(minimum?: number): readonly RepeatedShape[];
}

/** Options for {@link createQueryLedger}. */
export interface QueryLedgerOptions {
  /** Keep each statement's record. Default `false`. */
  readonly detail?: boolean;
  /** The most records kept; later ones only count. Default 10000. */
  readonly maxRecords?: number;
}

const DEFAULT_MAX_RECORDS = 10_000;

/** Collapse literals, placeholders and repeated value lists. */
export function statementShape(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\$\d+/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\(\s*\?(?:\s*,\s*\?)*\s*\)/g, '(?...)')
    .replace(/\(\?\.\.\.\)(?:\s*,\s*\(\?\.\.\.\))+/g, '(?...)...')
    .replace(/\s+/g, ' ')
    .trim();
}

class LedgerRecord implements QueryRecord {
  #shape: string | undefined;

  constructor(
    readonly sql: string,
    readonly ms: number,
    readonly origin: string,
  ) {}

  get shape(): string {
    this.#shape ??= statementShape(this.sql);
    return this.#shape;
  }
}

class Ledger implements QueryLedger {
  count = 0;
  totalMs = 0;
  dropped = 0;
  readonly records: LedgerRecord[] = [];

  constructor(
    readonly detail: boolean,
    private readonly maxRecords: number,
  ) {}

  record(sql: string, ms: number, origin: string): void {
    this.count += 1;
    this.totalMs += ms;
    if (!this.detail) return;
    if (this.records.length < this.maxRecords) this.records.push(new LedgerRecord(sql, ms, origin));
    else this.dropped += 1;
  }

  repeatedShapes(minimum = 2): readonly RepeatedShape[] {
    const counts = new Map<string, number>();
    for (const record of this.records) {
      counts.set(record.shape, (counts.get(record.shape) ?? 0) + 1);
    }
    return [...counts]
      .filter(([, count]) => count >= minimum)
      .sort((a, b) => b[1] - a[1])
      .map(([shape, count]) => Object.freeze({ shape, count }));
  }
}

interface LedgerFrame {
  readonly ledger: Ledger;
  readonly parent: LedgerFrame | undefined;
}

const SHARED_KEY = Symbol.for('jsails.database.queryLedger.v1');
const holder = globalThis as unknown as Record<symbol, AsyncLocalStorage<LedgerFrame> | undefined>;
const store: AsyncLocalStorage<LedgerFrame> = (holder[SHARED_KEY] ??=
  new AsyncLocalStorage<LedgerFrame>());

/** A new, empty ledger. */
export function createQueryLedger(options: QueryLedgerOptions = {}): QueryLedger {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 0) {
    throw new RangeError('maxRecords must be a non-negative integer');
  }
  return new Ledger(options.detail ?? false, maxRecords);
}

/**
 * Run `fn` with `ledger` active: statements run inside it, including from
 * promises it starts, are recorded there and in every enclosing ledger.
 */
export function withQueryLedger<T>(ledger: QueryLedger, fn: () => T): T {
  // Duck-typed, not instanceof: a ledger from a duplicate package copy is valid here.
  if (typeof (ledger as Partial<Ledger>).record !== 'function') {
    throw new TypeError('not a ledger from createQueryLedger()');
  }
  return store.run({ ledger: ledger as Ledger, parent: store.getStore() }, fn);
}

/** The innermost active ledger, if any. */
export function currentQueryLedger(): QueryLedger | undefined {
  return store.getStore()?.ledger;
}

/** Record one statement in every active ledger. Called by the engine's connections. */
export function recordStatement(sql: string, ms: number, origin: string): void {
  for (let frame = store.getStore(); frame !== undefined; frame = frame.parent) {
    frame.ledger.record(sql, ms, origin);
  }
}

/** Whether any ledger is active, so the caller can skip timing when none is. */
export function ledgerActive(): boolean {
  return store.getStore() !== undefined;
}
