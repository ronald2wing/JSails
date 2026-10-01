/**
 * Record validation: the schema a model gives `defineModel` as `validate`,
 * run by the write pipeline on the full instance after the before hooks and
 * before every insert and update. Any schema with a synchronous `safeParse`
 * qualifies (a Zod schema, a `jsails/data` contract's schema), the same
 * contract a `json` column's data contract has.
 *
 * A failure throws `record.invalid` (kind `invalid`, so a boundary answers
 * 422) whose exposed `issues` carry, per finding, the path from the record,
 * a snake_case rule code and the schema author's message, never the value.
 * Set writes and effect writes do not validate.
 */

import type { ErrorIssue } from 'jsails/errors';

import { RecordErrors } from './record-errors.js';

/** A schema the pipeline validates records with. */
export interface RecordValidator {
  safeParse(input: unknown): { readonly success: boolean; readonly error?: unknown };
}

const ISSUE_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** The issues of a failed parse, copied to keys, codes and messages only. */
function issuesOf(error: unknown): readonly ErrorIssue[] {
  const raw = (error as { readonly issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(raw)) return Object.freeze([]);
  const issues: ErrorIssue[] = [];
  for (const item of raw as readonly unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const { path, code, message } = item as Readonly<Record<string, unknown>>;
    const keys = Array.isArray(path)
      ? (path as readonly unknown[]).filter(
          (key): key is string | number => typeof key === 'string' || typeof key === 'number',
        )
      : [];
    issues.push(
      Object.freeze({
        path: Object.freeze(keys),
        code: typeof code === 'string' && ISSUE_CODE.test(code) ? code : 'invalid',
        ...(typeof message === 'string' ? { message } : {}),
      }),
    );
  }
  return Object.freeze(issues);
}

/**
 * Validate `record` of model `model` with `validator`.
 *
 * @throws `record.invalid` with the parse's issues.
 */
export function validateRecord(
  validator: RecordValidator | undefined,
  record: object,
  model: string,
): void {
  if (validator === undefined) return;
  const result = validator.safeParse(record);
  if (result.success) return;
  throw new RecordErrors.Error(
    'invalid',
    { model },
    { payload: { issues: issuesOf(result.error) } },
  );
}
