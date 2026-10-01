/**
 * Admin relation actions: attach/detach action builders that adapt a
 * {@link RelationManager} into ordinary {@link AdminAction} descriptors.
 *
 * `defineAttachAction(spec)` returns a frozen {@link AdminAction} whose `run`
 * maps the selected records' ids (via the shared `recordId` helper) and calls
 * `spec.attach({ session, parentId, relatedIds })`; `defineDetachAction(spec)`
 * is the mirror over `spec.detach`. Both declare `requiresParent`, so the
 * action routes demand a `?parent=` id on the confirm page and carry it into
 * the run as `_parent`; the callback always receives the real parent id.
 *
 * The builders default `name`/`label` to `attach`/`Attach` and
 * `detach`/`Detach`, validate `manager` is a {@link RelationManager}-shaped
 * object and the callback is a function, and add no HTTP surface of their own.
 * The module is ORM-free and performs no I/O.
 */

import type { Session } from 'jsails';
import { isRecord } from 'jsails/plugin-sdk';

import type { AdminAction, AdminActionContext } from './actions.js';
import { hasShape, RELATION_MANAGER_SHAPE } from './descriptor-shape.js';
import { AdminDefinitionError } from './errors.js';
import type { RelationManager } from './relation-manager.js';
import { recordId } from './resource/access.js';

/** Context handed to an attach or detach callback. */
export interface RelationActionContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The parent record the related ids are attached to or detached from. */
  readonly parentId: string;
  /** The selected related records' ids. */
  readonly relatedIds: readonly string[];
}

/** The spec fields an attach and a detach action share. */
interface RelationActionDefinition {
  /** Action name; defaults per kind. */
  readonly name?: string;
  /** Human button label; defaults per kind. */
  readonly label?: string;
  /** The relation manager this action targets. */
  readonly manager: RelationManager;
}

/** Specification passed to {@link defineAttachAction}. */
export interface AttachActionDefinition extends RelationActionDefinition {
  /** Required: attach the resolved related ids to the parent record. */
  readonly attach: (context: RelationActionContext) => Promise<void>;
}

/** Specification passed to {@link defineDetachAction}. */
export interface DetachActionDefinition extends RelationActionDefinition {
  /** Required: detach the resolved related ids from the parent record. */
  readonly detach: (context: RelationActionContext) => Promise<void>;
}

/** The two relation action kinds and their defaults. */
const KINDS = Object.freeze({
  attach: Object.freeze({ label: 'Attach', factory: 'defineAttachAction' }),
  detach: Object.freeze({ label: 'Detach', factory: 'defineDetachAction' }),
});

/**
 * Define an attach action: a bulk-action descriptor that calls `attach` with
 * the parent id from the action context and the selected records' ids.
 */
export function defineAttachAction(spec: AttachActionDefinition): AdminAction {
  return defineRelationAction('attach', spec, spec.attach);
}

/**
 * Define a detach action: a bulk-action descriptor that calls `detach` with
 * the parent id from the action context and the selected records' ids.
 */
export function defineDetachAction(spec: DetachActionDefinition): AdminAction {
  return defineRelationAction('detach', spec, spec.detach);
}

/** Validate the shared spec fields and build the frozen action for one kind. */
function defineRelationAction(
  kind: keyof typeof KINDS,
  spec: RelationActionDefinition,
  apply: unknown,
): AdminAction {
  const defaults = KINDS[kind];
  if (!isRecord(spec)) {
    throw invalid(`${defaults.factory} requires a spec object`);
  }
  if (!hasShape(spec.manager, RELATION_MANAGER_SHAPE)) {
    throw invalid('relation action manager must be a RelationManager descriptor');
  }
  if (typeof apply !== 'function') {
    throw invalid(`${kind} action must define a ${kind} function`);
  }
  if (spec.name !== undefined && typeof spec.name !== 'string') {
    throw invalid(`${kind} action name must be a string when present`);
  }
  if (spec.label !== undefined && typeof spec.label !== 'string') {
    throw invalid(`${kind} action label must be a string when present`);
  }
  const callback = apply as (context: RelationActionContext) => Promise<void>;
  return Object.freeze({
    name: spec.name ?? kind,
    label: spec.label ?? defaults.label,
    requiresParent: true as const,
    run: async (context: AdminActionContext, records: readonly Record<string, unknown>[]) => {
      if (context.parentId === undefined) {
        throw new AdminDefinitionError('missing_parent', `${kind} action requires a parent id`);
      }
      const relatedIds = resolveRecordIds(records);
      await callback({ session: context.session, parentId: context.parentId, relatedIds });
    },
  });
}

/** Raise the relation action's value-free definition error. */
function invalid(message: string): AdminDefinitionError {
  return new AdminDefinitionError('invalid_relation_action', message);
}

/** Extract record ids from the resolved records via the shared `recordId` helper. */
function resolveRecordIds(records: readonly Record<string, unknown>[]): string[] {
  const ids: string[] = [];
  for (const record of records) {
    const id = recordId(record);
    if (id !== undefined) {
      ids.push(id);
    }
  }
  return ids;
}
