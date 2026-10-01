/**
 * Declared effects on the run's driver, in row form (record writes) and set
 * form (`updateAll`, `deleteAll`, `insertAll`): counter caches and touch
 * through every move of a row; dependents lowered to the foreign-key action
 * (a destroy with 10,000 nullified children is one statement), to one
 * statement (a child with `lockVersion`: two), and to keyset batches through
 * the pipeline; and the refusals of a set write that would skip hooks or an
 * effect with no set form.
 */

import assert from 'node:assert/strict';
import { before, beforeEach, it } from 'node:test';

import { query, type JsailsDataSource } from '../../src/index.js';
import { forEachDriver } from '../../src/testing/index.js';
import { suiteLifecycle } from '../query/fixtures/open-data-source.js';
import { openWriteSource, statementsOf } from './fixtures/open-write-source.js';
import {
  Checkpoint,
  HOOK_CALLS,
  Log,
  Member,
  Milestone,
  Note,
  Pin,
  PIPELINE_MODELS,
  Project,
  resetHooks,
  Squad,
  Task,
  Team,
} from './fixtures/pipeline-models.js';

const MANY = 10_000;

async function counts(team: Team): Promise<{ stored: number; actual: number }> {
  const fresh = await Team.find(team.id);
  return { stored: fresh.membersCount, actual: await Member.where({ teamId: team.id }).count() };
}

void forEachDriver('declared effects', () => {
  const lifecycle = suiteLifecycle();
  let dataSource: JsailsDataSource;

  before(async () => {
    dataSource = await openWriteSource(lifecycle, PIPELINE_MODELS);
  });

  beforeEach(async () => {
    await Member.all().deleteAll({ skipHooks: true });
    await Note.all().deleteAll();
    await Log.all().deleteAll();
    await Team.all().deleteAll();
    await Task.all().deleteAll();
    await Squad.all().deleteAll();
    await Pin.all().deleteAll();
    await Checkpoint.all().deleteAll();
    await Milestone.all().deleteAll({ skipHooks: true });
    await Project.all().deleteAll({ skipEffects: true });
    resetHooks();
  });

  it('keeps a counter cache and touch through every move of a row', async () => {
    const a = await Team.create({ name: 'A' });
    const b = await Team.create({ name: 'B' });
    assert.equal(a.touchedAt, null);
    const member = await Member.create({ name: 'mover', teamId: a.id });
    assert.deepEqual(await counts(a), { stored: 1, actual: 1 });
    const touched = (await Team.find(a.id)).touchedAt;
    assert.ok(touched instanceof Date);

    member.teamId = b.id;
    await member.save();
    assert.deepEqual(await counts(a), { stored: 0, actual: 0 });
    assert.deepEqual(await counts(b), { stored: 1, actual: 1 });

    member.teamId = null;
    await member.save();
    assert.deepEqual(await counts(b), { stored: 0, actual: 0 });

    member.teamId = a.id;
    await member.save();
    member.name = 'renamed';
    const stays = await statementsOf(() => member.save());
    assert.equal(stays.length, 2, 'a row that stays with its parent only touches it');
    assert.doesNotMatch(stays[1] as string, /members_count/);
    assert.deepEqual(await counts(a), { stored: 1, actual: 1 });

    await member.destroy();
    assert.deepEqual(await counts(a), { stored: 0, actual: 0 });
  });

  it('recounts the parents of a set write, whatever its condition matched', async () => {
    const a = await Team.create({ name: 'A' });
    const b = await Team.create({ name: 'B' });
    const inserted = await Member.insertAll(
      [
        { name: 'one', teamId: a.id },
        { name: 'two', teamId: a.id },
        { name: 'three', teamId: b.id },
      ],
      { skipHooks: true },
    );
    assert.equal(inserted.affected, 3);
    assert.deepEqual(await counts(a), { stored: 2, actual: 2 });
    assert.deepEqual(await counts(b), { stored: 1, actual: 1 });

    // The rows leave the condition they matched; the recount still sees them.
    await Member.where({ teamId: a.id }).updateAll({ teamId: b.id }, { skipHooks: true });
    assert.deepEqual(await counts(a), { stored: 0, actual: 0 });
    assert.deepEqual(await counts(b), { stored: 3, actual: 3 });

    await Member.where({ name: 'one' }).deleteAll({ skipHooks: true });
    assert.deepEqual(await counts(b), { stored: 2, actual: 2 });
    assert.equal(HOOK_CALLS.length, 0, 'set writes run no hooks');
  });

  it('refuses a set write that would skip hooks or validation', async () => {
    await assert.rejects(() => Member.all().updateAll({ role: 'x' }), {
      code: 'query.set_write_skips_hooks',
      context: { model: 'Member' },
    });
    await assert.rejects(() => Member.all().deleteAll(), { code: 'query.set_write_skips_hooks' });
    await assert.rejects(() => Member.insertAll([{ name: 'n' }]), {
      code: 'query.set_write_skips_hooks',
    });
    // Validation counts for an update, not for a delete.
    await assert.rejects(() => Team.all().updateAll({ name: 'x' }), {
      code: 'query.set_write_skips_hooks',
    });
    await Team.all().deleteAll();
    await assert.rejects(
      () => Member.all().updateAll({ role: 'x' }, { skipHooks: 'yes' } as never),
      {
        code: 'query.invalid_argument',
      },
    );
  });

  it('nullifies 10,000 children by the foreign-key action in one statement', async () => {
    const team = await Team.create({ name: 'Many notes' });
    await Note.insertAll(
      Array.from({ length: MANY }, (_, index) => ({ body: `n${index}`, teamId: team.id })),
    );
    const sent = await statementsOf(() => team.destroy());
    assert.equal(sent.length, 1, sent.join('\n'));
    assert.match(sent[0] as string, /^DELETE /);
    assert.equal(await Note.where({ teamId: null }).count(), MANY);
  });

  it('nullifies 10,000 versioned children in two statements, bumping their version', async () => {
    const squad = await Squad.create({ name: 'Many tasks' });
    await Task.insertAll(
      Array.from({ length: MANY }, (_, index) => ({ title: `t${index}`, squadId: squad.id })),
    );
    const sent = await statementsOf(() => squad.destroy());
    assert.equal(sent.length, 2, sent.join('\n'));
    assert.match(sent[0] as string, /^UPDATE /);
    assert.match(sent[1] as string, /^DELETE /);
    assert.equal(await Task.where({ squadId: null, lockVersion: 1 }).count(), MANY);
  });

  it('destroys dependents by the action, by statement, and through the pipeline', async () => {
    const team = await Team.create({ name: 'Logged' });
    await Log.insertAll([
      { line: 'a', teamId: team.id },
      { line: 'b', teamId: team.id },
    ]);
    await team.destroy();
    assert.equal(await Log.all().count(), 0, 'ON DELETE CASCADE');

    const project = await Project.create({ name: 'Big' });
    const other = await Project.create({ name: 'Other' });
    const milestones = 501;
    await Milestone.insertAll(
      Array.from({ length: milestones }, (_, index) => ({
        title: `m${index}`,
        projectId: project.id,
      })),
      { skipHooks: true },
    );
    const first = await Milestone.findBy({ title: 'm0' });
    assert.ok(first !== null);
    await Checkpoint.create({ label: 'c', milestoneId: first.id });
    await Pin.insertAll([
      { label: 'mine', ownerType: 'Project', ownerId: project.id },
      { label: 'same id, other type', ownerType: 'Team', ownerId: project.id },
      { label: 'other project', ownerType: 'Project', ownerId: other.id },
    ]);
    const sent = await statementsOf(() => project.destroy());
    const batches = sent.filter((sql) => /^SELECT /.test(sql) && /wp_milestones/.test(sql));
    assert.equal(batches.length, 2, 'keyset batches of 500');
    assert.equal(HOOK_CALLS.filter((call) => call.hook === 'afterDelete').length, milestones);
    assert.equal(await Milestone.all().count(), 0);
    assert.equal(await Checkpoint.all().count(), 0);
    assert.deepEqual(
      (await Pin.all().orderBy('label').getMany()).map((pin) => pin.label),
      ['other project', 'same id, other type'],
    );
  });

  it('applies dependents in set form, or refuses a set delete that cannot', async () => {
    const squad = await Squad.create({ name: 'S' });
    await Task.create({ title: 't', squadId: squad.id });
    await Squad.where({ name: 'S' }).deleteAll();
    assert.equal(await Task.where({ squadId: null, lockVersion: 1 }).count(), 1);

    const project = await Project.create({ name: 'P' });
    await Milestone.insertAll([{ title: 'm', projectId: project.id }], { skipHooks: true });
    await Pin.create({ label: 'p', ownerType: 'Project', ownerId: project.id });
    await assert.rejects(() => Project.all().deleteAll(), {
      code: 'query.unsupported_set_write',
      context: { model: 'Project', effect: 'dependent' },
    });
    assert.equal(await Project.all().count(), 1, 'nothing was written');
    await Project.all().deleteAll({ skipEffects: true });
    assert.equal(await Milestone.all().count(), 0, 'the foreign-key action still applies');
    assert.equal(await Pin.all().count(), 1, 'a skipped statement-form dependent is left alone');
  });

  it('writes nothing of a set write whose effect fails', async () => {
    const team = await Team.create({ name: 'T' });
    await Member.insertAll([{ name: 'm', teamId: team.id }], { skipHooks: true });
    await assert.rejects(
      dataSource.transaction(async () => {
        await Member.all().updateAll({ teamId: null }, { skipHooks: true });
        assert.deepEqual(await counts(team), { stored: 0, actual: 0 });
        throw new Error('roll back');
      }),
      /roll back/,
    );
    assert.deepEqual(await counts(team), { stored: 1, actual: 1 });
    assert.equal((await query(Member).getMany()).length, 1);
  });
});
