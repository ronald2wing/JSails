/**
 * Models for the write pipeline suites, one per effect form:
 *
 * - `Team` (optimistic locking, validated) counts and is touched by its
 *   `Member`s, which declare every hook and validation and autosave both
 *   ways (`Member.team`, `Team.members`).
 * - `Team`'s dependents go by the foreign-key action: `Note` (nullify) and
 *   `Log` (destroy); its members' keys are set to null by the action too.
 * - `Squad` nullifies its `Task`s by statement, since they have `lockVersion`.
 * - `Project` destroys its `Milestone`s through the pipeline (they have a
 *   delete hook), each milestone's `Checkpoint`s going by the foreign-key
 *   action, and its polymorphic `Pin`s by statement.
 *
 * Every hook call is appended to `HOOK_CALLS`; `HOOK_FAILURES` makes a hook
 * throw.
 */

import { z } from 'zod';

import { column, defineModel, type ModelTarget } from '../../../src/model/index.js';
import { ApplicationRecord, type RecordHookContext } from '../../../src/record/index.js';
import type { Relation } from '../../../src/relation/index.js';

export class Team extends ApplicationRecord {
  declare id: number;
  declare name: string;
  declare membersCount: number;
  declare touchedAt: Date | null;
  declare lockVersion: number;
  declare members: Relation<Member[]>;
}

export class Member extends ApplicationRecord {
  declare id: number;
  declare name: string;
  declare role: string;
  declare teamId: number | null;
  declare team: Relation<Team | null>;
}

export class Note extends ApplicationRecord {
  declare id: number;
  declare body: string;
  declare teamId: number | null;
}

export class Squad extends ApplicationRecord {
  declare id: number;
  declare name: string;
}

export class Task extends ApplicationRecord {
  declare id: number;
  declare title: string;
  declare squadId: number | null;
  declare lockVersion: number;
}

export class Log extends ApplicationRecord {
  declare id: number;
  declare line: string;
  declare teamId: number;
}

export class Pin extends ApplicationRecord {
  declare id: number;
  declare label: string;
  declare ownerType: string | null;
  declare ownerId: number | null;
}

export class Project extends ApplicationRecord {
  declare id: number;
  declare name: string;
}

export class Milestone extends ApplicationRecord {
  declare id: number;
  declare title: string;
  declare projectId: number;
}

export class Checkpoint extends ApplicationRecord {
  declare id: number;
  declare label: string;
  declare milestoneId: number;
}

/** One hook call: which hook, on which model, and what it was given. */
export interface HookCall {
  readonly hook: string;
  readonly model: string;
  readonly operation: string;
  readonly changes: readonly string[];
  readonly depth: number;
}

/** Every hook call since the last reset, in order. */
export const HOOK_CALLS: HookCall[] = [];

/** Hooks that throw when called, by `<model>.<hook>`. */
export const HOOK_FAILURES = new Set<string>();

/** Forget the recorded calls and planned failures. */
export function resetHooks(): void {
  HOOK_CALLS.length = 0;
  HOOK_FAILURES.clear();
}

function recorder<T extends object>(model: string, hook: string) {
  return (context: RecordHookContext<T>): void => {
    HOOK_CALLS.push({
      hook,
      model,
      operation: context.operation,
      changes: [...context.changes.keys()].map(String).toSorted(),
      depth: context.tx.depth,
    });
    if (HOOK_FAILURES.has(`${model}.${hook}`)) throw new Error(`${model}.${hook} failed`);
  };
}

/** Every hook a model may declare, each recording its calls. */
function recordingHooks<T extends object>(model: string) {
  const names = [
    'beforeSave',
    'beforeInsert',
    'beforeUpdate',
    'beforeDelete',
    'afterInsert',
    'afterUpdate',
    'afterDelete',
    'afterSave',
    'afterCommit',
  ] as const;
  return Object.fromEntries(names.map((name) => [name, recorder<T>(model, name)]));
}

defineModel(
  Team,
  {
    table: 'wp_teams',
    columns: {
      name: column.string(100),
      membersCount: column.integer({ default: 0 }),
      touchedAt: column.timestamp({ nullable: true }),
    },
    lockVersion: true,
    relations: {
      members: { kind: 'hasMany', target: () => Member, inverse: 'team', autosave: true },
      notes: { kind: 'hasMany', target: () => Note, inverse: 'team', dependent: 'nullify' },
      logs: { kind: 'hasMany', target: () => Log, inverse: 'team', dependent: 'destroy' },
    },
  },
  { validate: z.object({ name: z.string().min(1) }) },
);

defineModel(
  Member,
  {
    table: 'wp_members',
    columns: {
      name: column.string(100),
      role: column.string(20, { default: 'member' }),
    },
    relations: {
      team: {
        kind: 'belongsTo',
        target: () => Team,
        nullable: true,
        onDelete: 'set null',
        counterCache: 'membersCount',
        touch: 'touchedAt',
        autosave: true,
      },
    },
  },
  {
    hooks: {
      ...recordingHooks<Member>('Member'),
      beforeSave: (context) => {
        recorder<Member>('Member', 'beforeSave')(context);
        // A hook that normalises a value must have it validated and written.
        context.record.name = context.record.name.trim();
      },
    },
    validate: z.object({ name: z.string().min(1, 'Name is required.') }),
  },
);

defineModel(Note, {
  table: 'wp_notes',
  columns: { body: column.string(100) },
  relations: { team: { kind: 'belongsTo', target: () => Team, nullable: true } },
});

defineModel(Squad, {
  table: 'wp_squads',
  columns: { name: column.string(100) },
  relations: {
    tasks: { kind: 'hasMany', target: () => Task, inverse: 'squad', dependent: 'nullify' },
  },
});

defineModel(Task, {
  table: 'wp_tasks',
  columns: { title: column.string(100) },
  lockVersion: true,
  relations: { squad: { kind: 'belongsTo', target: () => Squad, nullable: true } },
});

defineModel(Log, {
  table: 'wp_logs',
  columns: { line: column.string(100) },
  relations: { team: { kind: 'belongsTo', target: () => Team } },
});

defineModel(Pin, {
  table: 'wp_pins',
  columns: { label: column.string(100) },
  relations: { owner: { kind: 'belongsTo', polymorphic: true, nullable: true } },
});

defineModel(Project, {
  table: 'wp_projects',
  columns: { name: column.string(100) },
  relations: {
    milestones: {
      kind: 'hasMany',
      target: () => Milestone,
      inverse: 'project',
      dependent: 'destroy',
    },
    pins: { kind: 'hasMany', target: () => Pin, inverse: 'owner', dependent: 'destroy' },
  },
});

defineModel(
  Milestone,
  {
    table: 'wp_milestones',
    columns: { title: column.string(100) },
    relations: {
      project: { kind: 'belongsTo', target: () => Project },
      checkpoints: {
        kind: 'hasMany',
        target: () => Checkpoint,
        inverse: 'milestone',
        dependent: 'destroy',
      },
    },
  },
  { hooks: { afterDelete: recorder<Milestone>('Milestone', 'afterDelete') } },
);

defineModel(Checkpoint, {
  table: 'wp_checkpoints',
  columns: { label: column.string(100) },
  relations: { milestone: { kind: 'belongsTo', target: () => Milestone } },
});

/** Every model of the suites, in dependency order. */
export const PIPELINE_MODELS: readonly ModelTarget[] = Object.freeze([
  Team,
  Member,
  Note,
  Squad,
  Task,
  Log,
  Pin,
  Project,
  Milestone,
  Checkpoint,
]);
