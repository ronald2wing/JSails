/**
 * Audit finding "Model.update()/repository.update() writes plaintext into
 * @jsails.encrypts columns and makes the row unreadable", on every driver: a
 * set-form update of an encrypted column stores ciphertext, and the record
 * reads back as the plaintext. Fixed for the old stack in M0; DAT-10 moves
 * encryption into a column codec.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { encrypts } from '../../../src/database/attribute-encryption.js';
import { createEntitySubscriber } from '../../../src/database/entity-subscribers.js';
import { AesEncrypter } from '../../../src/encryption/encrypter.js';
import { openMatrixDataSource } from './matrix-database.js';

const encrypter = new AesEncrypter({ key: randomBytes(32) });

function makeProfile() {
  @Entity('regression_profiles')
  class Profile extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 500, nullable: true })
    secret_note!: string | null;
  }
  return Profile;
}

describe('encrypted column written by a set-form update', () => {
  for (const write of ['Model.update', 'repository.update'] as const) {
    it(`${write} stores ciphertext and reads back the plaintext`, async (t) => {
      const Profile = makeProfile();
      const dataSource = await openMatrixDataSource(t, {
        entities: [Profile],
        subscribers: [createEntitySubscriber(encrypts(Profile, encrypter, ['secret_note']))],
      });
      const profile = await Profile.create({ secret_note: 'before' }).save();

      if (write === 'Model.update') {
        await Profile.update(profile.id, { secret_note: 'after' });
      } else {
        await dataSource
          .getRepository(Profile)
          .update({ id: profile.id }, { secret_note: 'after' });
      }

      const raw = await dataSource
        .createQueryBuilder()
        .select('p.secret_note', 'value')
        .from('regression_profiles', 'p')
        .where('p.id = :id', { id: profile.id })
        .getRawOne<{ value: string }>();
      assert.notEqual(raw?.value, 'after', 'the column holds plaintext');
      assert.equal(encrypter.decrypt(raw?.value ?? ''), 'after');
      const reloaded = await Profile.findOneByOrFail({ id: profile.id });
      assert.equal(reloaded.secret_note, 'after');
    });
  }
});
