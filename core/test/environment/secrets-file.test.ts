/**
 * Tests for the secrets file a deploy mounts (`JSAILS_SECRETS_FILE`): format
 * v1, values carried byte for byte, and value-free refusals.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { EnvironmentErrors } from '../../src/environment/errors.js';
import { parseSecretsFile, readSecretsFile } from '../../src/environment/secrets-file.js';

const root = mkdtempSync(join(tmpdir(), 'jsails-secrets-file-'));
after(() => rmSync(root, { recursive: true, force: true }));

function failsWith(code: string, problem?: string) {
  return (error: unknown): boolean =>
    EnvironmentErrors.is(error) &&
    error.code === `environment.${code}` &&
    (problem === undefined || error.message.endsWith(problem)) &&
    !error.message.includes('s3cret');
}

describe('secrets file', () => {
  it('carries any value but NUL unchanged', () => {
    const values = {
      PEM: '-----BEGIN KEY-----\nabc\n-----END KEY-----\n',
      QUOTES: `a'b"c\`d \\ $HOME`,
      UNICODE: 'naïve ✓',
      EMPTY: '',
    };
    assert.deepEqual({ ...parseSecretsFile(JSON.stringify({ v: 1, values })).values }, values);
  });

  it('reads the file a path names, and refuses a missing one without naming the path', () => {
    const path = join(root, 'secrets.json');
    writeFileSync(path, JSON.stringify({ v: 1, values: { A: 'b' } }));
    assert.deepEqual({ ...readSecretsFile(path).values }, { A: 'b' });
    assert.throws(
      () => readSecretsFile(join(root, 'missing.json')),
      (error: unknown) =>
        failsWith('unreadable_secrets_file')(error) && !(error as Error).message.includes(root),
    );
  });

  it('refuses every malformed document, value-free', () => {
    const cases: Array<readonly [string, string]> = [
      ['{', 'not JSON'],
      ['[]', 'not an object'],
      ['{"v":2,"values":{}}', 'unsupported version'],
      ['{"values":{}}', 'unsupported version'],
      ['{"v":1}', 'no values object'],
      ['{"v":1,"values":["s3cret"]}', 'no values object'],
      ['{"v":1,"values":{"bad name":"s3cret"}}', 'invalid variable name'],
      ['{"v":1,"values":{"__proto__":"s3cret"}}', 'invalid variable name'],
      ['{"v":1,"values":{"A":1}}', 'a value that is not a string'],
      ['{"v":1,"values":{"A":"s3cret\\u0000"}}', 'a value containing NUL'],
    ];
    for (const [raw, problem] of cases) {
      assert.throws(() => parseSecretsFile(raw), failsWith('invalid_secrets_file', problem), raw);
    }
  });

  it('lifts the credentials key ring out of the values', () => {
    const parsed = parseSecretsFile(
      JSON.stringify({ v: 1, values: { JSAILS_CREDENTIALS_KEY: 'ring', A: 'b' } }),
    );
    assert.equal(parsed.credentialsKey, 'ring');
    assert.deepEqual({ ...parsed.values }, { A: 'b' });
    assert.equal(parseSecretsFile('{"v":1,"values":{}}').credentialsKey, undefined);
  });

  it('refuses every other reserved key', () => {
    const reserved = ['JSAILS_ENV', 'NODE_ENV', 'JSAILS_SECRETS_FILE', 'JSAILS_ENV_RESOLVED'];
    for (const key of [...reserved, 'JSAILS_DEBUG']) {
      assert.throws(
        () => parseSecretsFile(JSON.stringify({ v: 1, values: { [key]: 's3cret' } })),
        failsWith('secrets_file_reserved_key'),
      );
    }
  });
});
