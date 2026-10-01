/**
 * The live corpus compiled and run as an app (sfc-plan SFC-05 exit): the
 * §2.7 task list round-trips `add` and `remove` through the component
 * transport (authorize, a signed snapshot, a 422 carrying `errors.title`); a
 * page that mounts it serves the signed root and exports `<template static>`;
 * a `staticRender: 'initial'` component exports its own render with inert
 * markup; a live component without a static form, or whose initial render
 * throws (an `authorize` that assumes a session), fails the export naming the
 * route, past the app's error boundary; and the hoist evaluates each
 * condition on a live tag's path once, in the template's order, mounting
 * nothing the template does not render.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { scopeMarker, sfcScopeId } from '../../../src/compiler/sfc/style.js';
import { PageRenderError } from '../../../src/pages/page.js';
import type { ServerComponentDefinition } from '../../../src/server-components/component.js';
import { serverComponentsPlugin } from '../../../src/server-components/extension.js';
import {
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  COMPONENT_UPDATE_ENDPOINT,
} from '../../../src/server-components/protocol.js';
import {
  ComponentAuthorizeErrors,
  ComponentStaticErrors,
} from '../../../src/server-components/runtime/index.js';
import { createTestApp, type TestApplication } from '../../../src/testing/app.js';
import type { LaneBody } from '../../server-components/lane-calls.js';
import { updateBody } from '../../server-components/lane-calls.js';
import {
  compileFixtureApp,
  type CompiledFixtureApp,
  type FixtureFile,
} from './compiled-fixture.js';
import { LIVE_APP, LIVE_RESOLVER } from './live-corpus.js';

const KEY = 'live-corpus-signing-key-0123456789abcdef';
const NAVIGATION: RequestInit = { headers: { accept: 'text/html' } };

/** A module recording the conditions a page evaluates, in order. */
const PROBE: FixtureFile = {
  path: 'shared/probe.ts',
  source: `/** Records each condition a page evaluates. */
export const calls: string[] = [];

/** Record \`name\` and answer \`value\`. */
export function check(name: string, value: boolean): boolean {
  calls.push(name);
  return value;
}
`,
};

/** A page whose live tags sit inside js-if chains of probed conditions. */
function probePage(path: string, outer: boolean): FixtureFile {
  return {
    path,
    source: `<!-- Live tags under probed conditions. -->
<script lang="ts">
import { check } from '../shared/probe.js';
</script>

<template>
  <section js-if="check('outer', ${outer})">
    <TaskList />
    <div js-if="check('inner', false)"><p>Never</p></div>
    <div js-else-if="check('second', true)"><TaskList /></div>
  </section>
  <p js-else>Nothing mounted</p>
</template>
`,
  };
}

const REFUSED: FixtureFile = {
  path: 'pages/refused.jsails',
  source: `<!-- A page whose live component has no static form. -->
<template>
  <main><NoFallback /></main>
</template>
`,
};

/** A `staticRender: 'initial'` component whose authorize assumes a session, and its page. */
const SESSION_GATED: readonly FixtureFile[] = [
  {
    path: 'components/session-gate.jsails',
    source: `<script lang="ts">
/** A live component whose authorize reads the session, which a static export has none of. */
import { z } from 'zod';

defineLive({
  stateSchema: z.object({ on: z.boolean() }).strict(),
  initialState: () => ({ on: false }),
  authorize: (context) => context.session!.data['user'] !== undefined,
  staticRender: 'initial',
});
</script>

<template>
  <p js-show="on">On</p>
</template>
`,
  },
  {
    path: 'pages/session-gated.jsails',
    source: `<!-- A page whose live component throws in authorize at build time. -->
<script lang="ts">
import SessionGate from '../components/session-gate.jsails';
</script>

<template>
  <main><SessionGate /></main>
</template>
`,
  },
];

const scratch = mkdtempSync(join(tmpdir(), 'jsails-sfc-live-'));
const fixtures: CompiledFixtureApp[] = [];
const apps: TestApplication[] = [];

after(async () => {
  for (const app of apps) await app.close();
  for (const fixture of fixtures) fixture.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

/** Compile `files` and serve them with every live component, and `extra` ones, registered. */
async function serve(
  files: readonly FixtureFile[],
  outDir: string,
  extra: readonly string[] = [],
): Promise<{ fixture: CompiledFixtureApp; app: TestApplication }> {
  const fixture = compileFixtureApp(files, { resolver: LIVE_RESOLVER });
  fixtures.push(fixture);
  const components: Record<string, ServerComponentDefinition<any>> = {};
  for (const name of ['task-list', 'no-fallback', 'initial', ...extra]) {
    const module = await fixture.load(`components/${name}.jsails`);
    components[name] = module.default as ServerComponentDefinition<any>;
  }
  const app = await createTestApp({
    config: {
      rootDir: fixture.root,
      out: outDir,
      port: 0,
      extensions: [serverComponentsPlugin({ components, signingKey: KEY })],
    },
  });
  apps.push(app);
  return { fixture, app };
}

function attribute(html: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`).exec(html);
  assert.ok(match !== null, `expected ${name}`);
  return match[1] ?? '';
}

let main: { fixture: CompiledFixtureApp; app: TestApplication } | undefined;
const mainOut = join(scratch, 'out');

before(async () => {
  main = await serve(
    [
      ...LIVE_APP,
      PROBE,
      probePage('pages/probe.jsails', true),
      probePage('pages/skip.jsails', false),
    ],
    mainOut,
  );
});

describe('the task list', () => {
  /** POST an update of the mounted task list and decode the answer. */
  async function update(
    app: TestApplication,
    mounted: { snapshot: string },
    fields: {
      updates?: Record<string, unknown>;
      action: { name: string; args?: Record<string, unknown> };
    },
  ): Promise<{ status: number; body: LaneBody }> {
    const response = await app.request(COMPONENT_UPDATE_ENDPOINT, {
      method: 'POST',
      headers: {
        origin: app.origin,
        'content-type': 'application/json',
      },
      body: JSON.stringify(updateBody({ snapshot: mounted.snapshot, ...fields })),
    });
    return { status: response.status, body: (await response.json()) as LaneBody };
  }

  it('mounts a signed root and round-trips add, remove and a rejected add', async () => {
    assert.ok(main !== undefined);
    const { app } = main;
    const page = await app.request('/tasks', NAVIGATION);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /data-jsails-component="task-list"/);
    assert.match(html, /No tasks yet\./);
    let snapshot = attribute(html, COMPONENT_SNAPSHOT_ATTRIBUTE);

    const added = await update(
      app,
      { snapshot },
      {
        updates: { title: 'Buy milk' },
        action: { name: 'add' },
      },
    );
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.match(added.body.html ?? '', /data-task-item[^>]*>\s*Buy milk/);
    assert.match(added.body.html ?? '', /1 task</);
    assert.ok(added.body.snapshot !== undefined);
    snapshot = added.body.snapshot;

    const removed = await update(
      app,
      { snapshot },
      {
        action: { name: 'remove', args: { index: 0 } },
      },
    );
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.match(removed.body.html ?? '', /No tasks yet\./);
    assert.ok(removed.body.snapshot !== undefined);
    snapshot = removed.body.snapshot;

    const rejected = await update(
      app,
      { snapshot },
      {
        updates: { title: '' },
        action: { name: 'add' },
      },
    );
    assert.equal(rejected.status, 422);
    assert.equal(typeof rejected.body.errors?.title, 'string');
    assert.match(rejected.body.html ?? '', /data-task-error/);
  });

  it('renders its live markers from the template', async () => {
    assert.ok(main !== undefined);
    const html = await (await main.app.request('/tasks', NAVIGATION)).text();
    assert.match(html, /<form[^>]*data-jsails-submit="add"/);
    assert.match(html, /<input[^>]*data-jsails-model="title" data-jsails-trim[ >]/);
    assert.match(html, /<button[^>]*data-jsails-loading-target>Add</);
  });

  it('refuses an action the component does not declare', async () => {
    assert.ok(main !== undefined);
    const { app } = main;
    const html = await (await app.request('/tasks', NAVIGATION)).text();
    const answer = await update(
      app,
      {
        snapshot: attribute(html, COMPONENT_SNAPSHOT_ATTRIBUTE),
      },
      { action: { name: 'ad' } },
    );
    assert.equal(answer.status >= 400 && answer.status < 500, true);
  });
});

describe('serve and export of live pages', () => {
  it('serve the signed root and export the static forms', async () => {
    assert.ok(main !== undefined);
    const { app } = main;
    const result = await app.application.build();
    assert.deepEqual(result.liveOnly, []);

    const exported = readFileSync(join(mainOut, 'tasks', 'index.html'), 'utf8');
    assert.match(exported, /data-jsails-component="task-list"/);
    assert.match(exported, /The task list works when the site is served\./);
    assert.doesNotMatch(exported, /No tasks yet|data-jsails-submit/);
    assert.ok(!exported.includes(COMPONENT_SNAPSHOT_ATTRIBUTE));

    const served = await (await app.request('/tasks', NAVIGATION)).text();
    assert.match(served, new RegExp(`${COMPONENT_SNAPSHOT_ATTRIBUTE}="[^"]+"`));
    assert.doesNotMatch(served, /works when the site is served/);
  });

  it('export an initial render with inert markup', () => {
    const exported = readFileSync(join(mainOut, 'greeting', 'index.html'), 'utf8');
    assert.match(exported, /data-jsails-component="initial"/);
    assert.ok(
      exported.includes(
        `<form method="dialog"${scopeMarker(sfcScopeId('components/initial.jsails'))}>`,
      ),
    );
    assert.match(exported, /<p>Hello<\/p>/);
    assert.doesNotMatch(exported, /data-jsails-(?:component-snapshot|submit|show|text)/);
  });

  it('refuse to export a live component without a static form, naming the route', async () => {
    const outDir = join(scratch, 'refused-out');
    const { app } = await serve([...LIVE_APP, REFUSED], outDir);
    const served = await app.request('/refused', NAVIGATION);
    assert.equal(served.status, 200);
    assert.match(await served.text(), /data-jsails-component="no-fallback"/);

    await assert.rejects(app.application.build(), (error: unknown) => {
      assert.ok(error instanceof PageRenderError);
      assert.equal(error.code, 'invalid_route');
      assert.match(error.message, /"\/refused"/);
      assert.ok(ComponentStaticErrors.is(error.cause, 'missing_fallback'));
      return true;
    });
    assert.equal(existsSync(join(outDir, 'refused', 'index.html')), false);
  });

  it('refuse to export an initial render whose authorize throws, past the boundary', async () => {
    const outDir = join(scratch, 'session-gated-out');
    const { app } = await serve([...LIVE_APP, ...SESSION_GATED], outDir, ['session-gate']);

    await assert.rejects(app.application.build(), (error: unknown) => {
      assert.ok(error instanceof PageRenderError);
      assert.equal(error.code, 'invalid_route');
      assert.match(error.message, /"\/session-gated"/);
      assert.ok(ComponentStaticErrors.is(error.cause, 'render_failed'));
      assert.deepEqual(error.cause.context, { component: 'session-gate' });
      assert.ok(ComponentAuthorizeErrors.is(error.cause.cause, 'component_failed'));
      return true;
    });
    assert.equal(existsSync(join(outDir, 'session-gated', 'index.html')), false);
  });
});

describe('the hoisted mount', () => {
  it('evaluates each condition once before the template, in its order', async () => {
    assert.ok(main !== undefined);
    const probe = await main.fixture.load('shared/probe.ts');
    const calls = probe.calls as string[];
    calls.length = 0;
    const html = await (await main.app.request('/probe', NAVIGATION)).text();
    assert.deepEqual(calls, ['outer', 'inner', 'second', 'outer', 'inner', 'second']);
    assert.equal(html.match(/data-jsails-component="task-list"/g)?.length, 2);
  });

  it('mounts nothing the template does not render', async () => {
    assert.ok(main !== undefined);
    const probe = await main.fixture.load('shared/probe.ts');
    const calls = probe.calls as string[];
    calls.length = 0;
    const html = await (await main.app.request('/skip', NAVIGATION)).text();
    assert.deepEqual(calls, ['outer', 'outer']);
    assert.match(html, /Nothing mounted/);
    assert.doesNotMatch(html, /data-jsails-component/);
  });
});
