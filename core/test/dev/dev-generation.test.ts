import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  createGenerationChannel,
  generationFilePath,
  readGeneration,
  writeGeneration,
} from '../../src/dev/dev-generation.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jsails-dev-generation-'));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('generationFilePath', () => {
  it('lives under .jsails so it is gitignored', () => {
    assert.equal(generationFilePath('/project'), join('/project', '.jsails', 'dev-generation'));
  });
});

describe('writeGeneration', () => {
  it('creates the directory and writes the value', () => {
    const path = generationFilePath(tempRoot());
    writeGeneration(path, 7);
    assert.equal(readFileSync(path, 'utf8'), '7\n');
  });

  it('overwrites in place without leaving a temp file', () => {
    const path = generationFilePath(tempRoot());
    writeGeneration(path, 1);
    writeGeneration(path, 2);
    assert.equal(readGeneration(path), 2);
    assert.throws(() => readFileSync(`${path}.tmp`, 'utf8'), /ENOENT/);
  });
});

describe('readGeneration', () => {
  it('returns 0 for a missing file', () => {
    assert.equal(readGeneration(join(tempRoot(), '.jsails', 'dev-generation')), 0);
  });

  it('keeps the previous value for unparsable content', () => {
    const path = generationFilePath(tempRoot());
    writeGeneration(path, 4);
    writeFileSync(path, 'not-a-number\n', 'utf8');
    assert.equal(readGeneration(path, 4), 4);
  });

  it('rejects negative and non-integer values', () => {
    const path = generationFilePath(tempRoot());
    writeGeneration(path, 0);
    writeFileSync(path, '-3\n', 'utf8');
    assert.equal(readGeneration(path, 9), 9);
    writeFileSync(path, '1.5\n', 'utf8');
    assert.equal(readGeneration(path, 9), 9);
  });
});

describe('createGenerationChannel', () => {
  it('is a constant-0 channel without a path', () => {
    const channel = createGenerationChannel({ path: undefined });
    let calls = 0;
    const unsubscribe = channel.subscribe(() => {
      calls += 1;
    });
    assert.equal(channel.current(), 0);
    unsubscribe();
    channel.close();
    assert.equal(calls, 0);
  });

  it('notifies subscribers when the file changes', async () => {
    const path = generationFilePath(tempRoot());
    writeGeneration(path, 1);
    const channel = createGenerationChannel({ path, pollMs: 5 });
    const seen: number[] = [];
    const unsubscribe = channel.subscribe((generation) => {
      seen.push(generation);
    });

    writeGeneration(path, 2);
    await wait(40);
    assert.deepEqual(seen, [2]);
    assert.equal(channel.current(), 2);

    unsubscribe();
    channel.close();
  });

  it('does not notify when the value is unchanged', async () => {
    const path = generationFilePath(tempRoot());
    writeGeneration(path, 3);
    const channel = createGenerationChannel({ path, pollMs: 5 });
    let calls = 0;
    const unsubscribe = channel.subscribe(() => {
      calls += 1;
    });

    writeGeneration(path, 3);
    await wait(40);
    assert.equal(calls, 0);

    unsubscribe();
    channel.close();
  });

  it('stops polling when the last subscriber leaves', async () => {
    const path = generationFilePath(tempRoot());
    writeGeneration(path, 1);
    const channel = createGenerationChannel({ path, pollMs: 5 });
    const seen: number[] = [];
    const unsubscribe = channel.subscribe((generation) => {
      seen.push(generation);
    });
    unsubscribe();

    writeGeneration(path, 2);
    await wait(40);
    assert.deepEqual(seen, [], 'no listener, no notification');
    assert.equal(channel.current(), 1, 'value is not refreshed while idle');

    channel.close();
  });

  it('ignores subscribe after close', () => {
    const path = generationFilePath(tempRoot());
    const channel = createGenerationChannel({ path, pollMs: 5 });
    channel.close();
    const unsubscribe = channel.subscribe(() => {
      throw new Error('must not be called');
    });
    unsubscribe();
  });
});
