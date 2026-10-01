/**
 * The record write pipeline on the run's driver: hook order and what each
 * hook receives, validation of the full instance after the before hooks, the
 * no-op save, statement budgets (an update save is one statement, an insert
 * with a counter cache two), the stale-write contract (optimistic lock, a
 * deleted row, and MariaDB's matched-rows count for a value another session
 * already wrote), atomic writes and the undo of a record's state when its
 * transaction rolls back, autosave both ways (including on update), autosave
 * after a load (a key the application changed is kept, a record assigned or
 * added is pointed, a rolled-back save points again), and the
 * counter-cache-with-validation repro: an effect write never validates or
 * versions the parent.
 */

import assert from 'node:assert/strict';
import { before, beforeEach, it } from 'node:test';

import { loadRelation, query, type JsailsDataSource } from '../../src/index.js';
import { RecordErrors } from '../../src/record/index.js';
import { forEachDriver } from '../../src/testing/index.js';
import { suiteLifecycle } from '../query/fixtures/open-data-source.js';
import {
  openWriteSource,
  statementsOf,
  transactionControlOf,
} from './fixtures/open-write-source.js';
import {
  HOOK_CALLS,
  HOOK_FAILURES,
  Member,
  Note,
  PIPELINE_MODELS,
  resetHooks,
  Squad,
  Task,
  Team,
} from './fixtures/pipeline-models.js';

function hooksCalled(): string[] {
  return HOOK_CALLS.map((call) => `${call.model}.${call.hook}`);
}

void forEachDriver('the record write pipeline', ({ driver }) => {
  const lifecycle = suiteLifecycle();
  let dataSource: JsailsDataSource;

  before(async () => {
    dataSource = await openWriteSource(lifecycle, PIPELINE_MODELS);
  });

  beforeEach(async () => {
    await Member.all().deleteAll({ skipHooks: true });
    await Note.all().deleteAll();
    await Task.all().deleteAll();
    await Squad.all().deleteAll();
    await Team.all().deleteAll({ skipHooks: true });
    resetHooks();
  });

  it('runs the insert hooks in order, around validation and the write', async () => {
    const team = await Team.create({ name: 'Core' });
    const member = await Member.create({ name: '  Ann  ', teamId: team.id });
    assert.deepEqual(hooksCalled(), [
      'Member.beforeSave',
      'Member.beforeInsert',
      'Member.afterInsert',
      'Member.afterSave',
      'Member.afterCommit',
    ]);
    assert.equal(member.name, 'Ann', 'the beforeSave hook normalised the value');
    assert.equal((await Member.find(member.id)).name, 'Ann');
    const [beforeSave, , afterInsert] = HOOK_CALLS;
    assert.deepEqual(beforeSave?.changes, ['name', 'teamId']);
    assert.deepEqual(afterInsert?.changes, ['id', 'name', 'role', 'teamId']);
    assert.ok(HOOK_CALLS.every((call) => call.operation === 'insert' && call.depth === 1));
  });

  it('runs the update and delete hooks with the changed columns only', async () => {
    const member = await Member.create({ name: 'Bo' });
    resetHooks();
    member.role = 'lead';
    await member.save();
    assert.deepEqual(hooksCalled(), [
      'Member.beforeSave',
      'Member.beforeUpdate',
      'Member.afterUpdate',
      'Member.afterSave',
      'Member.afterCommit',
    ]);
    assert.ok(HOOK_CALLS.every((call) => call.changes.join() === 'role'));
    resetHooks();
    await member.destroy();
    assert.deepEqual(hooksCalled(), [
      'Member.beforeDelete',
      'Member.afterDelete',
      'Member.afterCommit',
    ]);
    assert.ok(HOOK_CALLS.every((call) => call.operation === 'delete' && call.changes.length === 0));
    assert.equal(member.isPersisted(), false);
  });

  it('runs afterCommit after the outermost commit, and never after a rollback', async () => {
    await dataSource.transaction(async () => {
      await Member.create({ name: 'Cy' });
      assert.ok(!hooksCalled().includes('Member.afterCommit'), 'not before the commit');
    });
    assert.equal(hooksCalled().at(-1), 'Member.afterCommit');
    resetHooks();
    await assert.rejects(
      dataSource.transaction(async () => {
        await Member.create({ name: 'Di' });
        throw new Error('roll back');
      }),
      /roll back/,
    );
    assert.ok(!hooksCalled().includes('Member.afterCommit'));
    assert.equal(await Member.where({ name: 'Di' }).count(), 0);
  });

  it('validates the full instance after the before hooks, with value-free issues', async () => {
    const error = await Member.create({ name: '   ' }).then(
      () => assert.fail('the save should be refused'),
      (failure: unknown) => failure,
    );
    assert.ok(RecordErrors.is(error, 'invalid'));
    assert.equal(error.kind, 'invalid');
    assert.deepEqual(error.context, { model: 'Member' });
    assert.deepEqual(error.payload.issues, [
      { path: ['name'], code: 'too_small', message: 'Name is required.' },
    ]);
    assert.doesNotMatch(JSON.stringify(error.payload), /"\s+"/);
    assert.deepEqual(hooksCalled(), ['Member.beforeSave', 'Member.beforeInsert']);
    assert.equal(await Member.all().count(), 0);
  });

  it('does nothing for a save with nothing to write', async () => {
    const member = await Member.create({ name: 'Ed' });
    resetHooks();
    assert.deepEqual(await statementsOf(() => member.save()), []);
    assert.deepEqual(HOOK_CALLS, []);
    const loaded = await Member.find(member.id);
    loaded.name = 'Ed';
    assert.deepEqual(await statementsOf(() => loaded.save()), []);
  });

  it('updates in one statement, and inserts with a counter cache in two', async () => {
    const note = await Note.create({ body: 'first' });
    note.body = 'second';
    const update = await statementsOf(() => note.save());
    assert.equal(update.length, 1, update.join('\n'));
    assert.match(update[0] as string, /^UPDATE /);
    const task = await Task.create({ title: 'locked' });
    task.title = 'still one statement';
    assert.equal((await statementsOf(() => task.save())).length, 1);
    assert.equal(task.lockVersion, 1);
    task.title = 'and no transaction';
    assert.deepEqual(await transactionControlOf(() => task.save()), []);

    const team = await Team.create({ name: 'Counted' });
    const insert = await statementsOf(() => Member.create({ name: 'Fi', teamId: team.id }));
    assert.equal(insert.length, 2, insert.join('\n'));
    assert.match(insert[0] as string, /^INSERT /);
    assert.match(insert[1] as string, /^UPDATE /);
    const control = await transactionControlOf(() =>
      Member.create({ name: 'Gus', teamId: team.id }),
    );
    assert.equal(control.at(-1), 'COMMIT', 'the two statements are atomic');
  });

  it('refuses a stale update and delete, and accepts a value another session wrote', async () => {
    const task = await Task.create({ title: 'shared' });
    const mine = await Task.find(task.id);
    const theirs = await Task.find(task.id);
    mine.title = 'mine';
    await mine.save();
    theirs.title = 'theirs';
    await assert.rejects(() => theirs.save(), { code: 'record.stale_record' });
    await assert.rejects(() => theirs.destroy(), { code: 'record.stale_record' });

    // Without a lock, two sessions writing the same value both succeed: the
    // second UPDATE matches its row although it changes nothing, which
    // MariaDB reports as zero affected rows unless the connection counts
    // matched rows.
    const note = await Note.create({ body: 'before' });
    const first = await Note.find(note.id);
    const second = await Note.find(note.id);
    first.body = 'same';
    second.body = 'same';
    await first.save();
    await second.save();
    assert.equal(
      (await query(Note).where({ id: note.id }).updateAll({ body: 'same' })).affected,
      1,
      `${driver} reports the matched row of a no-op update by primary key`,
    );

    const gone = await Note.find(note.id);
    await query(Note).where({ id: note.id }).deleteAll();
    gone.body = 'after';
    await assert.rejects(() => gone.save(), { code: 'record.stale_record' });
  });

  it('rolls a failed write back whole and leaves the record as it was', async () => {
    const team = await Team.create({ name: 'Atomic' });
    HOOK_FAILURES.add('Member.afterSave');
    const member = Member.build({ name: 'Gil', teamId: team.id });
    await assert.rejects(() => member.save(), /Member.afterSave failed/);
    assert.equal(member.isPersisted(), false);
    assert.equal(member.id, undefined, 'the generated key is taken back');
    assert.equal(await Member.all().count(), 0);
    assert.equal((await Team.find(team.id)).membersCount, 0, 'the counter rolled back too');
    HOOK_FAILURES.clear();
    await member.save();
    assert.equal(member.isPersisted(), true);
    assert.equal((await Team.find(team.id)).membersCount, 1);
  });

  it('undoes the state of every record a rolled-back transaction wrote', async () => {
    const task = await Task.create({ title: 'v0' });
    const note = await Note.create({ body: 'kept' });
    const team = Team.build({ name: 'Ghost' });
    await assert.rejects(
      dataSource.transaction(async () => {
        task.title = 'v1';
        await task.save();
        assert.equal(task.lockVersion, 1);
        await note.destroy();
        await team.save();
        throw new Error('roll back');
      }),
      /roll back/,
    );
    assert.equal(task.lockVersion, 0, 'the lock version the row still has');
    assert.deepEqual(task.changed(), ['title'], 'the unsaved change is pending again');
    assert.equal(note.isPersisted(), true);
    assert.equal(team.isPersisted(), false);
    assert.equal(team.id, undefined);
    await task.save();
    assert.equal((await Task.find(task.id)).title, 'v1');
    await note.destroy();
    await team.save();
    assert.equal(await Team.where({ name: 'Ghost' }).count(), 1);
  });

  it('puts a record written several times back as it was before the first write', async () => {
    const task = await Task.create({ title: 'a' });
    await assert.rejects(
      dataSource.transaction(async () => {
        task.title = 'b';
        await task.save();
        task.title = 'c';
        await task.save();
        assert.equal(task.lockVersion, 2);
        throw new Error('roll back');
      }),
      /roll back/,
    );
    assert.equal(task.lockVersion, 0, 'the lock version the row still has');
    assert.deepEqual(task.changed(), ['title'], 'measured against the committed title');
    assert.equal(task.was('title'), 'a');
    await task.save();
    assert.equal((await Task.find(task.id)).title, 'c');

    // A value set back to what an uncommitted write had saved is still a change.
    const note = await Note.create({ body: 'one' });
    await assert.rejects(
      dataSource.transaction(async () => {
        note.body = 'two';
        await note.save();
        note.body = 'three';
        await note.save();
        note.body = 'two';
        throw new Error('roll back');
      }),
      /roll back/,
    );
    assert.deepEqual(note.changed(), ['body']);
    await note.save();
    assert.equal((await Note.find(note.id)).body, 'two');

    // Inserted, then updated: unsaved again, its generated key taken back.
    const built = Task.build({ title: 'x' });
    await assert.rejects(
      dataSource.transaction(async () => {
        await built.save();
        built.title = 'y';
        await built.save();
        throw new Error('roll back');
      }),
      /roll back/,
    );
    assert.equal(built.isPersisted(), false);
    assert.equal(built.id, undefined);
    await built.save();
    assert.equal((await Task.find(built.id)).title, 'y');

    // Updated, then destroyed: saved again, with the committed baseline.
    await assert.rejects(
      dataSource.transaction(async () => {
        built.title = 'z';
        await built.save();
        await built.destroy();
        throw new Error('roll back');
      }),
      /roll back/,
    );
    assert.equal(built.isPersisted(), true);
    assert.equal(built.lockVersion, 0);
    assert.equal(built.was('title'), 'y');
    await built.save();
    assert.equal((await Task.find(built.id)).title, 'z');
  });

  it('keeps a savepoint rollback local to its own writes', async () => {
    const task = await Task.create({ title: 'outer' });
    await dataSource.transaction(async () => {
      task.title = 'saved';
      await task.save();
      const inner = Task.build({ title: 'inner' });
      await assert.rejects(
        dataSource.transaction(async () => {
          await inner.save();
          throw new Error('inner only');
        }),
        /inner only/,
      );
      assert.equal(inner.isPersisted(), false);
      assert.equal(task.lockVersion, 1, 'the outer write stands');
    });
    assert.equal((await Task.find(task.id)).lockVersion, 1);
  });

  it('autosaves a belongsTo target first and hasMany children after the owner', async () => {
    const member = Member.build({ name: 'Hal' });
    member.team = Team.build({ name: 'Built' });
    await member.save();
    const team = member.team;
    assert.equal(team.isPersisted(), true);
    assert.equal(member.teamId, team.id);
    assert.equal((await Team.find(team.id)).membersCount, 1);

    const owner = Team.build({ name: 'Owner' });
    owner.members = [Member.build({ name: 'Ivy' }), Member.build({ name: 'Jo' })];
    await owner.save();
    assert.deepEqual(
      owner.members.map((child) => child.teamId),
      [owner.id, owner.id],
    );
    assert.equal((await Team.find(owner.id)).membersCount, 2);
  });

  it('autosaves edited and added children when a loaded owner is saved again', async () => {
    const created = Team.build({ name: 'Draft' });
    created.members = [Member.build({ name: 'original' })];
    await created.save();

    const loaded = await Team.find(created.id);
    loaded.members = await Member.where({ teamId: loaded.id }).getMany();
    const [child] = loaded.members;
    assert.ok(child !== undefined);
    child.name = 'edited';
    const added = Member.build({ name: 'added on update' });
    loaded.members.push(added);
    await loaded.save();

    assert.equal((await Member.find(child.id)).name, 'edited');
    assert.equal(added.teamId, loaded.id);
    assert.equal((await Member.find(added.id)).name, 'added on update');
    assert.equal(loaded.lockVersion, 0, 'the owner itself had nothing to write');
    assert.equal((await Team.find(loaded.id)).membersCount, 2);
  });

  it('autosaves existing records moved to a loaded owner, which has nothing else to write', async () => {
    const from = await Team.create({ name: 'From' });
    const to = await Team.create({ name: 'To' });
    const moved = await Member.create({ name: 'moved', teamId: from.id });

    const owner = await Team.find(to.id);
    owner.members = [await Member.find(moved.id)];
    await owner.save();
    assert.equal((await Member.find(moved.id)).teamId, to.id, 'the child points at its new owner');
    assert.equal((await Team.find(from.id)).membersCount, 0);
    assert.equal((await Team.find(to.id)).membersCount, 1);

    const member = await Member.find(moved.id);
    member.team = await Team.find(from.id);
    await member.save();
    assert.equal(member.teamId, from.id, 'the foreign key takes the assigned target');
    assert.equal((await Member.find(moved.id)).teamId, from.id);
    assert.equal((await Team.find(from.id)).membersCount, 1);
    assert.equal((await Team.find(to.id)).membersCount, 0);
  });

  it('keeps a foreign key changed after the autosaved target was loaded', async () => {
    const from = await Team.create({ name: 'From' });
    const to = await Team.create({ name: 'To' });
    const created = await Member.create({ name: 'mover', teamId: from.id });

    const member = await Member.where({ id: created.id }).includes('team').getOne();
    assert.ok(member !== null);
    assert.equal(member.team?.id, from.id);
    member.teamId = to.id;
    await member.save();
    assert.equal(member.teamId, to.id, 'the key the application set stands');
    assert.equal((await Member.find(created.id)).teamId, to.id);
    assert.equal((await Team.find(from.id)).membersCount, 0, 'the counter left the old team');
    assert.equal((await Team.find(to.id)).membersCount, 1);

    const [reloaded] = await loadRelation(Member, [await Member.find(created.id)], 'team');
    assert.ok(reloaded !== undefined);
    reloaded.teamId = from.id;
    await reloaded.save();
    assert.equal((await Member.find(created.id)).teamId, from.id, 'loadRelation loads alike');
  });

  it('writes the key of a target assigned over a loaded one, and keeps a later key change', async () => {
    const from = await Team.create({ name: 'From' });
    const to = await Team.create({ name: 'To' });
    const created = await Member.create({ name: 'assigned', teamId: from.id });

    const member = await Member.where({ id: created.id }).includes('team').getOne();
    assert.ok(member !== null);
    member.team = await Team.find(to.id);
    await member.save();
    assert.equal((await Member.find(created.id)).teamId, to.id, 'the assignment states the link');

    member.teamId = from.id;
    await member.save();
    assert.equal(
      (await Member.find(created.id)).teamId,
      from.id,
      'once saved, the assigned target is settled and a key change is kept',
    );
    assert.equal((await Team.find(from.id)).membersCount, 1);
    assert.equal((await Team.find(to.id)).membersCount, 0);
  });

  it('leaves a loaded child the application moved, and points one added to the loaded array', async () => {
    const owner = await Team.create({ name: 'Owner' });
    const other = await Team.create({ name: 'Other' });
    const kept = await Member.create({ name: 'kept', teamId: owner.id });
    const leaving = await Member.create({ name: 'leaving', teamId: owner.id });

    const team = await Team.where({ id: owner.id }).includes('members').getOne();
    assert.ok(team !== null);
    const moved = team.members.find((child) => child.id === leaving.id);
    assert.ok(moved !== undefined);
    moved.teamId = other.id;
    const added = Member.build({ name: 'added' });
    team.members.push(added);
    await team.save();

    assert.equal((await Member.find(leaving.id)).teamId, other.id, 'the move stands');
    assert.equal((await Member.find(kept.id)).teamId, owner.id);
    assert.equal(added.teamId, owner.id, 'a child added after the load is pointed');
    assert.equal((await Member.find(added.id)).teamId, owner.id);
    assert.equal((await Team.find(owner.id)).membersCount, 2);
    assert.equal((await Team.find(other.id)).membersCount, 1);
  });

  it('points assigned records again when the transaction of the save that pointed them rolled back', async () => {
    const owner = Team.build({ name: 'Retried' });
    const child = Member.build({ name: 'child' });
    owner.members = [child];
    const member = Member.build({ name: 'member' });
    const target = Team.build({ name: 'Target' });
    member.team = target;
    await assert.rejects(
      dataSource.transaction(async () => {
        await owner.save();
        await member.save();
        throw new Error('roll back');
      }),
      /roll back/,
    );
    assert.equal(owner.isPersisted(), false);
    assert.equal(target.isPersisted(), false);
    // Take the rolled-back keys, so the retried records cannot get them again.
    await Team.create({ name: 'Taken' });
    await Team.create({ name: 'Taken too' });
    await owner.save();
    await member.save();
    assert.equal((await Member.find(child.id)).teamId, owner.id);
    assert.equal((await Member.find(member.id)).teamId, target.id);
    assert.equal((await Team.find(owner.id)).membersCount, 1);
    assert.equal((await Team.find(target.id)).membersCount, 1);
  });

  it('refuses an autosave relation holding something other than its records', async () => {
    const team = Team.build({ name: 'Wrong' });
    team.members = [Note.build({ body: 'not a member' }) as unknown as Member];
    await assert.rejects(() => team.save(), {
      code: 'record.invalid_relation',
      context: { model: 'Team', relation: 'members' },
    });
    assert.equal(team.isPersisted(), false);
  });

  it('keeps a counter on a validated, versioned parent without validating or versioning it', async () => {
    const team = await Team.create({ name: 'Validated' });
    // A set write may leave the parent invalid; the counter must still work.
    await Team.where({ id: team.id }).updateAll({ name: '' }, { skipHooks: true });
    await Member.create({ name: 'one', teamId: team.id });
    await Member.create({ name: 'two', teamId: team.id });
    const fresh = await Team.find(team.id);
    assert.equal(fresh.membersCount, 2);
    assert.equal(fresh.lockVersion, 0, 'effect writes leave the lock version alone');
    assert.ok(fresh.touchedAt instanceof Date);
    team.name = 'Renamed';
    await team.save();
    assert.equal(team.lockVersion, 1, 'an edit in progress is not invalidated by the counter');
  });
});
