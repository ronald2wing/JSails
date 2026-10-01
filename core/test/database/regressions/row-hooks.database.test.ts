/**
 * Row-hook regressions on every driver:
 *
 * - "Hook layer assumes query-builder writes fire no hooks; they do, with a
 *   partial or undefined entity": with a counter cache on Comment -> Post and
 *   entity validation on Post, every comment save used to be rejected, because
 *   the counter's bulk increment ran Post's validation on `{ comments_count }`.
 * - "autosave and nestedAttributes do nothing on update: the hook reads the
 *   database snapshot, not the instance being saved".
 *
 * Both were patched in the old stack in M0; DAT-08's single write pipeline
 * replaces the hook layer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BaseEntity, Column, Entity, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { z } from 'zod';

import { autosave, counterCache, nestedAttributes } from '../../../src/database/counter-cache.js';
import {
  defineEntityValidation,
  entityValidationHooks,
} from '../../../src/database/entity-validation.js';
import { createEntitySubscriber } from '../../../src/database/entity-subscribers.js';
import { openMatrixDataSource } from './matrix-database.js';

function makeModels() {
  @Entity('regression_posts')
  class Post extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 200 })
    title!: string;

    @Column({ type: 'integer', default: 0 })
    comments_count!: number;

    @OneToMany('Comment', 'post')
    comments!: Comment[];
  }

  @Entity('regression_comments')
  class Comment extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 200 })
    body!: string;

    @ManyToOne('Post', 'comments', { nullable: false })
    post!: Post;
  }

  return { Post, Comment };
}

describe('row hooks and framework bulk writes', () => {
  it('a counter cache works when the parent has entity validation', async (t) => {
    const { Post, Comment } = makeModels();
    const validation = entityValidationHooks(
      defineEntityValidation(
        Post,
        z.object({ title: z.string().min(1), comments_count: z.number().int().min(0).optional() }),
      ),
    );
    const counter = counterCache(Comment, {
      relation: 'post',
      column: 'comments_count',
      incrementOn: 'afterInsert',
    });
    await openMatrixDataSource(t, {
      entities: [Post, Comment],
      subscribers: [createEntitySubscriber(validation, counter)],
    });

    const post = await Post.create({ title: 'Validated' }).save();
    await Comment.create({ body: 'one', post }).save();
    await Comment.create({ body: 'two', post }).save();

    assert.equal((await Post.findOneByOrFail({ id: post.id })).comments_count, 2);
  });

  it('autosave persists an edited child when the loaded parent is saved again', async (t) => {
    const { Post, Comment } = makeModels();
    await openMatrixDataSource(t, {
      entities: [Post, Comment],
      subscribers: [createEntitySubscriber(autosave(Post, { relations: ['comments'] }))],
    });
    const post = Post.create({ title: 'Draft' });
    post.comments = [Comment.create({ body: 'original', post })];
    await post.save();

    const loaded = await Post.findOneOrFail({
      where: { id: post.id },
      relations: { comments: true },
    });
    const [comment] = loaded.comments;
    assert.ok(comment !== undefined);
    comment.body = 'edited';
    loaded.title = 'Published';
    await loaded.save();

    assert.equal((await Comment.findOneByOrFail({ id: comment.id })).body, 'edited');
  });

  it('nestedAttributes inserts a child attached on update', async (t) => {
    const { Post, Comment } = makeModels();
    await openMatrixDataSource(t, {
      entities: [Post, Comment],
      subscribers: [
        createEntitySubscriber(nestedAttributes(Post, { relation: 'comments', fields: ['body'] })),
      ],
    });
    const post = await Post.create({ title: 'Parent' }).save();
    const added = Comment.create({ body: 'added on update', post });
    post.comments = [added];
    post.title = 'Parent, edited';
    await post.save();

    assert.equal(typeof added.id, 'number');
    assert.equal((await Comment.findOneByOrFail({ id: added.id })).body, 'added on update');
  });
});
