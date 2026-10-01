/**
 * The conformance fixture: a server built only from `defineMcp*` definitions
 * that implements the surface the official conformance suite's server
 * scenarios call (`test_simple_text`, `test://static-text`,
 * `test_prompt_with_arguments`, and the rest), served over Streamable HTTP by
 * the package's own endpoint on a loopback port.
 *
 * Scenarios for features the package deliberately does not ship (logging,
 * sampling, subscriptions, sessions) get no stand-in here: the expected
 * failures ledger records each one with its reason. A `broken` variant
 * disables one protection on purpose, so the harness can prove a regression
 * fails the run.
 */

import { z } from 'zod';

import { publicAccess } from '../../src/access.js';
import type { McpCallContext } from '../../src/call-context.js';
import {
  defineMcpPrompt,
  defineMcpResource,
  defineMcpResourceTemplate,
  defineMcpServer,
  defineMcpTool,
  type McpServerDefinition,
} from '../../src/definitions.js';
import { McpToolFailure } from '../../src/errors.js';
import { createMcpHttpEndpoint } from '../../src/http-endpoint.js';
import { inputRequired, type McpInputRequired } from '../../src/input-required.js';
import type { McpSchema } from '../../src/schema-projection.js';
import { toolResult } from '../../src/content.js';
import { listen, type Listener } from '../http-harness.js';

const open = publicAccess('conformance fixture: every scenario item is public');

/** A 1x1 red PNG. */
export const RED_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

/** A 16-bit mono PCM WAV holding one silent sample. */
export const SILENT_WAV = ((): string => {
  const header = Buffer.alloc(46);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(38, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(2, 40);
  return header.toString('base64');
})();

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const contactForm = z.object({
  username: z.string().meta({ description: "User's response" }),
  email: z.string().meta({ description: "User's email address" }),
});

const defaultsForm = z.object({
  name: z.string().default('John Doe'),
  age: z.number().int().default(30),
  score: z.number().default(95.5),
  status: z.enum(['active', 'inactive', 'pending']).default('active'),
  verified: z.boolean().default(true),
});

const enumsForm = z.object({
  untitledSingle: z.enum(['option1', 'option2', 'option3']),
  titledSingle: z.string().meta({
    oneOf: [
      { const: 'value1', title: 'First Option' },
      { const: 'value2', title: 'Second Option' },
      { const: 'value3', title: 'Third Option' },
    ],
  }),
  legacyEnum: z
    .enum(['opt1', 'opt2', 'opt3'])
    .meta({ enumNames: ['Option One', 'Option Two', 'Option Three'] }),
  untitledMulti: z.array(z.enum(['option1', 'option2', 'option3'])),
  titledMulti: z.array(z.string()).meta({
    items: {
      anyOf: [
        { const: 'value1', title: 'First Choice' },
        { const: 'value2', title: 'Second Choice' },
        { const: 'value3', title: 'Third Choice' },
      ],
    },
  }),
});

const address = z.object({ street: z.string(), city: z.string() }).meta({ id: 'address' });

/** Ask for `form` once; on the next round, report the answer as text. */
async function askOnce(
  ctx: McpCallContext,
  form: McpSchema,
  message: string,
): Promise<string | McpInputRequired> {
  const answer = await ctx.answer('form');
  if (answer === undefined) {
    return inputRequired({ requests: { form: { mode: 'form', message, schema: form } } });
  }
  const content = answer.action === 'accept' ? answer.content : {};
  return `Elicitation completed: action=${answer.action}, content=${JSON.stringify(content)}`;
}

/** The fixture server definition. */
export function conformanceServer(): McpServerDefinition {
  return defineMcpServer({
    name: 'jsails-conformance-fixture',
    version: '1.0.0',
    instructions: 'The JSails conformance fixture.',
    tools: [
      defineMcpTool({
        name: 'test_simple_text',
        description: 'Return a simple text response.',
        access: open,
        handler: () => 'This is a simple text response for testing.',
      }),
      defineMcpTool({
        name: 'test_image_content',
        description: 'Return a PNG image.',
        access: open,
        handler: () =>
          toolResult.content([{ type: 'image', data: RED_PIXEL_PNG, mimeType: 'image/png' }]),
      }),
      defineMcpTool({
        name: 'test_audio_content',
        description: 'Return a WAV recording.',
        access: open,
        handler: () =>
          toolResult.content([{ type: 'audio', data: SILENT_WAV, mimeType: 'audio/wav' }]),
      }),
      defineMcpTool({
        name: 'test_embedded_resource',
        description: 'Return an embedded text resource.',
        access: open,
        handler: () =>
          toolResult.content([
            {
              type: 'resource',
              resource: {
                uri: 'test://embedded-resource',
                mimeType: 'text/plain',
                text: 'This is an embedded resource content.',
              },
            },
          ]),
      }),
      defineMcpTool({
        name: 'test_multiple_content_types',
        description: 'Return text, an image, and an embedded resource.',
        access: open,
        handler: () =>
          toolResult.content([
            { type: 'text', text: 'Multiple content types test:' },
            { type: 'image', data: RED_PIXEL_PNG, mimeType: 'image/png' },
            {
              type: 'resource',
              resource: {
                uri: 'test://mixed-content-resource',
                mimeType: 'application/json',
                text: '{"test":"data","value":123}',
              },
            },
          ]),
      }),
      defineMcpTool({
        name: 'test_error_handling',
        description: 'Always fail.',
        access: open,
        handler: () => {
          throw new McpToolFailure(
            'intentional',
            'This tool intentionally returns an error for testing',
          );
        },
      }),
      defineMcpTool({
        name: 'test_tool_with_progress',
        description: 'Report progress at 0, 50, and 100 of 100.',
        access: open,
        handler: async (_input, ctx) => {
          ctx.progress(0, 100);
          await delay(50, ctx.signal);
          ctx.progress(50, 100);
          await delay(50, ctx.signal);
          ctx.progress(100, 100);
          return 'Progress reported.';
        },
      }),
      defineMcpTool({
        name: 'test_elicitation',
        description: 'Ask the user for a username and an email address.',
        input: z.object({ message: z.string() }),
        access: open,
        handler: ({ message }, ctx) => askOnce(ctx, contactForm, message),
      }),
      defineMcpTool({
        name: 'test_elicitation_sep1034_defaults',
        description: 'Ask with a default for every primitive field type.',
        access: open,
        handler: (_input, ctx) => askOnce(ctx, defaultsForm, 'Confirm or change the defaults.'),
      }),
      defineMcpTool({
        name: 'test_elicitation_sep1330_enums',
        description: 'Ask with every enum field variant.',
        access: open,
        handler: (_input, ctx) => askOnce(ctx, enumsForm, 'Pick the options.'),
      }),
      defineMcpTool({
        name: 'json_schema_2020_12_tool',
        description: 'Tool with JSON Schema 2020-12 features',
        input: z.strictObject({ name: z.string().optional(), address: address.optional() }),
        access: open,
        handler: ({ name }) => `hello ${name ?? 'anonymous'}`,
      }),
    ],
    resources: [
      defineMcpResource({
        uri: 'test://static-text',
        name: 'static-text',
        description: 'A static text resource.',
        mimeType: 'text/plain',
        access: open,
        read: () => [{ text: 'This is the content of the static text resource.' }],
      }),
      defineMcpResource({
        uri: 'test://static-binary',
        name: 'static-binary',
        description: 'A static PNG resource.',
        mimeType: 'image/png',
        access: open,
        read: () => [{ blob: RED_PIXEL_PNG }],
      }),
      defineMcpResourceTemplate({
        uriTemplate: 'test://template/{id}/data',
        name: 'template-data',
        description: 'Data for one id.',
        mimeType: 'application/json',
        params: z.object({ id: z.string() }),
        access: open,
        read: ({ id }) => [
          { text: JSON.stringify({ id, templateTest: true, data: `Data for ID: ${id}` }) },
        ],
      }),
    ],
    prompts: [
      defineMcpPrompt({
        name: 'test_simple_prompt',
        description: 'A prompt without arguments.',
        access: open,
        render: () => [
          { role: 'user', content: { type: 'text', text: 'This is a simple prompt for testing.' } },
        ],
      }),
      defineMcpPrompt({
        name: 'test_prompt_with_arguments',
        description: 'A prompt with two arguments.',
        args: z.object({ arg1: z.string(), arg2: z.string() }),
        complete: {
          arg1: (prefix) => ['paris', 'park', 'party'].filter((word) => word.startsWith(prefix)),
        },
        access: open,
        render: ({ arg1, arg2 }) => [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Prompt with arguments: arg1='${arg1}', arg2='${arg2}'`,
            },
          },
        ],
      }),
      defineMcpPrompt({
        name: 'test_prompt_with_embedded_resource',
        description: 'A prompt embedding the named resource.',
        args: z.object({ resourceUri: z.string() }),
        access: open,
        render: ({ resourceUri }) => [
          {
            role: 'user',
            content: {
              type: 'resource',
              resource: {
                uri: resourceUri,
                mimeType: 'text/plain',
                text: 'Embedded resource content for testing.',
              },
            },
          },
          {
            role: 'user',
            content: { type: 'text', text: 'Please process the embedded resource above.' },
          },
        ],
      }),
      defineMcpPrompt({
        name: 'test_prompt_with_image',
        description: 'A prompt with an image.',
        access: open,
        render: () => [
          {
            role: 'user',
            content: { type: 'image', data: RED_PIXEL_PNG, mimeType: 'image/png' },
          },
          { role: 'user', content: { type: 'text', text: 'Please analyze the image above.' } },
        ],
      }),
    ],
  });
}

/** A protection the broken fixture disables. */
export type FixtureBreak = 'dns-rebinding';

/** A listening fixture endpoint. */
export interface FixtureListener extends Listener {
  readonly reports: readonly string[];
}

/**
 * Serve the fixture over Streamable HTTP on a loopback port. With `broken`,
 * one protection is disabled so the suite has something to catch.
 */
export async function serveFixture(broken?: FixtureBreak): Promise<FixtureListener> {
  const reports: string[] = [];
  let endpoint: ReturnType<typeof createMcpHttpEndpoint> | undefined;
  const listener = await listen((request) => {
    if (endpoint === undefined) {
      return new Response(null, { status: 503 });
    }
    return endpoint.handle(request);
  });
  const host = new URL(listener.origin).hostname;
  const hosts = broken === 'dns-rebinding' ? [host, 'evil.example.com'] : [host];
  endpoint = createMcpHttpEndpoint(conformanceServer(), {
    resource: listener.url,
    authenticate: () => ({ kind: 'anonymous' }),
    allowedHosts: hosts,
    allowedOrigins: hosts,
    onError: (error) => {
      reports.push(error.code);
    },
  });
  const served = endpoint;
  return {
    ...listener,
    reports,
    close: async () => {
      await served.close();
      await listener.close();
    },
  };
}
