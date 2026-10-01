/**
 * Companion test templates for the `make:*` generators. Each code generator
 * also writes a `node:test` file under `test/<kind>/`; content entries have no
 * test.
 */

import {
  camelCase,
  kebabCase,
  pascalCase,
  titleCase,
  type MakeCommandType,
} from '../../compiler/conventions.js';

/** Companion test directories for code generators. Content has no test. */
const GENERATOR_TEST_DIRS: Readonly<Partial<Record<MakeCommandType, string>>> = {
  page: 'test/pages',
  api: 'test/api',
  job: 'test/jobs',
  model: 'test/models',
  command: 'test/commands',
  'server-component': 'test/components',
  serializer: 'test/serializers',
  middleware: 'test/middleware',
};

/** Render the companion test body for a generated artifact, or undefined. */
export function renderTestTemplate(
  type: MakeCommandType,
  name: string,
  mfc: boolean,
): string | undefined {
  const pascal = pascalCase(name);
  const camel = camelCase(name);
  const kebab = kebabCase(name);

  switch (type) {
    case 'page': {
      const title = titleCase(name);
      return `/**
 * ${title} page test.
 *
 * Calls the page's \`load\` and renders the returned VNode directly. This is a
 * server-only unit test: no HTTP server, browser, or database is involved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderToString } from 'jsails/render-to-string';
import { createTestRequestContext } from 'jsails/testing';

import ${pascal}Page, { load } from '../../pages/${kebab}.js';

test('${kebab} page renders its heading', async () => {
  const context = createTestRequestContext({ url: 'http://localhost/${kebab}' });
  const html = renderToString(${pascal}Page(await load(context)));
  assert.match(html, /<h1[^>]*>${title}<\\/h1>/);
});
`;
    }
    case 'api':
      return `/**
 * ${pascal} API route test.
 *
 * Calls the route handler directly with a real request context. Authorization
 * is a pipeline concern and is not exercised here; add an app-level authorize
 * callback before exposing the route.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTestRequestContext } from 'jsails/testing';

import { GET } from '../../api/${kebab}.js';

test('GET /api/${kebab} returns a JSON success body', async () => {
  const context = createTestRequestContext({ url: 'http://localhost/api/${kebab}' });
  const response = GET(context.request, context);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
`;
    case 'job':
      return `/**
 * ${pascal} job test.
 *
 * Asserts the queue contract and validates the empty payload. Extend this with
 * a handler test once \`handle\` has observable behavior.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installFrameworkSymbols } from 'jsails/symbols';

await installFrameworkSymbols(process.cwd());
const { default: ${pascal}Job } = await import('../../jobs/${kebab}.job.js');

test('${camel} declares its queue name and payload schema', () => {
  assert.equal(${pascal}Job.jobName, '${camel}');
  assert.doesNotThrow(() => ${pascal}Job.schema.parse({}));
});
`;
    case 'model':
      return `/**
 * ${pascal} model test.
 *
 * A construction smoke test: it proves the class is importable and carries the
 * declared fields. Add a FileDataSource or live-database test when the model
 * gains persistence behavior.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installFrameworkSymbols } from 'jsails/symbols';

await installFrameworkSymbols(process.cwd());
const { ${pascal} } = await import('../../models/${kebab}.js');

test('${pascal} carries its declared fields', () => {
  const record = new ${pascal}();
  record.name = 'example';
  assert.equal(record.name, 'example');
});
`;
    case 'command':
      return `/**
 * ${pascal} command test.
 *
 * Runs the command through the same adapter the CLI uses and asserts its
 * output. No process, terminal, or config file is involved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import ${pascal}Command from '../../commands/${kebab}.js';

test('${kebab} command runs and writes its summary', async () => {
  const output: string[] = [];
  const code = await ${pascal}Command.toCliCommand().run([], {
    configPath: 'jsails.app.js',
    cwd: process.cwd(),
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(output, ['${kebab} command']);
});
`;
    case 'server-component':
      return `/**
 * ${pascal} server-component test.
 *
 * Drives the real server-component runtime through \`jsails/testing\`: render,
 * one writable edit, and the \`save\` action. No Hono app or browser is involved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createComponentTestHarness } from 'jsails/testing';

import { ${camel} } from '../../components/${mfc ? `${kebab}/${kebab}` : kebab}.js';

test('${kebab} renders and saves a title', async (t) => {
  const harness = createComponentTestHarness({
    components: { '${kebab}': ${camel} },
    lifecycle: t,
  });
  const rendered = await harness.render('${kebab}');
  assert.match(rendered.html, /0 saved/);

  const result = await harness.update(
    rendered.snapshot,
    { title: 'First' },
    { csrf: rendered.csrf, action: { name: 'save' } },
  );
  assert.equal(result.status, 200);
  assert.match(result.html ?? '', /1 saved/);
});
`;
    case 'serializer':
      return `/**
 * ${pascal} serializer test.
 *
 * Exercises the read and write directions without a route or database.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ${camel}Serializer } from '../../serializers/${kebab}.js';

test('${camel} serializer reads a valid record', () => {
  assert.deepEqual(${camel}Serializer.toRepresentation({ name: 'Ada' }), { name: 'Ada' });
});

test('${camel} serializer rejects an empty name', () => {
  assert.throws(() => ${camel}Serializer.validate({ name: '' }));
});
`;
    case 'middleware':
      return `/**
 * ${pascal} middleware test.
 *
 * A contract smoke test: the module must export a middleware function. Add a
 * request-chain test when the middleware gains behavior worth asserting.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ${camel} } from '../../middleware/${kebab}.js';

test('${kebab} exports a middleware function', () => {
  assert.equal(typeof ${camel}, 'function');
});
`;
    case 'content':
      return undefined;
  }
}

/** Resolve the companion test path for a generated artifact. */
export function testPathFor(type: MakeCommandType, kebab: string): string | undefined {
  const dir = GENERATOR_TEST_DIRS[type];
  return dir === undefined ? undefined : `${dir}/${kebab}.test.ts`;
}
