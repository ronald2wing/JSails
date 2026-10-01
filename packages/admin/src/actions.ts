/**
 * Admin actions: declarative, server-rendered mutations a resource can expose
 * as header, row, or bulk actions.
 *
 * `defineAdminAction(spec)` validates an action specification — a URL-safe
 * `name`, a human `label`, an optional `confirm` prompt, an optional per-record
 * `authorize` callback, an optional success `notice` code, and the trusted
 * `run` callback — and returns a frozen {@link AdminAction} descriptor. The
 * descriptor is inert: it carries callbacks by identity and is only consumed by
 * {@link adminPlugin}, which mounts the confirm-then-run HTTP surface.
 *
 * - A `row` action targets one record; a `bulk` action targets a set of
 *   selected records; a `header` action targets the collection itself (an empty
 *   record set). `run` receives the resolved records and the admin session.
 * - `authorize`, when present, gates each record independently (default-allow
 *   when absent; exact `true` when present). It is evaluated per record for
 *   row/bulk actions before the confirm page renders and again before `run`.
 * - `notice` is a notice code (see `notices.ts`) appended to the success
 *   redirect; the panel's notice registry maps it to a rendered message.
 *
 * The module is ORM-free: it imports only the session contract (a type) and
 * performs no I/O.
 */

import type { Session } from 'jsails';
import { isRecord } from 'jsails/plugin-sdk';

import { AdminDefinitionError } from './errors.js';
import { assertAdminSlug } from './slug.js';

/** Context handed to an action's `run` callback. */
export interface AdminActionContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The panel base path (e.g. `/admin`). */
  readonly path: string;
  /**
   * The parent record id a relation action runs under, carried from the
   * `?parent=` query of the confirm page into the `_parent` form field. Present
   * only when the action declares `requiresParent`.
   */
  readonly parentId?: string;
}

/** Context handed to an action's per-record `authorize` callback. */
export interface AdminActionAuthorizeContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The record the action would run against. */
  readonly record: Record<string, unknown>;
}

/** Per-record authorization; exact `true` allows, everything else denies. */
export type AdminActionAuthorize = (
  context: AdminActionAuthorizeContext,
) => boolean | Promise<boolean>;

/** The trusted action handler; receives the session plus the resolved records. */
export type AdminActionRun = (
  context: AdminActionContext,
  records: readonly Record<string, unknown>[],
) => void | Promise<void>;

/** A frozen, validated action descriptor consumed by {@link adminPlugin}. */
export interface AdminAction {
  /** URL-safe action identifier, unique within a resource. */
  readonly name: string;
  /** Human button label. */
  readonly label: string;
  /** Optional confirmation prompt rendered on the confirm page. */
  readonly confirm?: string;
  /** Optional success notice code (see `notices.ts`). */
  readonly notice?: string;
  /** Optional per-record default-deny authorization. */
  readonly authorize?: AdminActionAuthorize;
  /**
   * Whether the action needs a parent record id (a relation attach/detach).
   * The routes then require `?parent=` on the confirm page and `_parent` on
   * the run, answering 400 without one.
   */
  readonly requiresParent?: true;
  /** Required: perform the action against the resolved records. */
  readonly run: AdminActionRun;
}

/** Specification passed to {@link defineAdminAction}. */
export interface AdminActionDefinition {
  /** URL-safe action identifier, unique within a resource. */
  readonly name: string;
  /** Human button label. */
  readonly label: string;
  /** Optional confirmation prompt. */
  readonly confirm?: string;
  /** Optional success notice code. */
  readonly notice?: string;
  /** Optional per-record authorization. */
  readonly authorize?: AdminActionAuthorize;
  /** Whether the action needs a parent record id. */
  readonly requiresParent?: true;
  /** Perform the action against the resolved records. */
  readonly run: AdminActionRun;
}

/** Raise the action's value-free definition error. */
function invalid(message: string): AdminDefinitionError {
  return new AdminDefinitionError('invalid_action', message);
}

/**
 * Validate an action spec and return a frozen descriptor. The callbacks are
 * carried by identity; every other field is copied onto a frozen object.
 */
export function defineAdminAction(spec: AdminActionDefinition): AdminAction {
  if (!isRecord(spec)) {
    throw invalid('defineAdminAction requires a spec object');
  }
  assertAdminSlug(spec.name, { code: 'invalid_action', label: 'admin action name' });
  if (typeof spec.label !== 'string' || spec.label.trim() === '') {
    throw invalid('admin action label must be a non-empty string');
  }
  if (spec.confirm !== undefined && typeof spec.confirm !== 'string') {
    throw invalid('admin action confirm must be a string when present');
  }
  if (spec.notice !== undefined && typeof spec.notice !== 'string') {
    throw invalid('admin action notice must be a string when present');
  }
  if (spec.authorize !== undefined && typeof spec.authorize !== 'function') {
    throw invalid('admin action authorize must be a function when present');
  }
  if (spec.requiresParent !== undefined && spec.requiresParent !== true) {
    throw invalid('admin action requiresParent must be true when present');
  }
  if (typeof spec.run !== 'function') {
    throw invalid('admin action must define a run function');
  }
  return Object.freeze({
    name: spec.name,
    label: spec.label,
    ...(spec.confirm === undefined ? {} : { confirm: spec.confirm }),
    ...(spec.notice === undefined ? {} : { notice: spec.notice }),
    ...(spec.authorize === undefined ? {} : { authorize: spec.authorize }),
    ...(spec.requiresParent === undefined ? {} : { requiresParent: spec.requiresParent }),
    run: spec.run,
  });
}

/** Spec for thin action wrappers whose `label` defaults to a fixed value. */
interface AdminActionWrapperSpec {
  readonly name: string;
  readonly label?: string;
  readonly confirm?: string;
  readonly notice?: string;
  readonly authorize?: AdminActionAuthorize;
  readonly run: AdminActionRun;
}

/**
 * Define a replicate action — a thin wrapper over {@link defineAdminAction} that
 * defaults `label` to `'Replicate'` and `confirm` to a standard prompt.
 */
export function defineReplicateAction(spec: AdminActionWrapperSpec): AdminAction {
  return defineAdminAction({
    ...spec,
    label: spec.label ?? 'Replicate',
    confirm: spec.confirm ?? 'Replicate this record?',
  });
}

/**
 * Define a restore action — a thin wrapper over {@link defineAdminAction} that
 * defaults `label` to `'Restore'`.
 */
export function defineRestoreAction(spec: AdminActionWrapperSpec): AdminAction {
  return defineAdminAction({ ...spec, label: spec.label ?? 'Restore' });
}

/**
 * Define an import action — a thin wrapper over {@link defineAdminAction} that
 * defaults `label` to `'Import'`.
 */
export function defineImportAction(spec: AdminActionWrapperSpec): AdminAction {
  return defineAdminAction({ ...spec, label: spec.label ?? 'Import' });
}
