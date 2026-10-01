/**
 * Source maps at run time (sfc-plan §3.4): with Node's source-map support on,
 * an error thrown by a compiled `.jsails` module has stack frames at its
 * `.jsails` line and column, for an error created in `<script>` code (V8
 * places it at `new Error`), a call in `<script setup>`, a call in a
 * template expression, a call inside a `js-for` body, and a page's `load`.
 * The maps reach Node through the `sourceMappingURL` comment and the `.js.map`
 * file the harness writes beside each module, as an app build writes them.
 * Node prints a mapped frame as a native path (`fileURLToPath` of the map's
 * source), so on Windows the file name follows a backslash.
 */

import assert from 'node:assert/strict';
import { setSourceMapsSupport } from 'node:module';
import { after, before, describe, it } from 'node:test';

import type { RenderChild } from '../../../src/contracts/component.js';
import { Fragment, jsx } from '../../../src/jsx/jsx-runtime.js';
import { renderToString } from '../../../src/jsx/render-to-string.js';
import { compileFixtureApp, type CompiledFixtureApp } from './compiled-fixture.js';
import { SFC_CORPUS } from './corpus.js';

const PROBE = `<script lang="ts">
/** Throws from each place a stack frame can point into. */
export function explode(where: string): never {
  throw new Error(where);
}
</script>

<script setup lang="ts">
const props = defineProps<{ mode: string; items: string[] }>();
const label = props.mode === 'setup' ? explode('setup') : props.mode;
</script>

<template>
  <ul>
    <li js-for="item in items" :key="item">{{ mode === 'loop' ? explode(item) : item }}</li>
  </ul>
  <p>{{ mode === 'template' ? explode('template') : label }}</p>
</template>
`;

const BROKEN = SFC_CORPUS.find((file) => file.path === 'pages/broken.jsails');

type Render = (props: unknown) => RenderChild | Promise<RenderChild>;

let fixture: CompiledFixtureApp | undefined;
let probe: Render | undefined;
let load: (() => unknown) | undefined;

before(async () => {
  setSourceMapsSupport(true);
  assert.ok(BROKEN !== undefined);
  fixture = compileFixtureApp([{ path: 'ui/probe.jsails', source: PROBE }, BROKEN]);
  probe = (await fixture.load('ui/probe.jsails'))['default'] as Render;
  load = (await fixture.load('pages/broken.jsails'))['load'] as () => unknown;
});

after(() => {
  setSourceMapsSupport(false);
  fixture?.dispose();
});

/** The 1-based `line:column` of the `nth` occurrence of `needle` in `text`. */
function at(text: string, needle: string, nth = 0): string {
  let offset = -1;
  for (let count = 0; count <= nth; count += 1) offset = text.indexOf(needle, offset + 1);
  assert.ok(offset >= 0, needle);
  const before = text.slice(0, offset).split('\n');
  return `${before.length}:${(before.at(-1)?.length ?? 0) + 1}`;
}

/**
 * The `line:column` of every frame of `stack` in the project file `file`,
 * printed as a POSIX or a Windows path.
 */
function framesIn(stack: string, file: string): string[] {
  const name = file.slice(file.lastIndexOf('/') + 1).replace(/[.[\]]/g, '\\$&');
  return [...stack.matchAll(new RegExp(`[\\\\/]${name}:(\\d+:\\d+)\\)?$`, 'gm'))].map(
    (match) => match[1] ?? '',
  );
}

/** The `line:column` of every frame of `error`'s stack in the project file `file`. */
function frames(error: unknown, file: string): string[] {
  assert.ok(error instanceof Error && error.stack !== undefined);
  return framesIn(error.stack, file);
}

/** Render the probe in `mode` and return what it threw. */
async function thrown(mode: string): Promise<unknown> {
  assert.ok(probe !== undefined);
  try {
    renderToString(jsx(Fragment, { children: await probe({ mode, items: ['a', 'b'] }) }));
  } catch (error) {
    return error;
  }
  assert.fail(`mode ${mode} did not throw`);
}

describe('reading frames from a stack', () => {
  it('finds a frame printed as a POSIX or a Windows path, and no other file', () => {
    const stack = [
      'Error: setup',
      '    at explode (/app/run-1/ui/probe.jsails:4:9)',
      '    at C:\\app\\run-1\\ui\\probe.jsails:10:15',
      '    at Probe (C:\\app\\run-1\\ui\\probe.jsails:10:41)',
      '    at other (/app/run-1/ui/xprobe.jsails:1:1)',
      '    at [slug] (C:\\app\\pages\\blog\\[slug].jsails:2:3)',
    ].join('\n');
    assert.deepEqual(framesIn(stack, 'ui/probe.jsails'), ['4:9', '10:15', '10:41']);
    assert.deepEqual(framesIn(stack, 'pages/blog/[slug].jsails'), ['2:3']);
  });
});

describe('stack traces of compiled .jsails modules', () => {
  it('point a throw in <script> and its <script setup> caller at the .jsails source', async () => {
    assert.deepEqual(frames(await thrown('setup'), 'ui/probe.jsails').slice(0, 2), [
      at(PROBE, 'new Error'),
      at(PROBE, "explode('setup')"),
    ]);
  });

  it('point a call in a template expression at the .jsails source', async () => {
    assert.deepEqual(frames(await thrown('template'), 'ui/probe.jsails').slice(0, 2), [
      at(PROBE, 'new Error'),
      at(PROBE, "explode('template')"),
    ]);
  });

  it('point a call inside a js-for body at the .jsails source', async () => {
    assert.deepEqual(frames(await thrown('loop'), 'ui/probe.jsails').slice(0, 2), [
      at(PROBE, 'new Error'),
      at(PROBE, 'explode(item)'),
    ]);
  });

  it("point a throw in a page's load at the .jsails source", () => {
    assert.ok(load !== undefined && BROKEN !== undefined);
    let error: unknown;
    try {
      load();
    } catch (caught) {
      error = caught;
    }
    assert.deepEqual(frames(error, 'pages/broken.jsails').slice(0, 1), [
      at(BROKEN.source, 'new Error'),
    ]);
  });
});
