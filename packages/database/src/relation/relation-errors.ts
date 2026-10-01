/**
 * The relation loader's error codes (`relation.*`): a relation read before it
 * was loaded, a malformed include or load option, parents that are not
 * records of the model, an include on a query of plain rows, a level that
 * read more rows than its `maxRows`, a polymorphic row naming no model of
 * the data source, and a count of a `belongsTo`. Messages are fixed text;
 * the context holds model and relation names and fixed words only, never a
 * key or a stored type value.
 */

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

const RELATION_ERRORS = {
  not_loaded: {
    kind: 'internal',
    message: 'relation {relation} of {model} was read before it was loaded',
    context: { model: 'identifier', relation: 'identifier' },
    suggestion:
      'load it with the query (includes) or with loadRelation before reading it; an unloaded relation is never empty',
  },
  invalid_option: {
    kind: 'internal',
    message: 'option {option} of relation {model}.{relation} is invalid',
    context: {
      model: 'identifier',
      relation: 'identifier',
      option: ['options', 'where', 'order', 'limit', 'maxRows', 'include'],
    },
    suggestion:
      'limit applies to a to-many relation, order to a to-many or hasOne relation, and a polymorphic belongsTo takes neither where nor order',
  },
  invalid_include: {
    kind: 'internal',
    message: 'the include of {model} is malformed or names a relation twice',
    context: { model: 'identifier' },
    suggestion:
      'include a relation name, a list of names, or an object of names to true or to load options, each relation once: includes({ comments: { limit: 3 } })',
  },
  invalid_parents: {
    kind: 'internal',
    message: 'the parents given for {model} are not its records',
    context: { model: 'identifier' },
    suggestion:
      'pass records of the model, as a query of it returns them; loadRelationMap also takes its plain rows',
  },
  plain_rows: {
    kind: 'internal',
    message: 'a query of {model} that returns plain rows cannot include relations',
    context: { model: 'identifier' },
    suggestion:
      'relations load onto records: drop select(), or read the related rows with loadRelationMap',
  },
  too_many_rows: {
    kind: 'internal',
    message: 'loading relation {model}.{relation} read more rows than its maxRows',
    context: { model: 'identifier', relation: 'identifier' },
    suggestion: 'narrow the load with where or a per-parent limit, or raise maxRows',
  },
  unknown_target: {
    kind: 'internal',
    message: 'a {model} row names a {relation} target that is not a model of the data source',
    context: { model: 'identifier', relation: 'identifier' },
    suggestion: 'list every model a polymorphic relation can name in the data source models',
  },
  not_countable: {
    kind: 'internal',
    message: 'relation {model}.{relation} is a belongsTo, which has no count',
    context: { model: 'identifier', relation: 'identifier' },
    suggestion: 'count a hasMany, hasOne or through relation',
  },
} as const;

/** The relation loader's codes. */
export const RelationErrors: ErrorRegistry<'relation', typeof RELATION_ERRORS> = defineErrors(
  'relation',
  RELATION_ERRORS,
);
