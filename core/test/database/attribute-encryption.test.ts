/**
 * The `encrypts` column helper: non-deterministic and deterministic encryption
 * at rest, round-tripping through TypeORM, and input validation.
 */

import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { ObjectLiteral } from 'typeorm';

import {
  encryptDeterministic,
  encrypts,
  type EncryptsOptions,
} from '../../src/database/attribute-encryption.js';
import { JsailsDataSource } from '../../src/database/data-source.js';
import { runWithTenant } from '../../src/database/tenant-context.js';
import { tenantScoped } from '../../src/database/tenant-scope.js';
import {
  createEntitySubscriber,
  type EntityHooksDefinition,
} from '../../src/database/entity-subscribers.js';
import { deriveAesKey } from '../../src/encryption/aes-gcm.js';
import { AesEncrypter } from '../../src/encryption/encrypter.js';
import { EncryptionError } from '../../src/encryption/errors.js';
import type { Encrypter } from '../../src/encryption/encrypter-types.js';
import { diffSchemaStates } from '../../src/migrations/autodetector.js';
import { executeSchemaPlan } from '../../src/migrations/schema-executor.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('..', import.meta.url)), 'attribute-encryption-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const encrypterKey = randomBytes(32);
const deterministicKey = randomBytes(32);

const encrypter: Encrypter = new AesEncrypter({ key: encrypterKey });

function makeProfile() {
  @Entity('profiles')
  class Profile extends BaseEntity {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column({ type: 'varchar', length: 500, nullable: true })
    secret_note!: string | null;

    @Column({ type: 'varchar', length: 500, nullable: true })
    api_key!: string | null;

    @Column({ type: 'varchar', length: 200, nullable: false, default: '' })
    public_name!: string;
  }
  return Profile;
}

let dbSeq = 0;

/** The value stored in the column, read around the hooks. */
async function storedValue(
  dataSource: JsailsDataSource,
  id: number,
  column = 'secret_note',
): Promise<string | null> {
  const rows = await dataSource.query<{ value: string | null }[]>(
    `SELECT ${column} AS value FROM profiles WHERE id = ?`,
    [id],
  );
  return rows[0]?.value ?? null;
}

async function createDataSource(
  Profile: ReturnType<typeof makeProfile>,
  ...definitions: EntityHooksDefinition<ObjectLiteral>[]
): Promise<JsailsDataSource> {
  const location = join(tmpRoot, `db-${dbSeq++}.sqlite`);
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location,
    entities: [Profile],
    subscribers: [createEntitySubscriber(...definitions)],
  });
  await dataSource.initialize();
  const schema = await dataSource.getModelSchema();
  const operations = diffSchemaStates({ tables: [] }, schema);
  await executeSchemaPlan(dataSource, operations);
  return dataSource;
}

// ---------------------------------------------------------------------------
// Non-deterministic round-trip
// ---------------------------------------------------------------------------

describe('encrypts — non-deterministic', () => {
  it('round-trip: save encrypts, load decrypts (single field)', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note']),
    );

    const original = 'my secret note value';
    const profile = await Profile.create({ secret_note: original, public_name: 'alice' }).save();

    // The column holds the envelope; the caller's instance keeps the plaintext.
    const stored = await storedValue(dataSource, profile.id);
    assert.notEqual(stored, original);
    assert.match(stored!, /^v1\./);
    assert.equal(profile.secret_note, original);
    assert.equal(profile.public_name, 'alice');

    // Reload — afterLoad decrypts.
    const reloaded = await Profile.findOneByOrFail({ id: profile.id });
    assert.equal(reloaded.secret_note, original);
    assert.equal(reloaded.public_name, 'alice');

    await dataSource.destroy();
  });

  it('round-trip: multiple encrypted fields', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note', 'api_key']),
    );

    const originalNote = 'note';
    const originalKey = 'key-12345';
    const profile = await Profile.create({
      secret_note: originalNote,
      api_key: originalKey,
      public_name: 'bob',
    }).save();

    assert.notEqual(await storedValue(dataSource, profile.id), originalNote);
    assert.notEqual(await storedValue(dataSource, profile.id, 'api_key'), originalKey);

    const reloaded = await Profile.findOneByOrFail({ id: profile.id });
    assert.equal(reloaded.secret_note, originalNote);
    assert.equal(reloaded.api_key, originalKey);

    await dataSource.destroy();
  });

  it('update re-encrypts the changed field', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note']),
    );

    const profile = await Profile.create({ secret_note: 'first', public_name: 'c' }).save();
    const firstCipher = await storedValue(dataSource, profile.id);

    profile.secret_note = 'second';
    await profile.save();

    const secondCipher = await storedValue(dataSource, profile.id);
    assert.notEqual(secondCipher, firstCipher);
    assert.notEqual(secondCipher, 'second');
    assert.equal(profile.secret_note, 'second');

    const reloaded = await Profile.findOneByOrFail({ id: profile.id });
    assert.equal(reloaded.secret_note, 'second');

    await dataSource.destroy();
  });

  it('non-deterministic: same plaintext produces different ciphertext per call', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note']),
    );

    const plaintext = 'same-value';
    const a = await Profile.create({ secret_note: plaintext, public_name: 'a' }).save();
    const b = await Profile.create({ secret_note: plaintext, public_name: 'b' }).save();

    // Ciphertexts must differ (random IV).
    assert.notEqual(await storedValue(dataSource, a.id), await storedValue(dataSource, b.id));

    // Both decrypt to the original.
    const reloadedA = await Profile.findOneByOrFail({ id: a.id });
    const reloadedB = await Profile.findOneByOrFail({ id: b.id });
    assert.equal(reloadedA.secret_note, plaintext);
    assert.equal(reloadedB.secret_note, plaintext);

    await dataSource.destroy();
  });

  it('null and empty fields are skipped (not encrypted)', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note', 'api_key']),
    );

    const profile = await Profile.create({
      secret_note: null,
      api_key: '',
      public_name: 'skip-test',
    }).save();

    assert.equal(profile.secret_note, null);
    assert.equal(profile.api_key, '');

    const reloaded = await Profile.findOneByOrFail({ id: profile.id });
    assert.equal(reloaded.secret_note, null);
    assert.equal(reloaded.api_key, '');

    await dataSource.destroy();
  });

  it('aad: matching AAD works, mismatched AAD fails decrypt', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note'], { aad: 'ctx:profile' }),
    );

    const plaintext = 'with aad';
    const profile = await Profile.create({ secret_note: plaintext, public_name: 'aad' }).save();

    // Reload with the correct AAD — works.
    const reloaded = await Profile.findOneByOrFail({ id: profile.id });
    assert.equal(reloaded.secret_note, plaintext);

    // Directly modify the ciphertext to simulate a different AAD on encrypt
    // (we validate via the decrypt path — tampered ciphertext with wrong AAD).
    // The simplest way: re-encrypt with a *different* AAD and inject it.
    const tampered = encrypter.encrypt(plaintext, { aad: 'ctx:other' });
    await dataSource.query('UPDATE profiles SET secret_note = ? WHERE id = ?', [
      tampered,
      profile.id,
    ]);

    // Reloading should now fail on the mismatched AAD.
    await assert.rejects(Profile.findOneByOrFail({ id: profile.id }), EncryptionError);

    await dataSource.destroy();
  });

  it('tampered ciphertext on load throws value-free EncryptionError', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note']),
    );

    const profile = await Profile.create({ secret_note: 'legit', public_name: 't' }).save();

    // Inject a garbled token that cannot be decoded.
    await dataSource.query('UPDATE profiles SET secret_note = ? WHERE id = ?', [
      'not-a-valid-token',
      profile.id,
    ]);

    await assert.rejects(Profile.findOneByOrFail({ id: profile.id }), (err: unknown) => {
      assert.ok(err instanceof EncryptionError);
      // Message must not echo the field value or tampered ciphertext.
      assert.ok(!(err as Error).message.includes('not-a-valid-token'));
      assert.ok(!(err as Error).message.includes('legit'));
      return true;
    });

    await dataSource.destroy();
  });

  it('tampered ciphertext (valid envelope, wrong tag) fails value-free', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note']),
    );

    const profile = await Profile.create({
      secret_note: 'classified',
      public_name: 'tagged',
    }).save();

    // Replace the auth tag portion of the envelope with garbage.
    const parts = (await storedValue(dataSource, profile.id))!.split('.');
    // v1 . iv . tag . ciphertext
    const tampered = [parts[0], parts[1], 'AAAAAAAAAAAAAAAAAAAAAA', parts[3]].join('.');
    await dataSource.query('UPDATE profiles SET secret_note = ? WHERE id = ?', [
      tampered,
      profile.id,
    ]);

    await assert.rejects(Profile.findOneByOrFail({ id: profile.id }), (err: unknown) => {
      assert.ok(err instanceof EncryptionError);
      assert.ok(!(err as Error).message.includes('classified'));
      return true;
    });

    await dataSource.destroy();
  });
});

describe('encrypts — saving one instance more than once', () => {
  for (const [label, options] of [
    ['non-deterministic', undefined],
    ['deterministic', { deterministic: true, deterministicKey }],
  ] as const) {
    it(`${label}: a second save does not encrypt the stored envelope again`, async () => {
      const Profile = makeProfile();
      const dataSource = await createDataSource(
        Profile,
        encrypts(Profile, encrypter, ['secret_note'], options),
      );

      const profile = await Profile.create({ secret_note: 'plain', public_name: 'a' }).save();
      assert.equal(profile.secret_note, 'plain');
      const firstStored = await storedValue(dataSource, profile.id);

      profile.public_name = 'b';
      await profile.save();
      profile.public_name = 'c';
      await profile.save();

      assert.equal(profile.secret_note, 'plain');
      // The unchanged field is not rewritten at all.
      assert.equal(await storedValue(dataSource, profile.id), firstStored);
      const reloaded = await Profile.findOneByOrFail({ id: profile.id });
      assert.equal(reloaded.secret_note, 'plain');
      assert.equal(reloaded.public_name, 'c');

      // A loaded instance saved again keeps decrypting too.
      reloaded.public_name = 'd';
      await reloaded.save();
      assert.equal((await Profile.findOneByOrFail({ id: profile.id })).secret_note, 'plain');

      await dataSource.destroy();
    });
  }

  it('an envelope left on the instance by a failed write is not re-encrypted', async () => {
    const Profile = makeProfile();
    const definition = encrypts(Profile, encrypter, ['secret_note']);
    const dataSource = await createDataSource(Profile, definition);

    // Simulate a write that encrypted the instance and then failed before its
    // after-hook ran, then save the same instance again.
    const instance = Profile.create({ secret_note: 'retry me', public_name: 'r' });
    await definition.hooks.beforeInsert!({
      entity: instance,
      data: instance,
      manager: dataSource.manager,
    });
    assert.match(instance.secret_note!, /^v1\./);
    await instance.save();

    assert.equal(instance.secret_note, 'retry me');
    assert.equal((await Profile.findOneByOrFail({ id: instance.id })).secret_note, 'retry me');

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// Deterministic
// ---------------------------------------------------------------------------

describe('encrypts — deterministic', () => {
  const detOptions: EncryptsOptions = {
    deterministic: true,
    deterministicKey,
  };

  it('round-trip: save encrypts, load decrypts', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note'], detOptions),
    );

    const original = 'deterministic round-trip';
    const profile = await Profile.create({ secret_note: original, public_name: 'det' }).save();

    const stored = await storedValue(dataSource, profile.id);
    assert.notEqual(stored, original);
    assert.match(stored!, /^v2\./);
    assert.equal(stored, encryptDeterministic(original, { deterministicKey }));

    const reloaded = await Profile.findOneByOrFail({ id: profile.id });
    assert.equal(reloaded.secret_note, original);

    await dataSource.destroy();
  });

  it('same plaintext produces identical ciphertext', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note'], detOptions),
    );

    const plaintext = 'same-value';
    const a = await Profile.create({ secret_note: plaintext, public_name: 'a' }).save();
    const b = await Profile.create({ secret_note: plaintext, public_name: 'b' }).save();

    assert.equal(await storedValue(dataSource, a.id), await storedValue(dataSource, b.id));

    // Both decrypt correctly.
    const reloadedA = await Profile.findOneByOrFail({ id: a.id });
    const reloadedB = await Profile.findOneByOrFail({ id: b.id });
    assert.equal(reloadedA.secret_note, plaintext);
    assert.equal(reloadedB.secret_note, plaintext);

    await dataSource.destroy();
  });

  it('different plaintext produces different ciphertext', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note'], detOptions),
    );

    const a = await Profile.create({ secret_note: 'alpha', public_name: 'a' }).save();
    const b = await Profile.create({ secret_note: 'beta', public_name: 'b' }).save();

    assert.notEqual(await storedValue(dataSource, a.id), await storedValue(dataSource, b.id));

    // Both decrypt correctly.
    const reloadedA = await Profile.findOneByOrFail({ id: a.id });
    const reloadedB = await Profile.findOneByOrFail({ id: b.id });
    assert.equal(reloadedA.secret_note, 'alpha');
    assert.equal(reloadedB.secret_note, 'beta');

    await dataSource.destroy();
  });

  it('the v2 IV is keyed: it is not an unkeyed hash of the plaintext', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note'], detOptions),
    );

    const plaintext = 'iv check';
    const profile = await Profile.create({ secret_note: plaintext }).save();

    const parts = (await storedValue(dataSource, profile.id))!.split('.');
    assert.equal(parts.length, 4);
    assert.equal(parts[0], 'v2');

    // A database dump must not let anyone test a guess without the key.
    const unkeyedIv = createHash('sha256')
      .update(plaintext, 'utf8')
      .digest()
      .subarray(0, 12)
      .toString('base64url');
    assert.notEqual(parts[1], unkeyedIv);

    // A different key gives a different IV for the same plaintext.
    const otherIv = encryptDeterministic(plaintext, { deterministicKey: randomBytes(32) }).split(
      '.',
    )[1];
    assert.notEqual(parts[1], otherIv);

    await dataSource.destroy();
  });

  it('the v2 IV binds the AAD, so one key never reuses a nonce across AAD values', () => {
    const a = encryptDeterministic('same', { deterministicKey, aad: 'users.email' });
    const b = encryptDeterministic('same', { deterministicKey, aad: 'users.phone' });
    assert.notEqual(a.split('.')[1], b.split('.')[1]);
  });

  it('legacy v1 envelopes still decrypt and are rewritten as v2 on the next write', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note'], detOptions),
    );

    const profile = await Profile.create({ secret_note: 'placeholder', public_name: 'l' }).save();

    // Seal exactly as the v1 construction did: SHA-256 IV, HKDF-v1 key.
    const legacyPlain = 'legacy value';
    const legacyKey = deriveAesKey(deterministicKey, {
      salt: Buffer.from('jsails/attribute-encryption/det/v1', 'utf8'),
      info: Buffer.from('aes-256-gcm-det', 'utf8'),
      label: 'test',
    });
    const iv = createHash('sha256').update(legacyPlain, 'utf8').digest().subarray(0, 12);
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
    const ct = Buffer.concat([cipher.update(legacyPlain, 'utf8'), cipher.final()]);
    const legacy = [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ct.toString('base64url'),
    ].join('.');
    await dataSource.query('UPDATE profiles SET secret_note = ? WHERE id = ?', [
      legacy,
      profile.id,
    ]);

    const loaded = await Profile.findOneByOrFail({ id: profile.id });
    assert.equal(loaded.secret_note, legacyPlain);

    loaded.secret_note = 'rewritten';
    await loaded.save();
    assert.match((await storedValue(dataSource, profile.id))!, /^v2\./);
    assert.equal((await Profile.findOneByOrFail({ id: profile.id })).secret_note, 'rewritten');

    await dataSource.destroy();
  });

  it('tampered ciphertext fails value-free', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note'], detOptions),
    );

    const profile = await Profile.create({ secret_note: 'top-secret', public_name: 't' }).save();

    await dataSource.query('UPDATE profiles SET secret_note = ? WHERE id = ?', [
      'v1.aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb.cccccc',
      profile.id,
    ]);

    await assert.rejects(Profile.findOneByOrFail({ id: profile.id }), (err: unknown) => {
      assert.ok(err instanceof EncryptionError);
      assert.ok(!(err as Error).message.includes('top-secret'));
      return true;
    });

    await dataSource.destroy();
  });

  it('different deterministicKey produces incompatible ciphertext', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note'], detOptions),
    );

    const profile = await Profile.create({ secret_note: 'mine', public_name: 'dk' }).save();

    // Encrypt the same plaintext with a different key and inject it.
    const otherKey = randomBytes(32);
    const otherDetOptions: EncryptsOptions = {
      deterministic: true,
      deterministicKey: otherKey,
    };
    // We need a separate encrypts call with the other key to produce the
    // compatible envelope.  Build a minimal data source for this.
    const Profile2 = makeProfile();
    const dataSource2 = await createDataSource(
      Profile2,
      encrypts(Profile2, encrypter, ['secret_note'], otherDetOptions),
    );
    const p2 = await Profile2.create({ secret_note: 'mine', public_name: 'other' }).save();
    const foreignCipher = await storedValue(dataSource2, p2.id);

    // Inject the foreign-key ciphertext into the first data source.
    await dataSource.query('UPDATE profiles SET secret_note = ? WHERE id = ?', [
      foreignCipher,
      profile.id,
    ]);

    await assert.rejects(Profile.findOneByOrFail({ id: profile.id }), EncryptionError);

    await dataSource2.destroy();
    await dataSource.destroy();
  });

  it('aad: matching AAD works, mismatched AAD fails', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note'], {
        deterministic: true,
        deterministicKey,
        aad: 'ctx:profile',
      }),
    );

    const plaintext = 'aad-det';
    const profile = await Profile.create({ secret_note: plaintext, public_name: 'aad' }).save();

    const reloaded = await Profile.findOneByOrFail({ id: profile.id });
    assert.equal(reloaded.secret_note, plaintext);

    // Inject a ciphertext encrypted with the same key but different AAD.
    const otherProfile = await Profile.create({
      secret_note: plaintext,
      public_name: 'other',
    }).save();
    // Tamper by re-encrypting with different AAD via the other encrypter.
    const tampered = encrypter.encrypt(plaintext, { aad: 'ctx:other' });
    await dataSource.query('UPDATE profiles SET secret_note = ? WHERE id = ?', [
      tampered,
      otherProfile.id,
    ]);

    await assert.rejects(Profile.findOneByOrFail({ id: otherProfile.id }), EncryptionError);

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// Query-builder updates (Model.update / repository.update)
// ---------------------------------------------------------------------------

describe('encrypts — query-builder update', () => {
  it('Model.update() stores ciphertext and find() reads the plaintext back', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note', 'api_key']),
    );
    const profile = await Profile.create({ secret_note: 'before', public_name: 'u' }).save();

    const values = { secret_note: 'after update', api_key: 'sk-123', public_name: 'renamed' };
    await Profile.update(profile.id, values);

    const storedNote = await storedValue(dataSource, profile.id);
    const storedKey = await storedValue(dataSource, profile.id, 'api_key');
    assert.match(storedNote!, /^v1\./);
    assert.match(storedKey!, /^v1\./);
    assert.equal(encrypter.decrypt(storedNote!), 'after update');
    assert.equal(await storedValue(dataSource, profile.id, 'public_name'), 'renamed');
    // The caller's SET map holds its plaintext again once the write is done.
    assert.deepEqual(values, {
      secret_note: 'after update',
      api_key: 'sk-123',
      public_name: 'renamed',
    });

    const reloaded = await Profile.findOneByOrFail({ id: profile.id });
    assert.equal(reloaded.secret_note, 'after update');
    assert.equal(reloaded.api_key, 'sk-123');

    await dataSource.destroy();
  });

  it('repository.update() with a deterministic field stays equality-queryable', async () => {
    const Profile = makeProfile();
    const options: EncryptsOptions = { deterministic: true, deterministicKey };
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note'], options),
    );
    const profile = await Profile.create({ secret_note: 'old', public_name: 'd' }).save();

    await dataSource.getRepository(Profile).update({ id: profile.id }, { secret_note: 'new' });

    const envelope = encryptDeterministic('new', { deterministicKey });
    assert.equal(await storedValue(dataSource, profile.id), envelope);
    const found = await Profile.findOneByOrFail({ secret_note: envelope });
    assert.equal(found.id, profile.id);
    assert.equal(found.secret_note, 'new');

    await dataSource.destroy();
  });

  for (const [label, options] of [
    ['non-deterministic', undefined],
    ['deterministic', { deterministic: true, deterministicKey }],
  ] as const) {
    it(`${label}: a submitted envelope is sealed again, never decrypted for the caller`, async () => {
      const Profile = makeProfile();
      const dataSource = await createDataSource(
        Profile,
        encrypts(Profile, encrypter, ['secret_note'], options),
      );
      const victim = await Profile.create({ secret_note: 'victim secret' }).save();
      // A ciphertext leaked from a dump, submitted as plain input.
      const leaked = (await storedValue(dataSource, victim.id))!;

      const viaSave = await Profile.create({ secret_note: leaked, public_name: 's' }).save();
      const viaUpdate = await Profile.create({ secret_note: 'x', public_name: 'u' }).save();
      await Profile.update(viaUpdate.id, { secret_note: leaked });

      for (const id of [viaSave.id, viaUpdate.id]) {
        const stored = (await storedValue(dataSource, id))!;
        assert.notEqual(stored, leaked);
        const reloaded = await Profile.findOneByOrFail({ id });
        // The attacker reads back exactly what they submitted, not the plaintext.
        assert.equal(reloaded.secret_note, leaked);
        assert.notEqual(reloaded.secret_note, 'victim secret');
      }

      await dataSource.destroy();
    });
  }

  it('a retried update with the same SET object stores a single envelope', async () => {
    const Profile = makeProfile();
    const definition = encrypts(Profile, encrypter, ['secret_note']);
    const dataSource = await createDataSource(Profile, definition);
    const profile = await Profile.create({ secret_note: 'first', public_name: 'r' }).save();

    // Simulate an update that sealed its SET map and then failed before its
    // after-hook ran, then retry with the same object.
    const values: Record<string, unknown> = { secret_note: 'retried' };
    await definition.hooks.beforeBulkUpdate!({ values, manager: dataSource.manager });
    assert.match(String(values.secret_note), /^v1\./);
    await Profile.update(profile.id, values);

    assert.equal(values.secret_note, 'retried');
    assert.equal(encrypter.decrypt((await storedValue(dataSource, profile.id))!), 'retried');
    assert.equal((await Profile.findOneByOrFail({ id: profile.id })).secret_note, 'retried');

    await dataSource.destroy();
  });

  it('a backfill writes the loaded plaintext and the bridge seals it as v2', async () => {
    const Profile = makeProfile();
    const options: EncryptsOptions = { deterministic: true, deterministicKey };
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note'], options),
    );
    const profile = await Profile.create({ secret_note: 'backfilled', public_name: 'b' }).save();

    const loaded = await Profile.findOneByOrFail({ id: profile.id });
    await Profile.update(loaded.id, { secret_note: loaded.secret_note });

    const envelope = encryptDeterministic('backfilled', { deterministicKey });
    assert.equal(await storedValue(dataSource, profile.id), envelope);
    assert.equal((await Profile.findOneByOrFail({ id: profile.id })).secret_note, 'backfilled');

    await dataSource.destroy();
  });

  it('a raw SQL expression in the SET map is left alone', async () => {
    const Profile = makeProfile();
    const dataSource = await createDataSource(
      Profile,
      encrypts(Profile, encrypter, ['secret_note']),
    );
    const profile = await Profile.create({ secret_note: 'kept', public_name: 'r' }).save();

    await Profile.update(profile.id, { secret_note: () => 'NULL' });

    assert.equal(await storedValue(dataSource, profile.id), null);

    await dataSource.destroy();
  });

  it('Model.update() on a tenant-scoped model encrypts and stays inside the tenant', async () => {
    @Entity('tenant_secrets')
    class TenantSecret extends BaseEntity {
      @PrimaryGeneratedColumn()
      id!: number;

      @Column({ type: 'integer' })
      tenantId!: number;

      @Column({ type: 'varchar', length: 500, nullable: true })
      secret_note!: string | null;
    }
    tenantScoped('tenantId')(TenantSecret);
    const location = join(tmpRoot, `db-${dbSeq++}.sqlite`);
    const dataSource = new JsailsDataSource({
      type: 'sqljs',
      location,
      entities: [TenantSecret],
      subscribers: [createEntitySubscriber(encrypts(TenantSecret, encrypter, ['secret_note']))],
    });
    await dataSource.initialize();
    await executeSchemaPlan(
      dataSource,
      diffSchemaStates({ tables: [] }, await dataSource.getModelSchema()),
    );

    const mine = await runWithTenant(1, () => TenantSecret.create({ secret_note: 'mine' }).save());
    const theirs = await runWithTenant(2, () =>
      TenantSecret.create({ secret_note: 'theirs' }).save(),
    );

    // The update names both rows; the guard keeps it to tenant 1's.
    await runWithTenant(1, () =>
      TenantSecret.update([mine.id, theirs.id], { secret_note: 'rewritten' }),
    );

    const rows = await dataSource.query<{ id: number; secret_note: string }[]>(
      'SELECT id, secret_note FROM tenant_secrets ORDER BY id',
    );
    const stored = new Map(rows.map((row) => [row.id, row.secret_note]));
    assert.match(stored.get(mine.id)!, /^v1\./);
    assert.equal(encrypter.decrypt(stored.get(mine.id)!), 'rewritten');
    assert.equal(encrypter.decrypt(stored.get(theirs.id)!), 'theirs');

    await dataSource.destroy();
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('encrypts — input validation', () => {
  it('throws when fields is empty', () => {
    const Profile = makeProfile();
    assert.throws(
      () => encrypts(Profile, encrypter, []),
      (err: unknown) => {
        assert.ok(err instanceof EncryptionError);
        assert.equal(err.code, 'invalid_options');
        return true;
      },
    );
  });

  it('throws when fields is not an array', () => {
    const Profile = makeProfile();
    assert.throws(
      () => encrypts(Profile, encrypter, null as unknown as readonly string[]),
      (err: unknown) => {
        assert.ok(err instanceof EncryptionError);
        assert.equal(err.code, 'invalid_options');
        return true;
      },
    );
  });

  it('throws when deterministic is true without deterministicKey', () => {
    const Profile = makeProfile();
    assert.throws(
      () => encrypts(Profile, encrypter, ['field'], { deterministic: true }),
      (err: unknown) => {
        assert.ok(err instanceof EncryptionError);
        assert.equal(err.code, 'invalid_options');
        return true;
      },
    );
  });

  it('returns a frozen EntityHooksDefinition', () => {
    const Profile = makeProfile();
    const def = encrypts(Profile, encrypter, ['secret_note']);
    assert.ok(Object.isFrozen(def));
    assert.ok(Object.isFrozen(def.hooks));
    assert.equal(def.entity, Profile);
  });

  it('hooks definition carries the encrypt, restore, and decrypt hooks', () => {
    const Profile = makeProfile();
    const def = encrypts(Profile, encrypter, ['secret_note']);
    // No other hooks should be registered.
    const keys = Object.keys(def.hooks);
    assert.deepEqual(keys.sort(), [
      'afterBulkUpdate',
      'afterInsert',
      'afterLoad',
      'afterUpdate',
      'beforeBulkUpdate',
      'beforeInsert',
      'beforeUpdate',
    ]);
  });
});
