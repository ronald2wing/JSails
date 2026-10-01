import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { DataContractError, defineData, defineDataList } from '../../src/data/define-data.js';

const User = defineData({
  name: 'User',
  description: 'A user account.',
  properties: {
    email: z.email().describe('The account email address.'),
    name: z.string().min(1).max(120).describe('The display name.'),
  },
});

describe('defineData', () => {
  it('holds only metadata and the schema', () => {
    assert.deepEqual(Object.keys(User).sort(), [
      'description',
      'jsonSchema',
      'name',
      'outputJsonSchema',
      'properties',
      'schema',
    ]);
    assert.equal(User.name, 'User');
    assert.equal(User.description, 'A user account.');
    assert.equal(typeof User.schema.parse, 'function');
    assert.equal(typeof User.properties.email.parse, 'function');
    assert.equal(Object.isFrozen(User), true);
  });

  it('parses through the schema into a plain data object', () => {
    const user = User.schema.parse({ email: 'ada@example.com', name: 'Ada' });
    assert.deepEqual(user, { email: 'ada@example.com', name: 'Ada' });
    assert.equal('parse' in user, false);
    assert.equal('name' in user, true);
  });

  it('exposes input and output JSON Schemas as properties', () => {
    assert.equal(User.jsonSchema.title, 'User');
    assert.equal(User.jsonSchema.description, 'A user account.');
    assert.equal(User.outputJsonSchema.title, 'User');
    assert.equal(
      (User.jsonSchema.properties as Record<string, { description?: string }>).email?.description,
      'The account email address.',
    );
  });

  it('builds a list contract with an array JSON Schema', () => {
    const Users = defineDataList(User, { name: 'Users', description: 'A user list.' });
    const parsed = Users.schema.parse([{ email: 'ada@example.com', name: 'Ada' }]);
    assert.deepEqual(parsed, [{ email: 'ada@example.com', name: 'Ada' }]);
    assert.equal(Users.item, User);
    assert.equal(Users.jsonSchema.type, 'array');
    assert.equal(Users.outputJsonSchema.type, 'array');
    assert.equal(Users.jsonSchema.title, 'Users');
  });

  it('rejects malformed contracts with a value-free error', () => {
    assert.throws(
      () => defineData(null as never),
      (error) => error instanceof DataContractError && error.code === 'invalid_contract',
    );
    assert.throws(
      () => defineData({ name: '', properties: {} }),
      (error) => error instanceof DataContractError && error.code === 'invalid_contract',
    );
    assert.throws(
      () => defineData({ name: 'User', description: '', properties: {} }),
      (error) => error instanceof DataContractError && error.code === 'invalid_contract',
    );
    assert.throws(
      () => defineData({ name: 'User', properties: null } as never),
      (error) => error instanceof DataContractError && error.code === 'invalid_contract',
    );
  });
});
