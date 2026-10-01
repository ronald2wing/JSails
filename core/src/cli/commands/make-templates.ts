/**
 * Source templates for the `make:*` generators: one function per generator
 * type, each returning the body of the single file it writes. The templates
 * follow the starter's own conventions (imports through `app/*` shims and
 * `ui/layout.js`), so generated files compile against a fresh scaffold.
 *
 * The generator types that have a `.jsails` kind (a page, a live server
 * component) also have a `.jsails` template, which `make --mfc` splits into
 * a component folder exactly as `jsails convert` would.
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

export function load(context: RequestContext): ${pascal}PageProps {
  return { assets: loadLayout(context), path: context.url.pathname };
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
 * path, asset URLs). Every API module states its access: this one's
 * \`authorize\` admits only a request with a session (an anonymous one is
 * answered 401). Export \`access = publicAccess('why')\` from \`jsails/api\`
 * instead to make it public.
 */

import type { RequestContext } from 'jsails';

export function authorize(context: RequestContext): boolean {
  return context.session !== null;
}

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
  const kebab = kebabCase(name);
  return `/**
 * \`jsails ${kebab}\`: its name is its path under \`commands/\`.
 *
 * \`defineCommand\` declares the options and arguments; \`jsails ${kebab} --help\`
 * prints the help generated from them, and an unknown flag is a usage error.
 * \`run\` reads them from \`context.values\` and \`context.positionals\` and
 * writes through \`context.stdout\`/\`context.stderr\`; nothing returned is exit
 * code 0.
 */

import { defineCommand } from '../app/application-command.js';

export default defineCommand({
  summary: '${kebab} command',
  run(context) {
    context.stdout('${kebab} command');
  },
});
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
 * \`defineComponent\` surface. The build registers it under its id, its path
 * under \`components/\` (\`${kebab}\`), which its \`name\` must equal; render it
 * from a page's \`load\` with \`renderServerComponent('${kebab}', context)\`.
 *
 * State is integrity-protected (not encrypted) and carried in a signed snapshot;
 * never place credentials in component state. Add \`writableKeys\` and an
 * \`authorize\` callback before serving. \`actions\` are split by capability: a
 * \`serverAction\` round-trips through the snapshot (same-origin check,
 * authorize, and schema validation), while a \`localAction\` would be pure and client-runnable.
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

/** The middleware template: a functional route middleware. */
function middlewareTemplate(name: string): string {
  const camel = camelCase(name);
  return `/**
 * ${pascalCase(name)} middleware.
 *
 * A route middleware, run after the route's access gate and before its page
 * or API handler. Import it into a route module and list it in that module's
 * exported \`middleware\` array (or in \`defineApi\`'s \`middleware\`). It
 * runs only for the routes that list it. It receives the
 * route's request context (\`context.session\`, \`context.url\`,
 * \`context.params\`, \`context.request.headers\`) and \`next\`, which runs the
 * rest of the chain once and resolves to its \`Response\`. Return that
 * response (or a new one built from it, to add a header), or return your own
 * \`Response\` without calling \`next()\` to answer in the route's place.
 */
import type { RouteMiddleware } from 'jsails';

export const ${camel}: RouteMiddleware = async (context, next) => {
  // Read \`context.session\` or \`context.request.headers\`, then forward or reply.
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
/** The generator types that write a `.jsails` component with `--mfc`. */
export type SfcMakeType = 'page' | 'server-component';

/** Whether a generator type has a `.jsails` template. */
export function isSfcMakeType(type: MakeCommandType): type is SfcMakeType {
  return type === 'page' || type === 'server-component';
}

/** The `.jsails` page template: a `load` in `<script>` and a template that reads its result. */
function sfcPageTemplate(name: string): string {
  const title = titleCase(name);
  return `<script lang="ts">
/** ${title} page: \`load\` gives the template its props. */
import type { RequestContext } from 'jsails';

export function load(context: RequestContext): { path: string } {
  return { path: context.url.pathname };
}
</script>

<template>
  <main>
    <h1>${title}</h1>
    <p>You are at {{ path }}.</p>
  </main>
</template>
`;
}

/**
 * The `.jsails` live component template: `defineLive` with a state schema,
 * a writable field and one server action, a template whose free names are
 * the state's fields, and the static form a static export renders.
 */
function sfcLiveTemplate(name: string): string {
  const pascal = pascalCase(name);
  return `<script lang="ts">
/**
 * ${pascal} live component: signed server state, one action, and the static
 * form a static export renders. State is integrity-protected, not encrypted;
 * never place credentials in it.
 */
import { z } from 'zod';

import { serverAction } from 'jsails/server-components';

defineLive({
  stateSchema: z
    .object({
      title: z.string().max(120),
      saved: z.array(z.string().max(120)).max(50),
    })
    .strict(),
  initialState: () => ({ title: '', saved: [] }),
  writableKeys: ['title'],
  authorize: () => true, // public; default-deny requires exactly true
  actions: {
    save: serverAction({
      input: z.object({}),
      run(state) {
        const title = state.title.trim();
        if (title === '') return;
        state.saved.push(title);
        state.title = '';
      },
    }),
  },
  derived: { count: (state) => state.saved.length },
});
</script>

<template>
  <div>
    <form @submit="save">
      <input type="text" :maxlength="120" js-model="title" />
      <button type="submit">Save</button>
    </form>
    <p>{{ count }} saved</p>
  </div>
</template>

<template static>
  <p>The ${kebabCase(name)} component works when the site is served.</p>
</template>
`;
}

/** The single-file `.jsails` text of a generator type that has one. */
export function renderSfcTemplate(type: SfcMakeType, name: string): string {
  return type === 'page' ? sfcPageTemplate(name) : sfcLiveTemplate(name);
}

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
