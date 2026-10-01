/**
 * Tests for the parts of `scripts/release.mjs` that decide what is published:
 * reading the registry's answer, and packing and hashing a tarball.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { packTarball, packedFilename, registryHasVersion, sha256File } from '../release.mjs';
import { run } from '../subprocess.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'jsails-release-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const ok = (stdout, stderr = '') => ({ code: 0, signal: null, stdout, stderr });
const failed = (stdout, stderr) => ({ code: 1, signal: null, stdout, stderr });

describe('registryHasVersion', () => {
  it('reads a stderr warning with empty stdout as not published', () => {
    assert.equal(
      registryHasVersion(ok('', 'npm warn Unknown project config "foo"\n'), '1.2.0'),
      false,
    );
  });

  it('reads the exact version, alone or in a list, as published', () => {
    assert.equal(registryHasVersion(ok('"1.2.0"\n', 'npm warn x\n'), '1.2.0'), true);
    assert.equal(registryHasVersion(ok('["1.1.0","1.2.0"]'), '1.2.0'), true);
    assert.equal(registryHasVersion(ok('["1.1.0"]'), '1.2.0'), false);
    assert.equal(registryHasVersion(ok('"1.2.1"'), '1.2.0'), false);
  });

  it('reads E404 as not published and any other failure or garbage as unknown', () => {
    assert.equal(registryHasVersion(failed('', 'npm error code E404\n'), '1.0.0'), false);
    assert.equal(registryHasVersion(failed('{"error":{"code":"E404"}}', ''), '1.0.0'), false);
    assert.equal(registryHasVersion(failed('', 'npm error code ETIMEDOUT\n'), '1.0.0'), null);
    assert.equal(registryHasVersion(ok('not json'), '1.0.0'), null);
    assert.equal(registryHasVersion(ok('{"error":{"code":"E500"}}'), '1.0.0'), null);
  });
});

describe('run capture', () => {
  it('keeps stdout and stderr apart', async () => {
    const outcome = await run(
      process.execPath,
      ['-e', 'process.stderr.write("warn\\n"); process.stdout.write("out")'],
      { capture: true, forwardSignals: false },
    );
    assert.equal(outcome.stdout, 'out');
    assert.equal(outcome.stderr, 'warn\n');
    assert.match(outcome.output, /warn/);
  });
});

describe('packedFilename', () => {
  it('returns the single tarball npm reported', () => {
    assert.equal(
      packedFilename('[{"name":"@jsails/auth","filename":"jsails-auth-1.0.0.tgz"}]'),
      'jsails-auth-1.0.0.tgz',
    );
  });

  it('refuses output that does not name exactly one plain file', () => {
    for (const stdout of [
      'npm notice\n',
      '[]',
      '[{"filename":"a.tgz"},{"filename":"b.tgz"}]',
      '[{"name":"x"}]',
      '[{"filename":"../escape.tgz"}]',
      '{"filename":"a.tgz"}',
    ]) {
      assert.throws(() => packedFilename(stdout), Error, stdout);
    }
  });
});

describe('packTarball', () => {
  it('packs a directory and hashes the exact tarball it wrote', async () => {
    const pkg = join(scratch, 'pkg');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: '@scope/demo',
        version: '1.2.3',
        files: ['dist'],
        // Packing must never run lifecycle scripts; this one would fail it.
        scripts: { prepack: 'node -e "process.exit(1)"' },
      }),
    );
    writeFileSync(join(pkg, 'dist', 'index.js'), 'export const value = 1;\n');
    const destination = join(scratch, 'out');
    mkdirSync(destination);

    const tarball = await packTarball(pkg, destination);

    assert.equal(tarball.file, join(destination, 'scope-demo-1.2.3.tgz'));
    const expected = createHash('sha256').update(readFileSync(tarball.file)).digest('hex');
    assert.equal(tarball.sha256, expected);
    assert.match(tarball.sha256, /^[0-9a-f]{64}$/);
  });

  it('rejects when npm cannot pack the spec', async () => {
    await assert.rejects(packTarball(join(scratch, 'missing'), scratch), /npm pack .* failed/);
  });
});

describe('sha256File', () => {
  it('hashes the file bytes as lowercase hex', () => {
    const file = join(scratch, 'bytes.bin');
    writeFileSync(file, 'abc');
    assert.equal(
      sha256File(file),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
