/**
 * Public option types for the batch relation loader: the per-relation load
 * spec, the per-relation options, and the top-level `loadRelations` options.
 */

export interface RelationLoadSpec {
  readonly [propertyName: string]: boolean | RelationLoadOptions;
}

export interface RelationLoadOptions {
  /** Nested relations to load under this one. Recurses level-by-level. */
  readonly with?: RelationLoadSpec;
  /** Column allowlist for the related entity (default: all). */
  readonly select?: readonly string[];
  /** Per-relation filter merged into the WHERE clause. */
  readonly where?: Record<string, unknown>;
  /** Order applied to the related rows. */
  readonly order?: Record<string, 'ASC' | 'DESC'>;
  /**
   * Cap related rows per parent. Applied as a post-fetch slice, NOT a SQL
   * LIMIT, because an IN-clause batch query fetches all related rows at once
   * and slicing must happen per parent after grouping.
   */
  readonly limit?: number;
}

export interface LoadRelationsOptions {
  readonly with: RelationLoadSpec;
  /**
   * Loading strategy. Defaults to `'batch'` (IN-clause batching).
   * `'join'` is not yet supported and throws.
   */
  readonly strategy?: 'batch' | 'join';
  /**
   * Safety cap on the number of distinct FK/PK values collected for the
   * IN clause. When the set of distinct values exceeds this bound, only
   * the first N values are used.
   */
  readonly maxRowsPerRelation?: number;
}
