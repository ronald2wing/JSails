/**
 * Schema intent hints derived from model specs.
 *
 * A model's shape is the desired schema, but some transitions cannot be
 * inferred from a diff: a renamed column or table, a one-off default for a
 * NOT NULL column being added to a populated table, or a column replacement
 * that copies values before dropping the old column. These markers travel as a
 * side-channel (never on the `ColumnDefinition`, where they would create a
 * phantom diff) and drive the reconciler's hints.
 *
 * This module is pure and total: it reads frozen specs and returns hints with
 * no validation or dedup. Ambiguity refusal is the differ's job.
 */

import type {
  ColumnRenameHint,
  ColumnReplacementHint,
  TableRenameHint,
  TemporaryDefaultHint,
} from '../migrations/autodetector.js';
import type { ModelSpec } from '../models/define-model.js';
import { registeredModels } from './model-registry.js';

/**
 * Build column-rename hints from model specs carrying `renamedFrom` markers.
 *
 * Each marked field produces `{ table: spec.table, from: renamedFrom, to }`.
 * For a column, `to` is `column.name`; for an owning many-to-one or one-to-one
 * relation, `to` is the derived FK column (`<name>_id` or an explicit
 * `joinColumn`). An inverse relation owns no column on its own table, so a
 * `renamedFrom` there is skipped. Deterministic order: specs in input order,
 * columns then relations.
 */
export function buildRenameHints(specs: readonly ModelSpec[]): ColumnRenameHint[] {
  const hints: ColumnRenameHint[] = [];
  for (const spec of specs) {
    for (const column of spec.columns) {
      if (column.renamedFrom !== undefined) {
        hints.push({ table: spec.table, from: column.renamedFrom, to: column.name });
      }
    }
    for (const relation of spec.relations) {
      const ownsColumn =
        relation.kind === 'many-to-one' ||
        (relation.kind === 'one-to-one' && relation.owning === true);
      if (!ownsColumn || relation.renamedFrom === undefined) {
        continue;
      }
      hints.push({
        table: spec.table,
        from: relation.renamedFrom,
        to: relation.joinColumn ?? `${relation.name}_id`,
      });
    }
  }
  return hints;
}

/** Column-rename hints for every currently registered model's spec. */
export function buildRenameHintsFromRegistry(): ColumnRenameHint[] {
  return buildRenameHints(registeredModels().map((model) => model.spec));
}

/** Build table-rename hints from specs carrying a class-level `renamedFrom`. */
export function buildTableRenameHints(specs: readonly ModelSpec[]): TableRenameHint[] {
  const hints: TableRenameHint[] = [];
  for (const spec of specs) {
    if (spec.renamedFrom !== undefined) {
      hints.push({ from: spec.renamedFrom, to: spec.table });
    }
  }
  return hints;
}

/** Table-rename hints for every currently registered model's spec. */
export function buildTableRenameHintsFromRegistry(): TableRenameHint[] {
  return buildTableRenameHints(registeredModels().map((model) => model.spec));
}

/** Build one-off default hints from columns carrying `temporaryDefault`. */
export function buildTemporaryDefaultHints(specs: readonly ModelSpec[]): TemporaryDefaultHint[] {
  const hints: TemporaryDefaultHint[] = [];
  for (const spec of specs) {
    for (const column of spec.columns) {
      if (column.temporaryDefault !== undefined) {
        hints.push({
          table: spec.table,
          column: column.name,
          value: column.temporaryDefault,
        });
      }
    }
  }
  return hints;
}

/** One-off default hints for every currently registered model's spec. */
export function buildTemporaryDefaultHintsFromRegistry(): TemporaryDefaultHint[] {
  return buildTemporaryDefaultHints(registeredModels().map((model) => model.spec));
}

/** Build column-replacement hints from columns carrying `replacedFrom`. */
export function buildColumnReplacementHints(specs: readonly ModelSpec[]): ColumnReplacementHint[] {
  const hints: ColumnReplacementHint[] = [];
  for (const spec of specs) {
    for (const column of spec.columns) {
      if (column.replacedFrom !== undefined && column.copyExpression !== undefined) {
        hints.push({
          table: spec.table,
          from: column.replacedFrom,
          to: column.name,
          expression: column.copyExpression,
        });
      }
    }
  }
  return hints;
}

/** Column-replacement hints for every currently registered model's spec. */
export function buildColumnReplacementHintsFromRegistry(): ColumnReplacementHint[] {
  return buildColumnReplacementHints(registeredModels().map((model) => model.spec));
}
