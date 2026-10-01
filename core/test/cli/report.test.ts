/**
 * Tests for the CLI's failure report: the operator sees a framework error's
 * own message and hint (a registry error's rendered from its definition), a
 * fixed line in place of any other error's message, then the value-free cause
 * chain; the exit code follows the boundary table, and an aborted command
 * prints nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reportFailure, renderResult, writeFailure } from '../../src/cli/report.js';
import { DEBUG_NOTE } from '../../src/errors/cause-chain.server.js';
import { BOUNDARY_TABLE } from '../../src/errors/boundary-table.server.js';
import { JsailsError } from '../../src/errors/jsails-error.js';
import { notFound } from '../../src/errors/kernel.js';
import { ERROR_KINDS, type ErrorKind } from '../../src/errors/kinds.js';
import { defineErrors } from '../../src/errors/registry.js';

class KindError extends JsailsError {
  readonly code = 'test_kind';
  constructor(kind: ErrorKind) {
    super(`failed as ${kind}`, { kind, suggestion: 'try again' });
  }
}

async function capture(
  thrown: unknown,
  env: Record<string, string> = {},
): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await reportFailure(thrown, (line) => lines.push(line), { env });
  return { code, lines };
}

const Wrapper = defineErrors('test_cli_report_wrapper', {
  load_failed: {
    kind: 'unavailable',
    message: 'failed to load {name}',
    context: { name: 'identifier' },
  },
});

describe('reportFailure', () => {
  it('exits with each kind exit code from the boundary table', async () => {
    for (const kind of ERROR_KINDS) {
      assert.equal((await capture(new KindError(kind))).code, BOUNDARY_TABLE[kind].exitCode, kind);
    }
  });

  it('prints the message and hint of operator and client errors alike', async () => {
    assert.deepEqual(await capture(new KindError('unavailable')), {
      code: 75,
      lines: ['jsails: failed as unavailable', '  hint: try again'],
    });
    const Cli = defineErrors('test_cli_report', {
      missing: {
        kind: 'not_found',
        message: 'command {name} is not defined',
        context: { name: 'identifier' },
      },
    });
    assert.deepEqual((await capture(new Cli.Error('missing', { name: 'deploy' }))).lines, [
      'jsails: command deploy is not defined',
    ]);
    assert.equal(
      (await capture(notFound())).lines[0],
      'jsails: The requested resource was not found.',
    );
  });

  it("withholds a foreign error's message, summarises it and exits 1", async () => {
    const error = new Error('could not connect to postgres://app:sk_live_PASSWORD@db/app');
    error.stack = undefined;
    assert.deepEqual(await capture(error), {
      code: 1,
      lines: ['jsails: the command failed', '  error: Error', DEBUG_NOTE],
    });
    const debug = await capture(error, { JSAILS_DEBUG: '1' });
    assert.ok(debug.lines.join('\n').includes('sk_live_PASSWORD'));
  });

  it("prints a registry error's text from its definition, not what was appended to it", async () => {
    const error = new Wrapper.Error('load_failed', { name: 'config' });
    error.message += ' (DATABASE_URL=postgres://u:sk_live_SECRET@h)';
    assert.deepEqual((await capture(error)).lines, ['jsails: failed to load config']);
  });

  it("follows the message with the cause chain, value-free, and keeps the kind's exit code", async () => {
    const cause = new Error('password=hunter2');
    cause.stack = undefined;
    assert.deepEqual(
      await capture(new Wrapper.Error('load_failed', { name: 'config' }, { cause })),
      { code: 75, lines: ['jsails: failed to load config', '  caused by: Error', DEBUG_NOTE] },
    );
  });

  it('prints the underlying message under JSAILS_DEBUG=1', async () => {
    const cause = new Error('password=hunter2');
    cause.stack = undefined;
    const { lines } = await capture(
      new Wrapper.Error('load_failed', { name: 'config' }, { cause }),
      {
        JSAILS_DEBUG: '1',
      },
    );
    assert.deepEqual(lines, [
      'jsails: failed to load config',
      '  caused by: Error',
      '      password=hunter2',
    ]);
  });

  it('prints nothing for an aborted command and exits 130', async () => {
    assert.deepEqual(await capture(new DOMException('interrupted', 'AbortError')), {
      code: 130,
      lines: [],
    });
    const aborted = new DOMException('interrupted', 'AbortError');
    Object.defineProperty(aborted, 'cause', { value: new Error('password=hunter2') });
    assert.deepEqual(await capture(aborted, { JSAILS_DEBUG: '1' }), { code: 130, lines: [] });
  });
});

describe('writeFailure', () => {
  async function write(
    thrown: unknown,
    options: Omit<Parameters<typeof writeFailure>[2], 'env'> = {},
  ) {
    const lines: string[] = [];
    await writeFailure(thrown, (line) => lines.push(line), { ...options, env: {} });
    return lines;
  }

  it('replaces a message `allow` refuses with the fallback and summarises the error', async () => {
    const error = new TypeError('password=hunter2');
    error.stack = undefined;
    assert.deepEqual(await write(error, { allow: () => false, fallback: 'the command failed' }), [
      'jsails: the command failed',
      '  error: TypeError',
      DEBUG_NOTE,
    ]);
  });

  it('puts the label ahead of the message', async () => {
    assert.deepEqual(
      await write(new KindError('internal'), { label: 'failed to load db config' }),
      ['jsails: failed to load db config: failed as internal', '  hint: try again'],
    );
  });

  it('prints a chain that loops back to the top error once', async () => {
    const cyclic = new Wrapper.Error('load_failed', { name: 'config' });
    (cyclic as { cause?: unknown }).cause = cyclic;
    assert.deepEqual(await write(cyclic), [
      'jsails: failed to load config',
      '  caused by: (an error shown above: the chain loops)',
    ]);
  });
});

describe('renderResult', () => {
  it('prints one JSON line or the human rendering', () => {
    const render = (value: { n: number }): readonly string[] => [`n is ${value.n}`];
    assert.deepEqual(renderResult({ n: 1 }, { json: true, render }), ['{"n":1}']);
    assert.deepEqual(renderResult({ n: 1 }, { json: false, render }), ['n is 1']);
  });
});
