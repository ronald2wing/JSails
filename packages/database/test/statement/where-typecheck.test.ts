/**
 * The cost of `Where<T>` under the compiler this repository builds with
 * (tsc 7): a generated 40-column model with 400 `Where` and `Q` uses is
 * typechecked by tsc with `--extendedDiagnostics`, next to the same program
 * written with `Partial<T>`. The instantiations `Where` adds are
 * deterministic for a pinned compiler and must stay within budget, which
 * catches a mapped or conditional type that starts to blow up. The check time
 * must stay under a ceiling with ample headroom for a slow CI runner, which
 * is the timing guard itself. A variant with four misuses must fail with
 * exactly four errors, so the program being measured is one that the types
 * actually check.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const COLUMNS = 40;
const ROUNDS = 200;
/**
 * Instantiations `Where` and `Q` may add over the `Partial` program: about
 * 16,700 when recorded (3 or 4 per `Where` literal, about 80 per contextually
 * typed `Q` call), and about 52,000 before `Q` stopped inferring its row type
 * from its items.
 */
const INSTANTIATION_BUDGET = 25_000;
/** Check time of the `Where` program; about 0.03 s when recorded. */
const CHECK_SECONDS_CEILING = 3;

const VALUE_TYPES = [
  'string',
  'number',
  'Date',
  'boolean',
  'string | null',
  'number | null',
  "'draft' | 'live' | 'gone'",
  'Uint8Array',
  'bigint',
  '{ readonly theme: string } | null',
] as const;

function posix(path: string): string {
  return path.split(sep).join('/');
}

function tscEntry(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('@typescript/native/package.json')), 'bin', 'tsc');
}

/** The compiled declarations of the predicate compiler. */
const WHERE_TYPES = posix(
  fileURLToPath(new URL('../../src/statement/where.d.ts', import.meta.url)),
);

function modelClass(): string {
  const fields = Array.from(
    { length: COLUMNS },
    (_, index) => `  declare c${index}: ${VALUE_TYPES[index % VALUE_TYPES.length] as string};`,
  );
  return `export class Wide {\n${fields.join('\n')}\n  save(): void {}\n}\n`;
}

/** 400 uses: per round a `Where` literal and a `Q` combination, on rotating columns. */
function whereProgram(): string {
  const uses = Array.from({ length: ROUNDS }, (_, round) => {
    const text = `c${(round * 10) % COLUMNS}`;
    const count = `c${(round * 10 + 1) % COLUMNS}`;
    const flag = `c${(round * 10 + 3) % COLUMNS}`;
    const nullable = `c${(round * 10 + 4) % COLUMNS}`;
    const status = `c${(round * 10 + 6) % COLUMNS}`;
    return [
      `export const w${round}: Where<Wide> = { ${text}: 't${round}', ${count}: { gte: ${round}, lt: ${round + 10} }, ${nullable}: null, ${status}: ['draft', 'live'] };`,
      `export const q${round}: WhereInput<Wide> = Q.or({ ${flag}: true }, Q.not({ ${text}: { like: 'a%' } }), { ${count}: { in: [1, 2] } });`,
    ].join('\n');
  });
  return `import { Q, type Where, type WhereInput } from 'jsails-where';\n${modelClass()}${uses.join('\n')}\n`;
}

/** The same shape of program written with `Partial`, as the baseline. */
function partialProgram(): string {
  const uses = Array.from({ length: ROUNDS }, (_, round) => {
    const text = `c${(round * 10) % COLUMNS}`;
    const count = `c${(round * 10 + 1) % COLUMNS}`;
    const flag = `c${(round * 10 + 3) % COLUMNS}`;
    const nullable = `c${(round * 10 + 4) % COLUMNS}`;
    const status = `c${(round * 10 + 6) % COLUMNS}`;
    return [
      `export const w${round}: Partial<Wide> = { ${text}: 't${round}', ${count}: ${round}, ${nullable}: null, ${status}: 'draft' };`,
      `export const q${round}: Partial<Wide>[] = [{ ${flag}: true }, { ${text}: 'a' }, { ${count}: 1 }];`,
    ].join('\n');
  });
  return `${modelClass()}${uses.join('\n')}\n`;
}

/** Four misuses, each one error: unknown column, wrong value, `like` on a number, `null` on a non-null. */
function misuseProgram(): string {
  return [
    `import type { Where } from 'jsails-where';`,
    modelClass(),
    `export const a: Where<Wide> = { nope: 1 };`,
    `export const b: Where<Wide> = { c1: 'ten' };`,
    `export const c: Where<Wide> = { c1: { like: '1%' } };`,
    `export const d: Where<Wide> = { c0: null };`,
    '',
  ].join('\n');
}

interface Diagnostics {
  readonly exitCode: number;
  readonly output: string;
  readonly instantiations: number;
  readonly checkSeconds: number;
}

function typecheck(directory: string, name: string, source: string): Promise<Diagnostics> {
  writeFileSync(join(directory, `${name}.ts`), source);
  writeFileSync(
    join(directory, `${name}.json`),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'nodenext',
        target: 'es2024',
        types: [],
        skipLibCheck: true,
        paths: { 'jsails-where': [WHERE_TYPES] },
      },
      files: [`${name}.ts`],
    }),
  );
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        tscEntry(),
        '-p',
        join(directory, `${name}.json`),
        '--extendedDiagnostics',
        '--singleThreaded',
      ],
      { cwd: directory, timeout: 120_000 },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`;
        if (error !== null && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        const instantiations = /^Instantiations:\s+(\d+)$/m.exec(output)?.[1];
        const checkSeconds = /^Check time:\s+([\d.]+)s$/m.exec(output)?.[1];
        if (instantiations === undefined || checkSeconds === undefined) {
          reject(new Error(`tsc printed no diagnostics:\n${output}`));
          return;
        }
        resolve({
          exitCode: error === null ? 0 : (error.code as number),
          output,
          instantiations: Number(instantiations),
          checkSeconds: Number(checkSeconds),
        });
      },
    );
  });
}

describe('Where<T> typecheck cost', () => {
  it(`checks a ${COLUMNS}-column model with ${ROUNDS * 2} uses within budget`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'jsails-where-tsc-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));

    const where = await typecheck(directory, 'where', whereProgram());
    assert.equal(where.exitCode, 0, `the Where program typechecks:\n${where.output}`);
    const partial = await typecheck(directory, 'partial', partialProgram());
    assert.equal(partial.exitCode, 0, `the Partial program typechecks:\n${partial.output}`);

    const added = where.instantiations - partial.instantiations;
    assert.ok(
      added <= INSTANTIATION_BUDGET,
      `Where adds ${added} instantiations, over the budget of ${INSTANTIATION_BUDGET}`,
    );
    assert.ok(
      where.checkSeconds <= CHECK_SECONDS_CEILING,
      `the Where program took ${where.checkSeconds} s to check, over ${CHECK_SECONDS_CEILING} s`,
    );

    const misuse = await typecheck(directory, 'misuse', misuseProgram());
    assert.notEqual(misuse.exitCode, 0);
    assert.equal(
      misuse.output.match(/error TS\d+/g)?.length,
      4,
      `each misuse is one error:\n${misuse.output}`,
    );
  });
});
