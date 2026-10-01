/**
 * Tests for syntax-error locations: the Node location block is read only in
 * its exact shape and only for the error in hand, and a module whose import
 * failed to parse is wrapped in a value-free error naming its file, line and
 * column, which `node --check` reports and the import's error does not, for
 * the imported file or one it imports, never by running the module.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  decoratedSyntaxLocation,
  explainModuleImportFailure,
  ModuleSyntaxErrors,
} from '../../src/support/syntax-location.server.js';
import { importFile } from '../../src/support/project-paths.server.js';

const SECRET = 'sk_live_FAKE0123456789';
const temp = mkdtempSync(join(tmpdir(), 'jsails-syntax-location-'));
after(() => rmSync(temp, { recursive: true, force: true }));

const file = join(temp, 'config.js');
const header = "SyntaxError: Unexpected identifier 'b'";

async function importError(path: string): Promise<unknown> {
  return importFile(path).then(
    () => assert.fail('the module should not parse'),
    (error: unknown) => error,
  );
}

describe('decoratedSyntaxLocation', () => {
  it('reads the file, line and column of a location block', () => {
    const text = `${file}:2\n  a: 1 b: 2\n       ^\n\n${header}\n    at x (node:internal/y:1:1)`;
    assert.deepEqual(decoratedSyntaxLocation(text, header), { file, line: 2, column: 8 });
    const url = `${pathToFileURL(file).href}:2\n  a: 1 b: 2\n       ^\n\n${header}`;
    assert.deepEqual(decoratedSyntaxLocation(url, header), { file, line: 2, column: 8 });
  });

  it('reads a block whose lines end with CRLF', () => {
    const text = `${file}:2\r\n  a: 1 b: 2\r\n       ^\r\n\r\n${header}\r\n`;
    assert.deepEqual(decoratedSyntaxLocation(text, header), { file, line: 2, column: 8 });
  });

  it('counts a tab in the source as one column', () => {
    const text = `${file}:3\n\ta: 1 b: 2\n\t     ^\n\n${header}`;
    assert.deepEqual(decoratedSyntaxLocation(text, header), { file, line: 3, column: 7 });
  });

  it('leaves the column out when the caret line cannot be read reliably', () => {
    const wide = `${file}:1\nconst é = 1 b\n            ^\n\n${header}`;
    assert.deepEqual(decoratedSyntaxLocation(wide, header), { file, line: 1, column: undefined });
    const misaligned = `${file}:1\n\ta b\n   ^\n\n${header}`;
    assert.equal(decoratedSyntaxLocation(misaligned, header)?.column, undefined);
  });

  it('refuses a block for another error, a relative path, or anything ahead of it', () => {
    const block = `${file}:2\n  a: 1 b: 2\n       ^\n\n`;
    assert.equal(decoratedSyntaxLocation(`${block}SyntaxError: other`, header), undefined);
    assert.equal(
      decoratedSyntaxLocation(`config.js:2\n  a: 1 b: 2\n       ^\n\n${header}`, header),
      undefined,
    );
    assert.equal(decoratedSyntaxLocation(`(node) warning\n${block}${header}`, header), undefined);
    assert.equal(decoratedSyntaxLocation(`${header}\n    at x (${file}:2:3)`, header), undefined);
  });
});

describe('explainModuleImportFailure', () => {
  it('names the file, line and column of an ES module that does not parse', async () => {
    writeFileSync(file, `export default {\n  a: 1 ${SECRET}: 2,\n};\n`);
    writeFileSync(join(temp, 'package.json'), '{ "type": "module" }\n');
    const error = await importError(file);
    const explained = await explainModuleImportFailure(file, error, temp);
    assert.ok(ModuleSyntaxErrors.is(explained, 'syntax_error'));
    assert.equal(explained.message, 'syntax error at config.js:2:8');
    assert.equal(explained.cause, error);
    assert.ok(!explained.message.includes(SECRET));
  });

  it('names the place when cwd reaches the project through a link', async () => {
    // `node --check` names the file by its real path; cwd here is a link to
    // it, the way macOS's /var is /private/var and a Windows temporary
    // directory can hold an 8.3 short name.
    const real = join(temp, 'real-project');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(join(real, 'linked.js'), `export default {\n  a: 1 ${SECRET}: 2,\n};\n`);
    const linked = join(temp, 'linked-project');
    symlinkSync(real, linked, 'junction');
    const entry = join(linked, 'linked.js');
    const error = await importError(entry);
    const explained = await explainModuleImportFailure(entry, error, linked);
    assert.ok(ModuleSyntaxErrors.is(explained, 'syntax_error'));
    assert.equal(explained.message, 'syntax error at linked.js:2:8');
  });

  it('names the place in a module the imported file imports', async () => {
    const lib = join(temp, 'lib');
    mkdirSync(lib, { recursive: true });
    const broken = join(lib, 'broken-dependency.js');
    const importer = join(temp, 'importer.js');
    writeFileSync(join(lib, 'fine.js'), 'export const fine = 1;\n');
    writeFileSync(broken, `export default { a: 1 ${SECRET}: 2 };\n`);
    writeFileSync(
      importer,
      "import { fine } from './lib/fine.js';\nimport './lib/broken-dependency.js';\nexport default fine;\n",
    );
    const error = await importError(importer);
    assert.ok(error instanceof SyntaxError);
    const explained = await explainModuleImportFailure(importer, error, temp);
    assert.ok(ModuleSyntaxErrors.is(explained, 'syntax_error'));
    assert.equal(explained.message, 'syntax error at lib/broken-dependency.js:1:23');
    assert.equal(explained.cause, error);
  });

  it('leaves a SyntaxError the module threw while running alone, and runs none of its code', async () => {
    const marker = join(temp, 'ran.txt');
    const runner = join(temp, 'runner.js');
    writeFileSync(
      runner,
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(marker)}, 'ran');\n` +
        `JSON.parse('{ ${SECRET}');\n`,
    );
    const error = await importError(runner);
    rmSync(marker, { force: true });
    assert.ok(error instanceof SyntaxError);
    assert.equal(await explainModuleImportFailure(runner, error, temp), error);
    assert.equal(existsSync(marker), false, 'the search parses modules, never runs them');
  });

  it('does not follow an import out of cwd', async () => {
    const inside = join(temp, 'inner');
    mkdirSync(inside, { recursive: true });
    writeFileSync(join(temp, 'outer-broken.js'), 'export default { a: 1 b: 2 };\n');
    const importer = join(inside, 'importer.js');
    writeFileSync(importer, "import '../outer-broken.js';\nexport default 1;\n");
    const error = await importError(importer);
    assert.equal(await explainModuleImportFailure(importer, error, inside), error);
  });

  it('leaves any other error, and a file outside cwd, alone', async () => {
    const failure = new Error(SECRET);
    assert.equal(await explainModuleImportFailure(file, failure, temp), failure);
    const error = await importError(file);
    const elsewhere = mkdtempSync(join(tmpdir(), 'jsails-syntax-elsewhere-'));
    try {
      assert.equal(await explainModuleImportFailure(file, error, elsewhere), error);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
