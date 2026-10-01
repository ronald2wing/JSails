/**
 * Source templates for the `make:*` generators: one function per generator
 * type, each returning the body of the single file it writes. The templates
 * follow the starter's own conventions (imports through `app/*` shims and
 * `ui/layout.js`), so generated files compile against a fresh scaffold.
 */

import {
  camelCase,
  kebabCase,
  pascalCase,
  snakeCase,
  titleCase,
  type MakeCommandType,
} from '../../compiler/conventions.js';

/** Today's local date as `YYYY-MM-DD` — the content layer's `date` field format. */
function todayIsoDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** The page template: a plain page through the shared document shell. */
function pageTemplate(name: string): string {
  const pascal = pascalCase(name);
  const title = titleCase(name);
  return `/**
 * ${title} page.
 *
 * A plain page rendered through the shared document shell. It has no island and
 * no server action; async props belong in \`load\`. Navigation is owned by the
 * browser client, so links stay ordinary \`<a href>\` elements.
 */

import type { RequestContext } from 'jsails';

import { UiLayout, loadLayout, type LayoutAssets } from '../ui/layout.js';

export interface ${pascal}PageProps {
  /** Resolved asset URLs, produced in \`load\` and forwarded to the layout. */
  assets?: LayoutAssets;
  /** The current request path, used to mark the active nav link. */
  path?: string;
}

export async function load(context: RequestContext): Promise<${pascal}PageProps> {
  return { assets: await loadLayout(context), path: context.url.pathname };
}

export default function ${pascal}Page({ assets, path }: ${pascal}PageProps) {
  return (
    <UiLayout title="${title} — JSails Starter" assets={assets} path={path}>
      <header class="text-center">
        <h1 class="text-4xl font-bold tracking-tight">${title}</h1>
      </header>
    </UiLayout>
  );
}
`;
}

/** The API route template: a read-only GET endpoint. */
function apiTemplate(name: string): string {
  const kebab = kebabCase(name);
  return `/**
 * ${kebab} API route.
 *
 * A read-only \`${kebab}\` endpoint mounted at \`/api/${kebab}\`. Handlers
 * receive the Hono \`Request\` plus a \`RequestContext\` (session, storage
 * path, asset URLs). Filesystem API routes run through the global default-deny
 * \`authorize\`, so add one in \`jsails.app.js\` to make this reachable.
 */

import type { RequestContext } from 'jsails';

export function GET(_request: Request, _context: RequestContext): Response {
  return Response.json({ ok: true });
}
`;
}

/** The job template: a Zod-validated job definition. */
function jobTemplate(name: string): string {
  const camel = camelCase(name);
  const kebab = kebabCase(name);
  return `/**
 * ${pascalCase(name)} job.
 *
 * The default export is the job class. The explicit static jobName is the
 * queue contract and must match \`jsails.schedules.json\`. The class extends
 * \`ApplicationJob\`, so \`this.log\`, \`this.updateProgress\`, attempt info, and
 * nested dispatch are available. The Zod schema validates the payload on both
 * dispatch and the worker.
 */

import { z } from 'zod';

const schema = z.object({});

export default class ${pascalCase(name)}Job extends ApplicationJob<z.infer<typeof schema>> {
  static readonly jobName = '${camel}';
  static readonly schema = schema;

  async handle(_data: z.infer<typeof schema>): Promise<void> {
    // Define the work here; \`${kebab}\` has passed the schema above.
  }
}
`;
}

/** The model template: a JSails model that declares only its shape. */
function modelTemplate(name: string): string {
  const pascal = pascalCase(name);
  const table = snakeCase(pascal);
  return `/**
 * ${pascal} model.
 *
 * A JSails model declares only the shape of its data; the compiler derives the
 * table (\`${table}\`), columns, foreign keys, and migrations from the class. No
 * TypeORM import, no decorators, no subscriber wiring — add a field and run
 * \`jsails db:push\` to create the table.
 *
 * Customize a field with an inline \`@jsails.*\` decorator when inference cannot
 * know the intent, e.g. \`@jsails.maxLength(200)\`, \`@jsails.unique()\`,
 * \`@jsails.nullable()\`, \`@jsails.encrypts()\`, or a relation behavior such as
 * \`@jsails.belongsTo(Author, { touch: true })\`.
 */

export class ${pascal} extends ApplicationRecord {
  declare name: string;
}
`;
}

/** The command template: a Laravel-Zero-style CLI command. */
function commandTemplate(name: string): string {
  const pascal = pascalCase(name);
  const kebab = kebabCase(name);
  return `/**
 * \`jsails ${kebab}\` command.
 *
 * A class-based command. Arguments and options are declared in the static
 * signature; \`handle\` reads them through \`this.argument\`/\`this.option\`
 * and writes through \`this.stdout\`/\`this.stderr\`.
 */

import { Command } from '../app/application-command.js';

export default class ${pascal}Command extends Command {
  static readonly signature = '${kebab}';
  static readonly summary = '${kebab} command';
  static readonly audience = 'user' as const;

  async handle(): Promise<number> {
    this.stdout('${kebab} command');
    return 0;
  }
}
`;
}

/** The server-component template: a minimal stateful component. */
function serverComponentTemplate(name: string): string {
  const pascal = pascalCase(name);
  const kebab = kebabCase(name);
  return `/**
 * ${pascal} server component.
 *
 * A stateful, signed server component authored with the friendly
 * \`defineComponent\` surface. Register it in \`jsails.app.js\` through the
 * \`serverComponentsPlugin\` extension and render it from a page's \`load\` with
 * \`renderServerComponent('${kebab}', context)\`.
 *
 * State is integrity-protected (not encrypted) and carried in a signed snapshot;
 * never place credentials in component state. Add \`writableKeys\` and an
 * \`authorize\` callback before serving. \`actions\` are split by capability: a
 * \`serverAction\` round-trips through the snapshot (authorize + CSRF + schema
 * validation), while a \`localAction\` would be pure and client-runnable.
 */
import { z } from 'zod';

import { defineComponent, serverAction } from 'jsails/server-components';

const stateSchema = z
  .object({
    title: z.string().max(120),
    saved: z.array(z.string().max(120)).max(50),
  })
  .strict();

type ${pascal}State = z.infer<typeof stateSchema>;

export const ${camelCase(name)} = defineComponent<${pascal}State>({
  name: '${kebab}',
  stateSchema,
  writableKeys: ['title'],
  initialState() {
    return { title: '', saved: [] };
  },
  authorize() {
    return true;
  },
  actions: {
    save: serverAction({
      input: z.object({}),
      run(state) {
        const title = state.title.trim();
        if (title === '') {
          return;
        }
        state.saved.push(title);
        state.title = '';
      },
    }),
  },
  derived: {
    count: (state) => state.saved.length,
  },
  render(state, { bind, submit, derived }) {
    const count = derived('count') as number;
    return (
      <div>
        <form {...submit('save')}>
          <input type="text" maxLength={120} {...bind('title')} />
          <button type="submit">Save</button>
        </form>
        <p>Current value: {state.title}</p>
        <p>{count} saved</p>
      </div>
    );
  },
  staticFallback() {
    return <p>The ${kebab} component is not available in the static export.</p>;
  },
});
`;
}

/** The serializer template: a field map for API resource serialization. */
function serializerTemplate(name: string): string {
  const camel = camelCase(name);
  const pascal = pascalCase(name);
  return `/**
 * ${pascal} serializer.
 *
 * A typed field map consumed by \`createResourceHandlers\` (or any call-site
 * that needs a uniform JSON shape). Import it from \`jsails/api\` and pass it
 * to a resource or a manual \`toRepresentation\` / \`validate\` call.
 *
 * Fields declared as bare schemas are read+write; wrap in
 * \`{ schema, readOnly?, writeOnly? }\` to restrict direction.
 */
import { defineSerializer, string } from 'jsails/api';

export const ${camel}Serializer = defineSerializer({
  name: string({ min: 1 }),
});
`;
}

/** The middleware template: a Hono request-chain handler. */
function middlewareTemplate(name: string): string {
  const camel = camelCase(name);
  return `/**
 * ${pascalCase(name)} middleware.
 *
 * A per-route middleware handler applied before the terminal page or API
 * handler. Register it in \`jsails.app.js\` under \`middleware\` (keyed by
 * name), then reference it by name in a route module's exported \`middleware\`
 * array (or list it in \`globalMiddleware\`). The handler receives a Hono
 * \`Context\` typed to the JSails app env and a \`next\` continuation; call
 * \`next()\` to proceed down the chain (or short-circuit by returning a
 * \`Response\`). Read per-request values set by the pipeline via \`c.var\`.
 */
import type { RouteMiddleware } from 'jsails';

export const ${camel}: RouteMiddleware = async (c, next) => {
  // Inspect \`c.req\`/\`c.var.session\`, then forward or reply.
  return next();
};
`;
}

/**
 * The content template: a markdown entry with YAML frontmatter. The title is
 * derived from the name and the date is today, so a freshly generated entry is
 * immediately discoverable by the content layer (which requires `title` and
 * accepts `tags`/`date`).
 */
function contentTemplate(name: string): string {
  const title = titleCase(name);
  return `---
title: ${title}
date: ${todayIsoDate()}
tags: []
---

Start writing here.
`;
}

/** Build the generated file body for a type and name. */
export function renderTemplate(type: MakeCommandType, name: string): string {
  switch (type) {
    case 'page':
      return pageTemplate(name);
    case 'api':
      return apiTemplate(name);
    case 'job':
      return jobTemplate(name);
    case 'model':
      return modelTemplate(name);
    case 'command':
      return commandTemplate(name);
    case 'server-component':
      return serverComponentTemplate(name);
    case 'serializer':
      return serializerTemplate(name);
    case 'middleware':
      return middlewareTemplate(name);
    case 'content':
      return contentTemplate(name);
  }
}
