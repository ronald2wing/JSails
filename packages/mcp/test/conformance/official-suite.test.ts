/**
 * The official MCP conformance suite against this package, and the harness
 * itself.
 *
 * Always run: the ledger's own rules (every entry names a scenario of the
 * pinned suite, carries a reason, appears once, and stays under the ceiling
 * below, so the ledger can only shrink), and the fixture checked in process
 * over both eras, so a broken fixture shows up without the network.
 *
 * Run with `JSAILS_MCP_CONFORMANCE=1` (it fetches the pinned suite with
 * `npx --yes`): the server suite against the fixture endpoint, the client
 * suite against `connectMcp` through the wrapper, both judged by the suite's
 * own baseline logic against the ledger (an unlisted failure fails, and so
 * does a listed scenario that passes); a fixture with DNS rebinding
 * protection disabled must fail the run, and a stale ledger entry must too.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { connectInMemory } from '../../src/in-memory.js';
import type { McpElicitation, McpRemoteServer } from '../../src/remote-client.js';
import {
  CONFORMANCE_SUITE,
  EXPECTED_FAILURES,
  SUITE_SCENARIOS,
  type ExpectedFailure,
} from './expected-failures.js';
import { conformanceServer, RED_PIXEL_PNG, serveFixture, SILENT_WAV } from './fixture-server.js';

/**
 * Every entry the ledger may hold. Fixing a scenario means deleting its entry
 * from the ledger and from this list; nothing is ever added here.
 */
const LEDGER_CEILING: ReadonlySet<string> = new Set([
  'server:elicitation-sep1034-defaults',
  'server:elicitation-sep1330-enums',
  'server:logging-set-level',
  'server:resources-subscribe',
  'server:resources-unsubscribe',
  'server:server-sse-multiple-streams',
  'server:server-sse-polling',
  'server:tools-call-elicitation',
  'server:tools-call-sampling',
  'server:tools-call-with-logging',
  'client:auth/2025-03-26-oauth-endpoint-fallback',
  'client:auth/2025-03-26-oauth-metadata-backcompat',
  'client:auth/basic-cimd',
  'client:auth/client-credentials-basic',
  'client:auth/client-credentials-jwt',
  'client:auth/cross-app-access-complete-flow',
  'client:auth/metadata-default',
  'client:auth/metadata-var1',
  'client:auth/metadata-var2',
  'client:auth/metadata-var3',
  'client:auth/offline-access-not-supported',
  'client:auth/offline-access-scope',
  'client:auth/pre-registration',
  'client:auth/scope-from-scopes-supported',
  'client:auth/scope-from-www-authenticate',
  'client:auth/scope-omitted-when-undefined',
  'client:auth/scope-retry-limit',
  'client:auth/scope-step-up',
  'client:auth/token-endpoint-auth-basic',
  'client:auth/token-endpoint-auth-none',
  'client:auth/token-endpoint-auth-post',
]);

const GATED = process.env.JSAILS_MCP_CONFORMANCE !== '1';
const SKIP_REASON = 'set JSAILS_MCP_CONFORMANCE=1 to run the official suite (fetched with npx)';
const SUITE_TIMEOUT_MS = 600_000;
const CLIENT_WRAPPER = fileURLToPath(new URL('./fixture-client.js', import.meta.url));

/** The form answers the fixture test gives, by the question asked; any other form is accepted empty. */
const ANSWERS: Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>> = {
  'Who are you?': { username: 'ada', email: 'ada@example.com' },
  'Pick the options.': {
    untitledSingle: 'option1',
    titledSingle: 'value1',
    legacyEnum: 'opt1',
    untitledMulti: ['option1', 'option2'],
    titledMulti: ['value1', 'value2'],
  },
};

function keyOf(entry: ExpectedFailure): string {
  return `${entry.mode}:${entry.scenario}`;
}

function textOf(content: readonly { readonly type: string }[]): string {
  return content
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

/** The suite's baseline file for `entries`, in the YAML shape its CLI reads. */
function baseline(entries: readonly ExpectedFailure[]): string {
  const section = (mode: ExpectedFailure['mode']): string => {
    const names = entries.filter((entry) => entry.mode === mode).map((entry) => entry.scenario);
    return names.length === 0
      ? `${mode}: []\n`
      : `${mode}:\n${names.map((name) => `  - ${JSON.stringify(name)}\n`).join('')}`;
  };
  return section('server') + section('client');
}

interface SuiteRun {
  readonly code: number | null;
  readonly output: string;
}

/** Run the pinned suite's CLI with `args`, judged against `entries`, in a scratch directory. */
async function runSuite(
  args: readonly string[],
  entries: readonly ExpectedFailure[],
): Promise<SuiteRun> {
  const scratch = await mkdtemp(join(tmpdir(), 'jsails-mcp-conformance-'));
  try {
    const ledger = join(scratch, 'expected-failures.yml');
    await writeFile(ledger, baseline(entries));
    return await new Promise<SuiteRun>((resolve, reject) => {
      const child = spawn(
        process.platform === 'win32' ? 'npx.cmd' : 'npx',
        [
          '--yes',
          CONFORMANCE_SUITE,
          ...args,
          '--expected-failures',
          ledger,
          '--output-dir',
          join(scratch, 'results'),
        ],
        { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output }));
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

describe('conformance ledger', () => {
  it('names only scenarios of the pinned suite, each once, with a reason', () => {
    const seen = new Set<string>();
    for (const entry of EXPECTED_FAILURES) {
      assert.ok(
        SUITE_SCENARIOS[entry.mode].includes(entry.scenario),
        `${keyOf(entry)} is not a scenario of ${CONFORMANCE_SUITE}`,
      );
      assert.ok(entry.reason.trim().length > 0, `${keyOf(entry)} has no reason`);
      assert.ok(!seen.has(keyOf(entry)), `${keyOf(entry)} is listed twice`);
      seen.add(keyOf(entry));
    }
  });

  it('only shrinks: every entry is under the ceiling', () => {
    for (const entry of EXPECTED_FAILURES) {
      assert.ok(
        LEDGER_CEILING.has(keyOf(entry)),
        `${keyOf(entry)} is a new expected failure; fix the regression instead`,
      );
    }
  });

  it('writes the suite baseline the CLI reads', () => {
    assert.equal(
      baseline([
        { mode: 'server', scenario: 'ping', reason: 'r' },
        { mode: 'server', scenario: 'tools-list', reason: 'r' },
      ]),
      'server:\n  - "ping"\n  - "tools-list"\nclient: []\n',
    );
  });
});

describe('conformance fixture (in process)', () => {
  for (const protocol of ['modern', 'legacy'] as const) {
    describe(protocol, () => {
      let remote: McpRemoteServer;
      const asked: McpElicitation[] = [];
      const reports: string[] = [];

      before(async () => {
        remote = await connectInMemory(conformanceServer(), {
          protocol,
          serving: { onError: (error) => reports.push(error.code) },
          elicit: (request) => {
            asked.push(request);
            return { action: 'accept', content: ANSWERS[request.message] ?? {} };
          },
        });
      });

      after(async () => {
        await remote.close();
        assert.deepEqual(reports, []);
      });

      it('lists every item the server scenarios call', async () => {
        const tools = (await remote.listTools()).map((tool) => tool.name);
        for (const name of [
          'test_simple_text',
          'test_image_content',
          'test_audio_content',
          'test_embedded_resource',
          'test_multiple_content_types',
          'test_error_handling',
          'test_tool_with_progress',
          'test_elicitation',
          'test_elicitation_sep1034_defaults',
          'test_elicitation_sep1330_enums',
          'json_schema_2020_12_tool',
        ]) {
          assert.ok(tools.includes(name), name);
        }
        assert.deepEqual(
          (await remote.listResources()).map((resource) => resource.uri),
          ['test://static-binary', 'test://static-text'],
        );
        assert.deepEqual(
          (await remote.listResourceTemplates()).map((template) => template.uriTemplate),
          ['test://template/{id}/data'],
        );
        const prompts = await remote.listPrompts();
        assert.deepEqual(
          prompts.map((prompt) => prompt.name),
          [
            'test_prompt_with_arguments',
            'test_prompt_with_embedded_resource',
            'test_prompt_with_image',
            'test_simple_prompt',
          ],
        );
        assert.ok(prompts.every((prompt) => (prompt.description ?? '').length > 0));
      });

      it('answers each content scenario', async () => {
        const simple = await remote.callTool('test_simple_text', {});
        assert.equal(simple.status, 'ok');
        assert.equal(
          simple.status === 'ok' ? textOf(simple.content) : '',
          'This is a simple text response for testing.',
        );
        const image = await remote.callTool('test_image_content', {});
        assert.deepEqual(image.status === 'ok' ? image.content : undefined, [
          { type: 'image', data: RED_PIXEL_PNG, mimeType: 'image/png' },
        ]);
        const audio = await remote.callTool('test_audio_content', {});
        assert.deepEqual(audio.status === 'ok' ? audio.content : undefined, [
          { type: 'audio', data: SILENT_WAV, mimeType: 'audio/wav' },
        ]);
        const embedded = await remote.callTool('test_embedded_resource', {});
        assert.deepEqual(embedded.status === 'ok' ? embedded.content : undefined, [
          {
            type: 'resource',
            resource: {
              uri: 'test://embedded-resource',
              mimeType: 'text/plain',
              text: 'This is an embedded resource content.',
            },
          },
        ]);
        const mixed = await remote.callTool('test_multiple_content_types', {});
        assert.deepEqual(mixed.status === 'ok' ? mixed.content.map((block) => block.type) : [], [
          'text',
          'image',
          'resource',
        ]);
        const failed = await remote.callTool('test_error_handling', {});
        assert.equal(failed.status, 'tool_error');
        assert.match(
          failed.status === 'tool_error' ? textOf(failed.content) : '',
          /intentionally returns an error/,
        );
      });

      it('reports progress at 0, 50, and 100', async () => {
        const seen: number[] = [];
        const outcome = await remote.callTool(
          'test_tool_with_progress',
          {},
          { onProgress: (progress) => seen.push(progress) },
        );
        assert.equal(outcome.status, 'ok');
        assert.deepEqual(seen, [0, 50, 100]);
      });

      it('keeps the JSON Schema 2020-12 keywords of the schema tool', async () => {
        const tool = (await remote.listTools()).find(
          (item) => item.name === 'json_schema_2020_12_tool',
        );
        const schema = tool?.inputSchema ?? {};
        assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
        assert.equal(schema.additionalProperties, false);
        const defs = schema.$defs as Record<string, unknown> | undefined;
        assert.ok(defs !== undefined && 'address' in defs);
      });

      it('reads text, binary, and templated resources with their MIME types', async () => {
        assert.deepEqual(await remote.readResource('test://static-text'), [
          {
            uri: 'test://static-text',
            mimeType: 'text/plain',
            text: 'This is the content of the static text resource.',
          },
        ]);
        assert.deepEqual(await remote.readResource('test://static-binary'), [
          { uri: 'test://static-binary', mimeType: 'image/png', blob: RED_PIXEL_PNG },
        ]);
        const [templated] = await remote.readResource('test://template/123/data');
        assert.equal(templated?.mimeType, 'application/json');
        assert.ok(templated !== undefined && 'text' in templated && templated.text.includes('123'));
      });

      it('renders each prompt', async () => {
        const args = await remote.getPrompt('test_prompt_with_arguments', {
          arg1: 'hello',
          arg2: 'world',
        });
        assert.deepEqual(args, [
          {
            role: 'user',
            content: { type: 'text', text: "Prompt with arguments: arg1='hello', arg2='world'" },
          },
        ]);
        const embedded = await remote.getPrompt('test_prompt_with_embedded_resource', {
          resourceUri: 'test://example-resource',
        });
        assert.equal(embedded[0]?.content.type, 'resource');
        const image = await remote.getPrompt('test_prompt_with_image');
        assert.equal(image[0]?.content.type, 'image');
        assert.equal((await remote.getPrompt('test_simple_prompt')).length, 1);
      });

      it('asks each elicitation scenario form, and the client fills in the defaults', async () => {
        asked.length = 0;
        const contact = await remote.callTool('test_elicitation', { message: 'Who are you?' });
        assert.equal(
          contact.status === 'ok' ? textOf(contact.content) : contact.status,
          'Elicitation completed: action=accept, content={"username":"ada","email":"ada@example.com"}',
        );

        // Accepted with nothing filled in: every field is answered with its default.
        const defaults = await remote.callTool('test_elicitation_sep1034_defaults', {});
        assert.equal(
          defaults.status === 'ok' ? textOf(defaults.content) : defaults.status,
          'Elicitation completed: action=accept, content=' +
            '{"name":"John Doe","age":30,"score":95.5,"status":"active","verified":true}',
        );
        const defaultsForm = asked.find((request) => request.message.startsWith('Confirm'));
        const fields = (defaultsForm?.mode === 'form' ? defaultsForm.schema.properties : {}) as
          Record<string, { type?: string; default?: unknown }> | undefined;
        assert.deepEqual(
          Object.fromEntries(
            Object.entries(fields ?? {}).map(([name, field]) => [
              name,
              [field.type, field.default],
            ]),
          ),
          {
            name: ['string', 'John Doe'],
            age: ['integer', 30],
            score: ['number', 95.5],
            status: ['string', 'active'],
            verified: ['boolean', true],
          },
        );

        const enums = await remote.callTool('test_elicitation_sep1330_enums', {});
        assert.equal(enums.status, 'ok');
        assert.match(
          enums.status === 'ok' ? textOf(enums.content) : '',
          /"titledMulti":\["value1","value2"\]/,
        );
        const enumsForm = asked.find((request) => request.message === 'Pick the options.');
        const variants = (enumsForm?.mode === 'form' ? enumsForm.schema.properties : {}) as Record<
          string,
          Record<string, unknown>
        >;
        assert.deepEqual(variants.untitledSingle?.enum, ['option1', 'option2', 'option3']);
        assert.ok(Array.isArray(variants.titledSingle?.oneOf));
        assert.deepEqual(variants.legacyEnum?.enumNames, [
          'Option One',
          'Option Two',
          'Option Three',
        ]);
        assert.equal(variants.untitledMulti?.type, 'array');
        assert.ok(Array.isArray((variants.titledMulti?.items as { anyOf?: unknown })?.anyOf));
      });
    });
  }
});

describe('official conformance suite', { skip: GATED ? SKIP_REASON : false }, () => {
  it(
    'passes every server scenario outside the ledger, and fails every one in it',
    { timeout: SUITE_TIMEOUT_MS },
    async () => {
      const fixture = await serveFixture();
      try {
        const run = await runSuite(
          ['server', '--url', fixture.url, '--suite', 'all'],
          EXPECTED_FAILURES,
        );
        assert.equal(run.code, 0, run.output);
        assert.match(run.output, /Baseline check passed/);
      } finally {
        await fixture.close();
      }
    },
  );

  it(
    'passes every client scenario outside the ledger, and fails every one in it',
    { timeout: SUITE_TIMEOUT_MS },
    async () => {
      assert.ok(
        !/\s/.test(process.execPath + CLIENT_WRAPPER),
        'the suite splits --command on spaces',
      );
      const run = await runSuite(
        ['client', '--command', `${process.execPath} ${CLIENT_WRAPPER}`, '--suite', 'all'],
        EXPECTED_FAILURES,
      );
      assert.equal(run.code, 0, run.output);
      assert.match(run.output, /Baseline check passed/);
    },
  );

  it(
    'fails the run when the fixture loses its DNS rebinding protection',
    { timeout: SUITE_TIMEOUT_MS },
    async () => {
      const fixture = await serveFixture('dns-rebinding');
      try {
        const run = await runSuite(
          ['server', '--url', fixture.url, '--scenario', 'dns-rebinding-protection'],
          EXPECTED_FAILURES,
        );
        assert.equal(run.code, 1, run.output);
        assert.match(run.output, /Unexpected failures[\s\S]*dns-rebinding-protection/);
      } finally {
        await fixture.close();
      }
    },
  );

  it('fails the run on a stale ledger entry', { timeout: SUITE_TIMEOUT_MS }, async () => {
    const fixture = await serveFixture();
    try {
      const run = await runSuite(
        ['server', '--url', fixture.url, '--scenario', 'ping'],
        [...EXPECTED_FAILURES, { mode: 'server', scenario: 'ping', reason: 'stale on purpose' }],
      );
      assert.equal(run.code, 1, run.output);
      assert.match(run.output, /Stale baseline entries[\s\S]*ping/);
    } finally {
      await fixture.close();
    }
  });
});
