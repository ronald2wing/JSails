/**
 * Tests for the cause-chain renderer: each kind of link prints only its
 * value-free facts (a registry error its message and hint; any other error its
 * class name, Node code and source location; a non-error its type), the walk
 * is bounded and cycle-safe, and `JSAILS_DEBUG=1` adds every summarised
 * link's message and stack in place of the closing note. A registry link's
 * text comes from its definition, never from the object, and a value built to
 * break the walk does not.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEBUG_NOTE,
  renderCauseChain,
  renderFailureReport,
} from '../../src/errors/cause-chain.server.js';
import { JsailsError } from '../../src/errors/jsails-error.js';
import { defineErrors } from '../../src/errors/registry.js';
import { importFile } from '../../src/support/project-paths.server.js';

/** The compiled test's own directory: frames thrown here read relative to it. */
const HERE = dirname(fileURLToPath(import.meta.url));
const THIS_FILE = 'cause-chain.test.js';
const SECRET = 'sk_live_FAKE0123456789';

const temp = mkdtempSync(join(tmpdir(), 'jsails-cause-chain-'));
after(() => rmSync(temp, { recursive: true, force: true }));

const Wrap = defineErrors('test_cause_chain', {
  load_failed: {
    kind: 'internal',
    message: 'failed to load config {path}',
    context: { path: 'relative-path' },
    suggestion: 'check the module',
  },
  step_failed: { kind: 'internal', message: 'step {name} failed', context: { name: 'identifier' } },
});

function wrap(cause: unknown): Error {
  return new Wrap.Error('load_failed', { path: 'jsails.app.js' }, { cause });
}

function render(thrown: unknown, env: Record<string, string> = {}, cwd = HERE): string[] {
  return renderCauseChain(thrown, { env, cwd });
}

const DEBUG = { JSAILS_DEBUG: '1' };

/** The error `import()` throws for a module with a syntax error naming the secret. */
async function importSyntaxError(): Promise<unknown> {
  const file = join(temp, 'broken.mjs');
  writeFileSync(file, `export default {\n  key: 1 ${SECRET}: 2,\n};\n`);
  return importFile(file).then(
    () => assert.fail('the module should not parse'),
    (error: unknown) => error,
  );
}

describe('renderCauseChain: link kinds', () => {
  it('prints nothing for an error without a cause', () => {
    assert.deepEqual(render(wrap(undefined)), []);
    assert.deepEqual(render(new Error(SECRET)), []);
  });

  it('prints a registry link whole, message and hint, with no closing note', () => {
    const inner = new Wrap.Error('step_failed', { name: 'migrate' });
    assert.deepEqual(render(wrap(inner)), ['  caused by: step migrate failed']);
    const hinted = wrap(wrap(undefined));
    assert.deepEqual(render(hinted), [
      '  caused by: failed to load config jsails.app.js',
      '    hint: check the module',
    ]);
  });

  it('prints a foreign error as its class name and where it was thrown, never its message', () => {
    const lines = render(wrap(new TypeError(`bad key ${SECRET}`)));
    assert.equal(lines.length, 2);
    assert.match(
      lines[0] ?? '',
      new RegExp(`^ {2}caused by: TypeError at ${THIS_FILE}:\\d+:\\d+$`),
    );
    assert.equal(lines[1], DEBUG_NOTE);
    assert.ok(!lines.join('\n').includes(SECRET));
  });

  it('prints a placeholder for a location outside the working directory', () => {
    const lines = render(wrap(new Error(SECRET)), {}, temp);
    assert.equal(lines[0], '  caused by: Error at (outside the working directory)');
  });

  it('reads no location from frame-shaped text a message brings along', () => {
    const forged = new Error(`boom\n    at /home/me/${SECRET}.js:1:1`);
    const [line] = render(wrap(forged));
    assert.match(line ?? '', new RegExp(`^ {2}caused by: Error at ${THIS_FILE}:\\d+:\\d+$`));
    assert.ok(!(line ?? '').includes(SECRET));

    const rewritten = new Error('boom');
    rewritten.stack = `Error: other\n    at /home/me/${SECRET}.js:1:1`;
    assert.equal(render(wrap(rewritten))[0], '  caused by: Error');
  });

  it('summarises the SyntaxError of an ES module import: Node 26 puts no location on it', async () => {
    const error = await importSyntaxError();
    assert.ok(error instanceof SyntaxError);
    assert.ok(error.message.includes(SECRET), 'the parser names the offending token');

    const lines = render(wrap(error));
    assert.deepEqual(lines, ['  caused by: SyntaxError', DEBUG_NOTE]);

    const debug = render(wrap(error), DEBUG).join('\n');
    assert.ok(debug.includes(SECRET), 'debug prints the parser message');
    assert.ok(!debug.includes(DEBUG_NOTE));
  });

  it('reads the location block of a CommonJS SyntaxError, never its source line', () => {
    const file = join(temp, 'broken.cjs');
    writeFileSync(file, `module.exports = {\n\tkey: 1 ${SECRET}: 2,\n};\n`);
    let error: unknown;
    try {
      createRequire(import.meta.url)(file);
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error instanceof SyntaxError);
    assert.ok(error.stack?.includes(SECRET), 'Node puts the source line on the stack');
    const lines = render(wrap(error), {}, temp);
    assert.deepEqual(lines, ['  caused by: SyntaxError at broken.cjs:2:9', DEBUG_NOTE]);
    assert.ok(render(wrap(error), DEBUG, temp).join('\n').includes(`\tkey: 1 ${SECRET}: 2,`));
  });

  it('names a file inside a working directory reached through a link', () => {
    // macOS's temporary directory is a link to /private/var and Windows CI's
    // holds an 8.3 short name: Node's stack names the real path, the working
    // directory the other spelling, and the file is still inside it.
    const real = join(temp, 'real-project');
    mkdirSync(real, { recursive: true });
    const linked = join(temp, 'linked-project');
    symlinkSync(real, linked, 'junction');
    writeFileSync(join(real, 'linked.cjs'), `module.exports = {\n\tkey: 1 ${SECRET}: 2,\n};\n`);
    let error: unknown;
    try {
      createRequire(import.meta.url)(join(linked, 'linked.cjs'));
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error instanceof SyntaxError);
    assert.deepEqual(render(wrap(error), {}, linked), [
      '  caused by: SyntaxError at linked.cjs:2:9',
      DEBUG_NOTE,
    ]);
  });

  it('reads the location block of an ES module link error', async () => {
    writeFileSync(join(temp, 'exporter.mjs'), 'export const present = 1;\n');
    const importer = join(temp, 'linker.mjs');
    writeFileSync(importer, `import { ${SECRET} } from './exporter.mjs';\nexport default 1;\n`);
    const error = await importFile(importer).then(
      () => assert.fail('the module should not link'),
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof SyntaxError);
    const lines = render(wrap(error), {}, temp);
    assert.deepEqual(lines, ['  caused by: SyntaxError at linker.mjs:1:10', DEBUG_NOTE]);
  });

  it('prints a Node errno code and leaves out the path the message names', async () => {
    const missing = join(temp, SECRET);
    const error = await readFile(missing).then(
      () => assert.fail('the file should not exist'),
      (thrown: unknown) => thrown,
    );
    const lines = render(wrap(error));
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', /^ {2}caused by: Error ENOENT \(open\)( at \S+)?$/);
    assert.ok(!lines.join('\n').includes(SECRET));
    assert.ok(render(wrap(error), DEBUG).join('\n').includes(SECRET));
  });

  it("prints a Node ERR_* code and reads the location under Node's own header", () => {
    let error: unknown;
    try {
      new URL(SECRET);
    } catch (thrown) {
      error = thrown;
    }
    const [line] = render(wrap(error));
    assert.match(
      line ?? '',
      new RegExp(`^ {2}caused by: TypeError ERR_INVALID_URL at ${THIS_FILE}:\\d+:\\d+$`),
    );
  });

  it('prints a hand-written framework error as its class name and code', () => {
    class LegacyError extends JsailsError {
      readonly code = 'legacy_failure';
    }
    assert.deepEqual(render(wrap(new LegacyError(`token=${SECRET}`))), [
      '  caused by: LegacyError (legacy_failure)',
      DEBUG_NOTE,
    ]);
  });

  it('prints a thrown non-error value as its type', () => {
    assert.deepEqual(render(wrap(SECRET)), ['  caused by: a thrown string', DEBUG_NOTE]);
    assert.equal(render(wrap({ token: SECRET }))[0], '  caused by: a thrown object');
    assert.equal(render(wrap(null))[0], '  caused by: a thrown null');
    assert.equal(render(wrap(42))[0], '  caused by: a thrown number');
    assert.deepEqual(render(wrap({ token: SECRET }), DEBUG), [
      '  caused by: a thrown object',
      `      { token: '${SECRET}' }`,
    ]);
  });

  it('prints "error" for a class name that is not a plain identifier ending in Error', () => {
    for (const name of [`token=${SECRET}`, 'Bad Error', SECRET, 'lowercaseError', '']) {
      const error = new Error('x');
      error.name = name;
      error.stack = undefined;
      assert.equal(render(wrap(error))[0], '  caused by: error', JSON.stringify(name));
    }
    const named = new Error('x');
    named.name = 'DatabaseConnectionError';
    named.stack = undefined;
    assert.equal(render(wrap(named))[0], '  caused by: DatabaseConnectionError');
  });

  it('reads past a property getter that throws', () => {
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'name', {
      get() {
        throw new Error(SECRET);
      },
    });
    Object.defineProperty(hostile, 'cause', {
      get() {
        throw new Error(SECRET);
      },
    });
    const lines = render(wrap(hostile));
    assert.deepEqual(lines.slice(1), ['  caused by: (a cause that could not be read)', DEBUG_NOTE]);
    assert.match(lines[0] ?? '', /^ {2}caused by: error( at \S+)?$/);
    assert.ok(!lines.join('\n').includes(SECRET));
  });

  it('re-renders a registry link from its code and context, never its own message or hint', () => {
    const inner = new Wrap.Error('step_failed', { name: 'migrate' });
    inner.message += ` (DATABASE_URL=postgres://u:${SECRET}@h)`;
    Object.defineProperty(inner, 'suggestion', { value: `use ${SECRET}` });
    assert.deepEqual(render(wrap(inner)), ['  caused by: step migrate failed']);

    const derived = Object.create(inner) as Error;
    Object.defineProperty(derived, 'message', { value: SECRET });
    assert.deepEqual(render(wrap(derived)), ['  caused by: step migrate failed']);
  });

  it('treats a forged registry brand whose code renders through no definition as foreign', () => {
    const forged = {
      [Symbol.for('jsails.error')]: true,
      [Symbol.for('jsails.error.registered')]: true,
      code: 'test_cause_chain.step_failed',
      context: { name: `${SECRET} with spaces` },
      message: SECRET,
      suggestion: SECRET,
    };
    const lines = render(wrap(forged));
    assert.deepEqual(lines, ['  caused by: error (test_cause_chain.step_failed)', DEBUG_NOTE]);
    const unknown = { ...forged, code: 'no_such_domain.code', context: {} };
    assert.ok(!render(wrap(unknown)).join('\n').includes(SECRET));
  });

  it('prints a known errno code, a database code and a system call, and no token-shaped code', () => {
    const coded = (code: string, extra: Record<string, unknown> = {}): Error => {
      const error = Object.assign(new Error(SECRET), { code, ...extra });
      error.stack = undefined;
      return error;
    };
    assert.equal(
      render(wrap(coded('ECONNREFUSED', { syscall: 'connect' })))[0],
      '  caused by: Error ECONNREFUSED (connect)',
    );
    assert.equal(render(wrap(coded('ENOTFOUND')))[0], '  caused by: Error ENOTFOUND');
    assert.equal(
      render(wrap(coded('ER_ACCESS_DENIED_ERROR')))[0],
      '  caused by: Error ER_ACCESS_DENIED_ERROR',
    );
    assert.equal(render(wrap(coded('28P01')))[0], '  caused by: Error 28P01');
    for (const code of ['ESKLIVESECRET123', 'ER_TOKEN_123', SECRET, 'sk_live']) {
      assert.equal(render(wrap(coded(code)))[0], '  caused by: Error', code);
    }
    assert.equal(
      render(wrap(coded('ENOENT', { syscall: `spawn ${SECRET}` })))[0],
      '  caused by: Error ENOENT',
    );
  });

  it("prints a hand-written framework error's code only when it reads as a framework code", () => {
    class TokenError extends JsailsError {
      readonly code = `BAD_${SECRET}`;
    }
    assert.equal(render(wrap(new TokenError('x')))[0], '  caused by: TokenError');
  });

  it('caps a <Name>Error class name at 40 characters', () => {
    const error = new Error('x');
    error.name = `${'A'.repeat(36)}Error`;
    error.stack = undefined;
    assert.equal(render(wrap(error))[0], '  caused by: error');
  });

  it('reads the location after a function name that holds a path', () => {
    const key = `x (${HERE}/${SECRET}`;
    const holder = {
      [key](): never {
        throw new Error('boom');
      },
    };
    let error: unknown;
    try {
      (holder[key] as () => never).call(holder);
    } catch (thrown) {
      error = thrown;
    }
    const [line] = render(wrap(error));
    assert.match(line ?? '', new RegExp(`^ {2}caused by: Error at ${THIS_FILE}:\\d+:\\d+$`));
    assert.ok(!(line ?? '').includes(SECRET));
  });

  it('prints no location for a frame naming a file that does not exist', () => {
    const error = new Error('boom');
    error.stack = `Error: boom\n    at ${join(HERE, SECRET)}.js:1:1`;
    assert.equal(render(wrap(error))[0], '  caused by: Error');
  });
});

describe('renderCauseChain: the walk', () => {
  it('lists the first members of an AggregateError and counts the rest', () => {
    const members = [0, 1, 2, 3, 4].map((index) => {
      const error = new Error(`${SECRET}-${index}`);
      (error as { code?: string }).code = 'ECONNREFUSED';
      error.stack = undefined;
      return error;
    });
    const aggregate = new AggregateError(members, SECRET);
    aggregate.stack = undefined;
    assert.deepEqual(render(wrap(aggregate)), [
      '  caused by: AggregateError (5 errors)',
      '    1. Error ECONNREFUSED',
      '    2. Error ECONNREFUSED',
      '    3. Error ECONNREFUSED',
      '    … and 2 more',
      DEBUG_NOTE,
    ]);
  });

  it("follows an aggregate member's own cause, nested under it", () => {
    const member = new Error('x', { cause: new Wrap.Error('step_failed', { name: 'dns' }) });
    member.stack = undefined;
    const aggregate = new AggregateError([member]);
    aggregate.stack = undefined;
    assert.deepEqual(render(wrap(aggregate)), [
      '  caused by: AggregateError (1 error)',
      '    1. Error',
      '    caused by: step dns failed',
      DEBUG_NOTE,
    ]);
  });

  it('stops at a cycle', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;
    first.stack = undefined;
    second.stack = undefined;
    assert.deepEqual(render(wrap(first)), [
      '  caused by: Error',
      '  caused by: Error',
      '  caused by: (an error shown above: the chain loops)',
      DEBUG_NOTE,
    ]);
    const top = wrap(undefined);
    (top as { cause?: unknown }).cause = top;
    assert.deepEqual(render(top), ['  caused by: (an error shown above: the chain loops)']);
  });

  it('survives an AggregateError whose members are a hostile proxy', () => {
    const trapping = new AggregateError([]);
    Object.defineProperty(trapping, 'errors', {
      value: new Proxy([1, 2], {
        get(target, key) {
          if (key === 'slice' || key === '0') throw new Error(SECRET);
          return Reflect.get(target, key) as unknown;
        },
      }),
    });
    const lines = render(wrap(trapping));
    assert.ok(!lines.join('\n').includes(SECRET));
    assert.equal(lines.at(-1), DEBUG_NOTE);

    const { proxy, revoke } = Proxy.revocable<unknown[]>([], {});
    const revoked = new AggregateError([]);
    Object.defineProperty(revoked, 'errors', { value: proxy });
    revoke();
    assert.doesNotThrow(() => render(wrap(revoked)));
  });

  it('stops after eight links', () => {
    let chain: unknown = new Wrap.Error('step_failed', { name: 'last' });
    for (let index = 0; index < 11; index += 1) {
      chain = new Wrap.Error('step_failed', { name: `step${index}` }, { cause: chain });
    }
    const lines = render(wrap(chain));
    assert.equal(lines.length, 9);
    assert.equal(lines[7], '  caused by: step step3 failed');
    assert.equal(lines[8], '  caused by: (further causes not shown)');
  });
});

describe('renderCauseChain: head and debug', () => {
  it('summarises a withheld top error on an error: line', () => {
    const lines = renderCauseChain(new RangeError(SECRET), {
      env: {},
      cwd: HERE,
      head: 'withheld',
    });
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', new RegExp(`^ {2}error: RangeError at ${THIS_FILE}:\\d+:\\d+$`));
    assert.equal(lines[1], DEBUG_NOTE);
  });

  it('adds each summarised link’s message and stack under JSAILS_DEBUG=1', () => {
    const cause = new TypeError(`bad key ${SECRET}`);
    const lines = render(wrap(cause), DEBUG);
    assert.match(lines[0] ?? '', /^ {2}caused by: TypeError at /);
    assert.equal(lines[1], `      bad key ${SECRET}`);
    assert.match(lines[2] ?? '', new RegExp(`^ {10}at .*${THIS_FILE}:\\d+:\\d+\\)?$`));
    assert.ok(!lines.includes(DEBUG_NOTE));
  });

  it('reads JSAILS_DEBUG only as exactly 1', () => {
    for (const value of ['0', 'true', '', 'yes']) {
      const lines = render(wrap(new Error(SECRET)), { JSAILS_DEBUG: value });
      assert.ok(!lines.join('\n').includes(SECRET), value);
      assert.equal(lines.at(-1), DEBUG_NOTE);
    }
  });

  it("strips Node's `Name [CODE]:` header from a debug stack, so the message prints once", () => {
    let error: unknown;
    try {
      new TextDecoder(SECRET);
    } catch (thrown) {
      error = thrown;
    }
    assert.match(String((error as Error).stack), /^RangeError \[ERR_ENCODING_NOT_SUPPORTED\]: /);
    const debug = render(wrap(error), DEBUG).join('\n');
    assert.equal(debug.split(SECRET).length - 1, 1, debug);
  });

  it('prints a shown foreign top error’s stack under debug, not its message again', () => {
    const lines = render(new Error(SECRET), DEBUG);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((line) => line.startsWith('        at ')));
  });
});

describe('renderFailureReport', () => {
  function report(thrown: unknown, env: Record<string, string> = {}): string[] {
    return renderFailureReport(thrown, { program: 'jamal', env, cwd: HERE });
  }

  it("prints a registry error's text rendered from its definition", () => {
    const error = new Wrap.Error('load_failed', { path: 'jsails.app.js' });
    error.message += ` ${SECRET}`;
    assert.deepEqual(report(error), [
      'jamal: failed to load config jsails.app.js',
      '  hint: check the module',
    ]);
  });

  it("prints a framework error's message and withholds any other error's", () => {
    class PlainError extends JsailsError {
      readonly code = 'plain';
    }
    assert.deepEqual(report(new PlainError('backup failed')), ['jamal: backup failed']);
    const lines = report(new Error(`postgres://app:${SECRET}@db`));
    assert.equal(lines[0], 'jamal: the command failed');
    assert.match(lines[1] ?? '', new RegExp(`^ {2}error: Error at ${THIS_FILE}:\\d+:\\d+$`));
    assert.equal(lines[2], DEBUG_NOTE);
    assert.ok(!lines.join('\n').includes(SECRET));
    assert.ok(report(new Error(SECRET), DEBUG).join('\n').includes(SECRET));
  });

  it('puts the label ahead of the line and withholds a forged registry error', () => {
    const forged = {
      [Symbol.for('jsails.error')]: true,
      [Symbol.for('jsails.error.registered')]: true,
      code: 'nowhere.code',
      context: {},
      message: SECRET,
    };
    const lines = renderFailureReport(forged, {
      program: 'jsails',
      label: 'deploy',
      fallback: 'it failed',
      env: {},
      cwd: HERE,
    });
    assert.deepEqual(lines, [
      'jsails: deploy: it failed',
      '  error: error (nowhere.code)',
      DEBUG_NOTE,
    ]);
  });
});
