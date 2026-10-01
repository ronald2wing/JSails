/**
 * The query layer's error codes (`query.*`): a query constructed from parts
 * its data source did not make, a malformed argument to a `ModelQuery`
 * method, a set write or batch walk the query's shape does not allow, a set
 * write that would skip record hooks or an effect it cannot apply without
 * the caller's acknowledgement, and a relation a filter or a load cannot
 * follow.
 * Messages are fixed text; the context holds model, relation and method
 * names and fixed words only.
 */

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

const QUERY_ERRORS = {
  invalid_context: {
    kind: 'internal',
    message: 'a query was given a context, codecs or state its data source did not make',
    suggestion: 'start a query from a model (Post.where, query(PostTag)) or a data handle',
  },
  invalid_argument: {
    kind: 'internal',
    message: 'argument {argument} of {method} on {model} is invalid',
    context: { model: 'identifier', method: 'identifier', argument: 'identifier' },
  },
  invalid_set_write: {
    kind: 'internal',
    message: 'a set write on {model} cannot carry {part}',
    context: { model: 'identifier', part: ['limit', 'offset', 'lock', 'select'] },
    suggestion: 'narrow the rows with where(); updateAll and deleteAll change every matching row',
  },
  unsupported_set_write: {
    kind: 'internal',
    message: 'a set write on {model} cannot apply its {effect} effect',
    context: { model: 'identifier', effect: ['dependent', 'attachment'] },
    suggestion:
      'walk the rows with findEach and save or destroy each record, or pass { skipEffects: true } to write without the effect',
  },
  set_write_skips_hooks: {
    kind: 'internal',
    message: 'a set write on {model} would skip its record hooks or validation',
    context: { model: 'identifier' },
    suggestion: 'pass { skipHooks: true } to write without them, or save each record so they run',
  },
  invalid_batch: {
    kind: 'internal',
    message: 'a batch walk on {model} cannot carry {part}',
    context: { model: 'identifier', part: ['offset'] },
    suggestion: 'continue a walk with where() on the order columns instead of an offset',
  },
  unknown_relation: {
    kind: 'internal',
    message: 'model {model} has no relation {relation}',
    context: { model: 'identifier', relation: 'identifier' },
  },
  unsupported_relation: {
    kind: 'internal',
    message: 'relation {model}.{relation} cannot be followed',
    context: { model: 'identifier', relation: 'identifier' },
    suggestion:
      'a filter cannot follow a polymorphic belongsTo, which has no single target table; a through relation must pass through direct relations, and the side its keys are matched on needs a one-column primary key',
  },
  invalid_relation_filter: {
    kind: 'internal',
    message: 'the filter of relation {model}.{relation} must narrow rows only',
    context: { model: 'identifier', relation: 'identifier' },
    suggestion:
      'return a query of the relation target built with where, whereHas, has and scope; no order, limit, offset, lock or select',
  },
} as const;

/** The query layer's codes. */
export const QueryErrors: ErrorRegistry<'query', typeof QUERY_ERRORS> = defineErrors(
  'query',
  QUERY_ERRORS,
);
