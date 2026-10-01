/**
 * The effect plan, compiled from data alone: parent effects and autosave per
 * relation, each dependent's form (the foreign-key action when that is the
 * whole work, one statement for a polymorphic or versioned child, the
 * pipeline when the child's delete runs anything), decided as a greatest
 * fixed point so a self relation lowers to the action unless it needs the
 * pipeline; a `belongsTo`'s own `onDelete` treated as the inverse's
 * `dependent`; and the models a delete reports as `invalidate`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { column, defineModel, defineTable, type ModelTarget } from '../../../src/model/index.js';
import { effectPlan } from '../../../src/record/effects/plan.js';
import { createStatementCatalog } from '../../../src/statement/index.js';
import {
  Member,
  Milestone,
  PIPELINE_MODELS,
  Project,
  Squad,
  Team,
} from '../fixtures/pipeline-models.js';

function planOf(models: readonly ModelTarget[], model: ModelTarget) {
  const catalog = createStatementCatalog({ dialect: 'postgres', models });
  return effectPlan(catalog, catalog.codecs(model));
}

function forms(models: readonly ModelTarget[], model: ModelTarget): Record<string, string> {
  return Object.fromEntries(
    planOf(models, model).dependents.map((dependent) => [
      dependent.relation ?? `${dependent.child.spec.table}.${dependent.inverse}`,
      `${dependent.kind} ${dependent.form}`,
    ]),
  );
}

function tables(list: readonly { readonly spec: { readonly table: string } }[]): string[] {
  return list.map((codecs) => codecs.spec.table).toSorted();
}

describe('the effect plan', () => {
  it('lists parent effects and autosave relations by relation', () => {
    const member = planOf(PIPELINE_MODELS, Member);
    assert.deepEqual(
      member.parents.map((parent) => ({
        relation: parent.relation,
        fk: parent.fk.column,
        counter: parent.counter?.column,
        touch: parent.touch?.column,
        key: parent.parentKey.column,
      })),
      [
        {
          relation: 'team',
          fk: 'team_id',
          counter: 'members_count',
          touch: 'touched_at',
          key: 'id',
        },
      ],
    );
    assert.deepEqual(
      member.autosave.map((effect) => `${effect.kind} ${effect.relation}`),
      ['belongsTo team'],
    );
    assert.deepEqual(
      planOf(PIPELINE_MODELS, Team).autosave.map((effect) => `${effect.kind} ${effect.relation}`),
      ['hasMany members'],
    );
    assert.equal(planOf(PIPELINE_MODELS, Team).lockVersion?.column, 'lock_version');
    assert.ok(Object.isFrozen(member) && Object.isFrozen(member.parents));
  });

  it('chooses each dependent form from the data', () => {
    assert.deepEqual(forms(PIPELINE_MODELS, Team), {
      notes: 'nullify database',
      logs: 'destroy database',
      'wp_members.team': 'nullify database',
    });
    assert.deepEqual(forms(PIPELINE_MODELS, Squad), { tasks: 'nullify statement' });
    assert.deepEqual(forms(PIPELINE_MODELS, Project), {
      milestones: 'destroy records',
      pins: 'destroy statement',
    });
    assert.deepEqual(forms(PIPELINE_MODELS, Milestone), { checkpoints: 'destroy database' });
  });

  it('reports what the foreign-key actions of a delete change', () => {
    const team = planOf(PIPELINE_MODELS, Team);
    assert.deepEqual(tables(team.cascades), ['wp_logs', 'wp_members', 'wp_notes']);
    const project = planOf(PIPELINE_MODELS, Project);
    assert.deepEqual(tables(project.cascades), [], 'the pipeline destroys the milestones itself');
    assert.deepEqual(tables(project.actionCascades), ['wp_checkpoints', 'wp_milestones']);
  });

  it('lowers a self-referential cascade to the action unless the tree needs the pipeline', () => {
    class Node {}
    defineModel(Node, {
      table: 'ep_nodes',
      columns: { label: column.string(20) },
      relations: {
        parent: { kind: 'belongsTo', target: () => Node, nullable: true },
        children: { kind: 'hasMany', target: () => Node, inverse: 'parent', dependent: 'destroy' },
      },
    });
    assert.deepEqual(forms([Node], Node), { children: 'destroy database' });

    class Hooked {}
    defineModel(
      Hooked,
      {
        table: 'ep_hooked',
        columns: {},
        relations: {
          parent: { kind: 'belongsTo', target: () => Hooked, nullable: true },
          children: {
            kind: 'hasMany',
            target: () => Hooked,
            inverse: 'parent',
            dependent: 'destroy',
          },
        },
      },
      { hooks: { afterCommit: () => undefined } },
    );
    assert.deepEqual(forms([Hooked], Hooked), { children: 'destroy records' });

    // A grandchild that keeps a counter on another parent makes its own
    // parent's delete non-empty, and so its grandparent's.
    const Counted = defineTable({
      table: 'ep_counted',
      columns: { leavesCount: column.integer({ default: 0 }) },
    });
    const Root = defineTable({
      table: 'ep_roots',
      columns: {},
      relations: {
        branches: { kind: 'hasMany', target: () => Branch, inverse: 'root', dependent: 'destroy' },
      },
    });
    const Branch = defineTable({
      table: 'ep_branches',
      columns: {},
      relations: {
        root: { kind: 'belongsTo', target: () => Root },
        leaves: { kind: 'hasMany', target: () => Leaf, inverse: 'branch', dependent: 'destroy' },
      },
    });
    const Leaf = defineTable({
      table: 'ep_leaves',
      columns: {},
      relations: {
        branch: { kind: 'belongsTo', target: () => Branch },
        counted: { kind: 'belongsTo', target: () => Counted, counterCache: 'leavesCount' },
      },
    });
    const models = [Counted, Root, Branch, Leaf];
    assert.deepEqual(forms(models, Branch), { leaves: 'destroy records' });
    assert.deepEqual(forms(models, Root), { branches: 'destroy records' });
  });

  it("treats a belongsTo's own cascade or set null as the inverse's dependent", () => {
    const Parent = defineTable({
      table: 'ep_parents',
      columns: { kidsCount: column.integer({ default: 0 }) },
    });
    const Owner = defineTable({ table: 'ep_owners', columns: {} });
    // Counts on another parent: the action alone would leave the counter stale.
    const Counted = defineTable({
      table: 'ep_counted_kids',
      columns: {},
      relations: {
        owner: { kind: 'belongsTo', target: () => Owner, onDelete: 'cascade' },
        parent: { kind: 'belongsTo', target: () => Parent, counterCache: 'kidsCount' },
      },
    });
    const Plain = defineTable({
      table: 'ep_plain_kids',
      columns: {},
      relations: { owner: { kind: 'belongsTo', target: () => Owner, onDelete: 'cascade' } },
    });
    const Versioned = defineTable({
      table: 'ep_versioned_kids',
      columns: {},
      lockVersion: true,
      relations: {
        owner: { kind: 'belongsTo', target: () => Owner, nullable: true, onDelete: 'set null' },
      },
    });
    const Restricted = defineTable({
      table: 'ep_restricted_kids',
      columns: {},
      relations: { owner: { kind: 'belongsTo', target: () => Owner } },
    });
    const models = [Parent, Owner, Counted, Plain, Versioned, Restricted];
    assert.deepEqual(forms(models, Owner), {
      'ep_counted_kids.owner': 'destroy records',
      'ep_plain_kids.owner': 'destroy database',
      'ep_versioned_kids.owner': 'nullify statement',
    });
    const owner = planOf(models, Owner);
    assert.deepEqual(tables(owner.cascades), ['ep_plain_kids'], 'the pipeline handles the rest');
    assert.deepEqual(tables(owner.actionCascades), [
      'ep_counted_kids',
      'ep_plain_kids',
      'ep_versioned_kids',
    ]);
    // Through the cascade, deleting an owner runs something, so its own owner's must too.
    const Grand = defineTable({ table: 'ep_grands', columns: {} });
    const Middle = defineTable({
      table: 'ep_middles',
      columns: {},
      relations: { grand: { kind: 'belongsTo', target: () => Grand, onDelete: 'cascade' } },
    });
    const Leafy = defineTable({
      table: 'ep_leafy',
      columns: {},
      relations: {
        middle: { kind: 'belongsTo', target: () => Middle, onDelete: 'cascade' },
        parent: { kind: 'belongsTo', target: () => Parent, counterCache: 'kidsCount' },
      },
    });
    assert.deepEqual(forms([Parent, Grand, Middle, Leafy], Grand), {
      'ep_middles.grand': 'destroy records',
    });
  });

  it('leaves out a relation whose target the data source does not list', () => {
    assert.deepEqual(planOf([Member], Member).parents, []);
    assert.deepEqual(planOf([Team], Team).dependents, []);
  });
});
