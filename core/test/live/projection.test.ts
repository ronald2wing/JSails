/**
 * Tests for the live layer's metadata-driven row projection.
 *
 * `projectRow` reduces an entity instance to a frozen {@link LiveRow} of its
 * scalar columns: relation properties and their foreign-key join columns are
 * excluded (both carry `relationMetadata` on their TypeORM column), JSON columns
 * are projected atomically, and the result is frozen (LIVE-PLAN.md §4.4).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Column, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';

import { ApplicationRecord } from '../../src/database/application-record.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import { projectRow } from '../../src/live/projection.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'jsails-projection-'));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;

// A pair of entities exercising every projection rule: scalar columns, a JSON
// column, and a many-to-one relation with an implicit join column.
function makeAuthor() {
  @Entity('proj_authors')
  class Author extends ApplicationRecord {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 100, nullable: false })
    name!: string;
  }
  return Author;
}

function makePost() {
  @Entity('proj_posts')
  class Post extends ApplicationRecord {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 200, nullable: false })
    title!: string;

    @ManyToOne(() => projAuthor, { nullable: true })
    @JoinColumn({ name: 'author_id' })
    author!: unknown;

    @Column({ type: 'simple-json', nullable: true })
    meta!: unknown;
  }
  return Post;
}

let projAuthor: ReturnType<typeof makeAuthor>;

async function createDataSource(
  entities: (ReturnType<typeof makeAuthor> | ReturnType<typeof makePost>)[],
): Promise<JsailsDataSource> {
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location: join(tmpRoot, `proj-${seq++}.sqlite`),
    entities,
  });
  await dataSource.initialize();
  return dataSource;
}

describe('projectRow', () => {
  it('projects scalar columns, excludes the relation and its join column, and freezes', async () => {
    const Author = makeAuthor();
    projAuthor = Author;
    const Post = makePost();
    const dataSource = await createDataSource([Author, Post]);

    const post = new Post();
    post.id = 7;
    post.title = 'Hello';

    const projected = projectRow(Post, post);

    // Scalar columns are projected; an unset nullable column is present as
    // undefined (the projection copies every scalar column, matching dirty.ts).
    assert.equal(projected.id, 7);
    assert.equal(projected.title, 'Hello');
    assert.equal('meta' in projected, true);
    // The relation property (`author`) and its foreign-key join column
    // (`authorId`) are relationMetadata-bearing columns — neither is a scalar.
    assert.equal('author' in projected, false);
    assert.equal('authorId' in projected, false);
    assert.ok(Object.isFrozen(projected));

    await dataSource.destroy();
  });

  it('projects a JSON column atomically (the value is copied as-is, not flattened)', async () => {
    const Author = makeAuthor();
    projAuthor = Author;
    const Post = makePost();
    const dataSource = await createDataSource([Author, Post]);

    const meta = { tags: ['a', 'b'], nested: { x: 1 } };
    const post = new Post();
    post.id = 1;
    post.title = 'With meta';
    post.meta = meta;

    const projected = projectRow(Post, post);
    assert.equal(projected.meta, meta); // same reference — atomic, not flattened
    assert.deepEqual(projected.meta, meta);

    await dataSource.destroy();
  });

  it('copies values off the instance without mutating it', async () => {
    const Author = makeAuthor();
    projAuthor = Author;
    const Post = makePost();
    const dataSource = await createDataSource([Author, Post]);

    const post = new Post();
    post.id = 2;
    post.title = 'Original';

    const projected = projectRow(Post, post);
    post.title = 'Mutated';

    assert.equal(projected.title, 'Original');

    await dataSource.destroy();
  });
});
