/**
 * Every model is a portable ModelSpec (`scripts/check-schema-portability.mjs`):
 * each `defineModel`/`defineTable` export lowers on PostgreSQL, MariaDB and
 * SQLite with its foreign-key and tenant columns indexed, and the TypeORM
 * models not yet ported are listed in `scripts/expected-failures/data-specs.json`,
 * which may only shrink.
 */
import { checkSchemaPortability } from '../check-schema-portability.mjs';

export const name = 'data-specs';
export const description =
  'every model is a ModelSpec that lowers on all three dialects with indexed keys; TypeORM models may only shrink';
// Model specs are read from each workspace's built modules.
export const needsBuild = true;

export function run({ repoRoot }) {
  return checkSchemaPortability({ root: repoRoot });
}
