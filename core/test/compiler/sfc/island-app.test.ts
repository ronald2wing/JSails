/**
 * Group E of the island lowering, hydration parity (sfc-plan §3.4): over the
 * compiled island corpus (`island-corpus.ts`), each island and the view it
 * renders compile for the browser to the server's module byte for byte, and
 * a page does not; the served page and the exported page are the same bytes,
 * with one marker element per island mounted from the server (in a loop and
 * through a view too, never around an island inside another); each marker
 * holds exactly what the island's module renders from the props the browser
 * decodes from the marker; and the client runtime, registering the islands
 * as `startClient({ islands })` takes them, hydrates every marker with
 * `preact/debug` reporting no mismatch and the DOM left as the server wrote
 * it, after which events, `js-model` bindings and component events work.
 */

import 'preact/debug';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Window } from 'happy-dom';
import { options } from 'preact';
import { renderToString } from 'preact-render-to-string';

import {
  createIslandRegistry,
  IslandManagerImpl,
  type JsailsDocument,
} from '../../../src/client/islands.js';
import { compileSfc } from '../../../src/compiler/sfc/compile.js';
import { scopeMarker, sfcScopeId } from '../../../src/compiler/sfc/style.js';
import { generateStaticSite } from '../../../src/pages/static-site/index.js';
import { discoverRoutes } from '../../../src/routing/routes.js';
import { createTestApp } from '../../../src/testing/app.js';
import type { TestApplication } from '../../../src/testing/index.js';
import { islandTree, type DefinedIsland } from '../../../src/view/island.js';
import { decodeIslandProps } from '../../../src/view/island-props.js';
import { compileFixtureApp, type CompiledFixtureApp } from './compiled-fixture.js';
import { ISLAND_APP, ISLAND_CLIENT_FILES, ISLAND_IDS, ISLAND_RESOLVER } from './island-corpus.js';

/** A browser navigation, so the page is answered as HTML. */
const NAVIGATION: RequestInit = { headers: { accept: 'text/html' } };

/** One marker element of the served HTML, as the server wrote it. */
const MARKER =
  /<jsails-island data-jsails-island="([^"]*)" data-jsails-props="([^"]*)">(.*?)<\/jsails-island>/gs;

const scratch = mkdtempSync(join(tmpdir(), 'jsails-sfc-islands-'));

let fixture: CompiledFixtureApp | undefined;
let app: TestApplication | undefined;
let islands: Map<string, DefinedIsland<never>> | undefined;
let page = '';
const debounce = options.debounceRendering;

before(async () => {
  fixture = compileFixtureApp(ISLAND_APP, { resolver: ISLAND_RESOLVER });
  app = await createTestApp({ config: { rootDir: fixture.root, port: 0 } });
  islands = new Map();
  for (const [file, id] of Object.entries(ISLAND_IDS)) {
    const module = await fixture.load(file);
    islands.set(id, module.default as DefinedIsland<never>);
  }
  const response = await app.request('/', NAVIGATION);
  assert.equal(response.status, 200);
  page = await response.text();
  // Render a signal's update at once, so an interaction is asserted without waiting.
  options.debounceRendering = (render) => render();
});

after(async () => {
  options.debounceRendering = debounce;
  await app?.close();
  fixture?.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

/** The markers of `html`: each island's id, its props attribute decoded, and its content. */
function markers(html: string): { id: string; props: string; content: string }[] {
  return [...html.matchAll(MARKER)].map((match) => ({
    id: match[1] as string,
    props: (match[2] as string)
      .replaceAll('&quot;', '"')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&'),
    content: match[3] as string,
  }));
}

function island(id: string): DefinedIsland<never> {
  const found = islands?.get(id);
  assert.ok(found !== undefined, `no island ${id}`);
  return found;
}

describe('the island corpus', () => {
  it('compiles each island and the view it renders for the browser, to the server module', () => {
    assert.ok(fixture !== undefined);
    for (const lowering of fixture.lowerings) {
      const server = compileSfc(lowering, { specifiers: 'node' });
      const client = compileSfc(lowering, { specifiers: 'node', target: 'client' });
      if (lowering.kind === 'page') {
        assert.equal(client.js, null, lowering.file);
        assert.deepEqual(
          client.diagnostics.map((entry) => entry.code),
          ['sfc.client_target'],
        );
        continue;
      }
      assert.ok(server.js !== null, lowering.file);
      assert.equal(client.js, server.js, lowering.file);
    }
    assert.deepEqual(
      fixture.lowerings.filter((lowering) => lowering.kind === 'island').map((entry) => entry.file),
      ISLAND_CLIENT_FILES.filter((file) => file.startsWith('islands/')),
    );
  });

  it('serves and exports the page with the same island markers', async () => {
    assert.ok(fixture !== undefined);
    const outDir = join(scratch, 'out');
    await generateStaticSite({
      manifest: discoverRoutes(fixture.root),
      outDir,
      root: fixture.root,
    });
    const exported = readFileSync(join(outDir, 'index.html'), 'utf8');
    assert.equal(exported, page);
    assert.deepEqual(
      markers(page).map((marker) => [marker.id, marker.props]),
      [
        ['counter', '{"start":0,"label":"Clicks"}'],
        ['counter', '{"start":1,"label":"Item a"}'],
        ['counter', '{"start":2,"label":"Item b"}'],
        ['toggle-panel', '{"title":"Details"}'],
        ['counter', '{"start":5,"label":"Promo"}'],
      ],
    );
    assert.equal(page.match(/<jsails-island/g)?.length, 5, 'no marker inside a marker');
    assert.doesNotMatch(page, /\sstyle=/, 'no style attribute, which a CSP nonce cannot allow');
    assert.ok(
      page.includes(
        `<span class="badge"${scopeMarker(sfcScopeId('ui/badge.jsails'))}>static</span>`,
      ),
    );
  });

  it('writes in each marker what the island renders from the props the browser decodes', () => {
    const found = markers(page);
    assert.equal(found.length, 5);
    for (const marker of found) {
      assert.equal(
        renderToString(islandTree(island(marker.id), decodeIslandProps(marker.props))),
        marker.content,
        `${marker.id} ${marker.props}`,
      );
    }
  });

  it('hydrates every marker with no mismatch, leaving the DOM as the server wrote it', async () => {
    const window = new Window({ url: 'http://localhost/' });
    const reported: unknown[][] = [];
    const { error, warn } = console;
    try {
      window.document.write(page);
      const elements = [...window.document.querySelectorAll('jsails-island')];
      const before = elements.map((element) => element.innerHTML);
      const errors: unknown[] = [];
      console.error = (...args: unknown[]) => reported.push(args);
      console.warn = (...args: unknown[]) => reported.push(args);
      new IslandManagerImpl({
        document: window.document as unknown as JsailsDocument,
        registry: createIslandRegistry([...(islands?.values() ?? [])]),
        onError: (failure) => errors.push(failure),
      }).mountAll();
      console.error = error;
      console.warn = warn;
      assert.deepEqual(errors, []);
      assert.deepEqual(reported, []);
      assert.deepEqual(
        elements.map((element) => element.getAttribute('data-hydrated')),
        elements.map(() => 'true'),
      );
      assert.deepEqual(
        elements.map((element) => element.innerHTML),
        before,
      );
    } finally {
      console.error = error;
      console.warn = warn;
      await window.happyDOM.close();
    }
  });

  it('runs events, bindings and component events once hydrated', async () => {
    const window = new Window({ url: 'http://localhost/' });
    try {
      const document = window.document;
      document.write(page);
      new IslandManagerImpl({
        document: document as unknown as JsailsDocument,
        registry: createIslandRegistry([...(islands?.values() ?? [])]),
      }).mountAll();
      const [first] = [...document.querySelectorAll('jsails-island')];
      assert.ok(first !== undefined);
      const output = (): string | null | undefined => first.querySelector('output')?.textContent;

      const add = first.querySelector('.add') as unknown as { click(): void };
      add.click();
      assert.equal(output(), '1', 'a method handler is called through its object');

      const input = first.querySelector('input') as unknown as {
        value: string;
        dispatchEvent(event: unknown): boolean;
      };
      input.value = '7';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      assert.equal(output(), '7', 'js-model writes the signal beside an @input');
      assert.equal(
        first.querySelector('.edits')?.textContent,
        '7',
        'the @input runs after the model wrote the signal',
      );

      const reset = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      first.querySelector('.reset')?.dispatchEvent(reset);
      assert.equal(reset.defaultPrevented, true, '.prevent');
      assert.equal(output(), '0');
      assert.equal(input.value, '0');

      const panel = document.querySelector('[data-jsails-island="toggle-panel"]');
      assert.ok(panel !== null);
      assert.equal(panel.querySelector('.badge')?.textContent, 'closed');
      (panel.querySelector('input[type="checkbox"]') as unknown as { click(): void }).click();
      assert.equal(panel.querySelector('.badge')?.textContent, 'open');
      assert.equal(panel.querySelector('.opened')?.textContent, '1', 'the @change beside js-model');
      const inner = panel.querySelector('.counter');
      assert.ok(inner !== null, 'the nested counter renders as part of the panel');
      assert.equal(inner.querySelector('.add')?.textContent, 'Inner');
      (inner.querySelector('.add') as unknown as { click(): void }).click();
      assert.equal(inner.querySelector('output')?.textContent, '11');
      assert.equal(panel.querySelector('.changes')?.textContent, '1', 'the change event');
    } finally {
      await window.happyDOM.close();
    }
  });
});
