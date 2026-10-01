/**
 * The keep-wrapper morph in Chromium: a test-only parent component with 500
 * stateful nested children, injected into the admin fixture (never part of the
 * shipped starter), and the browser pass that drives it under `jsails serve`.
 *
 * Every child is failed once (a 422 that renders its error) and typed into
 * (an edit its controller holds, unsent), then the parent runs an action. The
 * pass proves, through the real client runtime, Turbo's morph, and the
 * runtime's `turbo:before-morph-element` rule, that the client reported every
 * child in `have.slots`, the server answered each one with a keep marker, and
 * every child kept its DOM node, its binding (its root's `data-hydrated` is
 * never removed and re-set, which a dispose and rebind would do), its typed
 * value, and its error: nothing inside any child wrapper mutates. A child's
 * own action still works afterwards with the edit its controller held.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { openQaPage } from './browser.mjs';

/** The children the parent renders: the exit gate's 500. */
const CHILDREN = 500;

/** Budget for one child's 422 round trip. */
const CHILD_ACTION_TIMEOUT_MS = 10_000;

const PAGE_ROUTE = '/keep-morph';

const CARD_PATH = 'components/keep-card.tsx';
const BOARD_PATH = 'components/keep-board.tsx';
const PAGE_PATH = 'pages/keep-morph.tsx';

const CARD_SOURCE = `import { z } from 'zod';

import { defineComponent, serverAction } from '../app/application-component.js';

const stateSchema = z.object({ note: z.string().max(120) }).strict();

type KeepCardState = z.infer<typeof stateSchema>;

const noteSchema = z.object({ note: z.string().trim().min(1) });

export const keepCard = defineComponent<KeepCardState>({
  name: 'keep-card',
  stateSchema,
  writableKeys: ['note'],
  initialState() {
    return { note: '' };
  },
  authorize() {
    return true;
  },
  actions: {
    save: serverAction({
      input: z.object({}),
      run(state) {
        const parsed = noteSchema.safeParse({ note: state.note });
        if (!parsed.success) {
          throw parsed.error;
        }
        state.note = parsed.data.note;
      },
    }),
  },
  render(state, { bind, submit, errors }) {
    return (
      <form data-keep-card {...submit('save')}>
        <input type="text" aria-label="Note" data-keep-input {...bind('note')} />
        <button type="submit" data-keep-save>
          Save
        </button>
        {errors.note ? <p data-keep-error>{errors.note}</p> : null}
        {state.note === '' ? null : <p data-keep-saved>{state.note}</p>}
      </form>
    );
  },
  staticFallback() {
    return <p>Not available in the static export.</p>;
  },
});
`;

const BOARD_SOURCE = `import { z } from 'zod';
import { defineNestedComponent, renderNested } from 'jsails/server-components';

import { defineComponent, serverAction } from '../app/application-component.js';

const stateSchema = z.object({ title: z.string().max(40) }).strict();

type KeepBoardState = z.infer<typeof stateSchema>;

export const keepBoard = defineComponent<KeepBoardState>({
  name: 'keep-board',
  stateSchema,
  initialState() {
    return { title: 'board' };
  },
  authorize() {
    return true;
  },
  actions: {
    rename: serverAction({
      input: z.object({}),
      run(state) {
        state.title = 'renamed';
      },
    }),
  },
  async render(state, { submit, context }) {
    const children = await Promise.all(
      Array.from({ length: ${CHILDREN} }, (_, index) =>
        renderNested(
          defineNestedComponent({ name: 'li', component: 'keep-card', key: \`c\${index}\` }),
          context,
        ),
      ),
    );
    return (
      <section>
        <h2 data-keep-title>{state.title}</h2>
        <form {...submit('rename')}>
          <button type="submit" data-keep-rename>
            Rename
          </button>
        </form>
        <ul>{children}</ul>
      </section>
    );
  },
  staticFallback() {
    return <p>Not available in the static export.</p>;
  },
});
`;

const PAGE_SOURCE = `import type { VNode } from 'preact';

import type { RequestContext } from 'jsails';
import { renderServerComponent } from 'jsails/server-components';

import { loadLayout, UiLayout, type LayoutAssets } from '../ui/layout.js';

export interface KeepMorphProps {
  board: VNode;
  assets?: LayoutAssets;
}

export async function load(context: RequestContext): Promise<KeepMorphProps> {
  const [board, assets] = await Promise.all([
    renderServerComponent('keep-board', context),
    loadLayout(context),
  ]);
  return { board, assets };
}

export default function KeepMorphPage({ board, assets }: KeepMorphProps) {
  return (
    <UiLayout title="Keep Morph" assets={assets}>
      {board}
    </UiLayout>
  );
}
`;

/** Writes the two components and the page into `fixtureDir`. */
export function writeKeepMorphFixture(fixtureDir) {
  for (const [path, source] of [
    [CARD_PATH, CARD_SOURCE],
    [BOARD_PATH, BOARD_SOURCE],
    [PAGE_PATH, PAGE_SOURCE],
  ]) {
    mkdirSync(dirname(join(fixtureDir, path)), { recursive: true });
    writeFileSync(join(fixtureDir, path), source);
  }
  return `injected a parent with ${CHILDREN} nested children and its page into the fixture`;
}

const CARD_SELECTOR = '[data-jsails-component="keep-card"]';

/** The console line Chromium writes for each child's expected 422. */
const EXPECTED_422 = /^Failed to load resource: the server responded with a status of 422\b/;

/** The keep-morph pass against a served fixture at `url`; returns what it observed. */
export async function runKeepMorphQa(url) {
  const page = await openQaPage();
  const errors = [];
  try {
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    // Chromium logs every non-2xx response; the children's 422s are the point.
    page.on('console', (message) => {
      if (message.type() === 'error' && !EXPECTED_422.test(message.text())) {
        errors.push(`console: ${message.text()}`);
      }
    });

    await page.goto(new URL(PAGE_ROUTE, url).href, { waitUntil: 'load' });
    await page.waitForFunction(
      ({ selector, count }) =>
        document.querySelectorAll(`${selector}[data-hydrated="true"]`).length === count &&
        document.querySelector('[data-jsails-component="keep-board"][data-hydrated="true"]') !==
          null,
      { selector: CARD_SELECTOR, count: CHILDREN },
    );

    // One child at a time: the update lane admits a few requests per client
    // at once, and a refused one would not render its 422. A blank note
    // passes the client's `required` rule and fails the server's trim.
    await page.evaluate(
      async ({ selector, timeoutMs }) => {
        for (const root of Array.from(document.querySelectorAll(selector))) {
          const input = root.querySelector('[data-keep-input]');
          input.value = '   ';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          root.querySelector('[data-keep-save]').click();
          const started = Date.now();
          while (root.querySelector('[data-keep-error]') === null) {
            if (Date.now() - started > timeoutMs) {
              throw new Error(`child ${root.id} rendered no 422 error`);
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
      },
      { selector: CARD_SELECTOR, timeoutMs: CHILD_ACTION_TIMEOUT_MS },
    );

    // Type into every child (an edit its controller holds, not sent), mark
    // every child root, and record every mutation inside every child wrapper.
    await page.evaluate((selector) => {
      const roots = Array.from(document.querySelectorAll(selector));
      const records = [];
      const observer = new MutationObserver((list) => {
        for (const record of list) {
          records.push(`${record.type}:${record.attributeName ?? ''}@${record.target.nodeName}`);
        }
      });
      for (const [index, root] of roots.entries()) {
        const input = root.querySelector('[data-keep-input]');
        input.value = `typed ${index}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        root.__keepMorphIndex = index;
        observer.observe(root.parentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }
      globalThis.__keepMorph = { roots, records, observer };
    }, CARD_SELECTOR);

    const [response] = await Promise.all([
      page.waitForResponse(
        (candidate) =>
          candidate.url().endsWith('/_jsails/components/update') &&
          (candidate.request().postData() ?? '').includes('"rename"'),
      ),
      page.locator('[data-keep-rename]').click(),
    ]);
    const request = JSON.parse(response.request().postData() ?? '{}');
    const reply = await response.json();
    await page.waitForFunction(
      () => document.querySelector('[data-keep-title]')?.textContent === 'renamed',
    );
    // The nested reconcile runs right after the morph; let it finish.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));

    const facts = await page.evaluate((selector) => {
      const { roots, records, observer } = globalThis.__keepMorph;
      for (const record of observer.takeRecords()) {
        records.push(`${record.type}:${record.attributeName ?? ''}@${record.target.nodeName}`);
      }
      observer.disconnect();
      const now = Array.from(document.querySelectorAll(selector));
      return {
        count: now.length,
        sameNodes: now.every((root, index) => root === roots[index]),
        marked: now.every((root, index) => root.__keepMorphIndex === index),
        bound: now.every((root) => root.getAttribute('data-hydrated') === 'true'),
        typed: now.every(
          (root, index) => root.querySelector('[data-keep-input]').value === `typed ${index}`,
        ),
        errors: now.every((root) => root.querySelector('[data-keep-error]') !== null),
        markers: document.querySelectorAll('[data-jsails-nested-keep]').length,
        mutations: records.length,
        sample: records.slice(0, 5),
      };
    }, CARD_SELECTOR);

    const reported = Array.isArray(request.have?.slots) ? request.have.slots.length : 0;
    const keptInReply =
      reply.kind === 'render' ? (reply.html.match(/data-jsails-nested-keep/g) ?? []).length : 0;
    if (reported !== CHILDREN) {
      throw new Error(`the parent update reported ${reported} held children, not ${CHILDREN}`);
    }
    if (keptInReply !== CHILDREN) {
      throw new Error(
        `the parent reply (${reply.kind}) kept ${keptInReply} children by reference, not ${CHILDREN}`,
      );
    }
    if (facts.count !== CHILDREN || !facts.sameNodes || !facts.marked) {
      throw new Error(`children lost their DOM identity (${facts.count} roots after the morph)`);
    }
    if (!facts.bound) {
      throw new Error('a child root lost its binding through the parent morph');
    }
    if (facts.mutations !== 0) {
      throw new Error(
        `the morph mutated ${facts.mutations} node(s) inside child wrappers: ${facts.sample.join(', ')}`,
      );
    }
    if (!facts.typed) throw new Error('a child lost its typed value through the parent morph');
    if (!facts.errors) throw new Error('a child lost its 422 error through the parent morph');
    if (facts.markers !== 0) {
      throw new Error(`${facts.markers} keep marker(s) reached the document`);
    }

    // The first child's own controller, with the edit it held, still acts.
    const first = page.locator(CARD_SELECTOR).first();
    await first.locator('[data-keep-save]').click();
    await first.locator('[data-keep-saved]').waitFor();
    const saved = (await first.locator('[data-keep-saved]').textContent())?.trim();
    if (saved !== 'typed 0') {
      throw new Error(`the first child saved ${JSON.stringify(saved)}, not "typed 0"`);
    }
    if ((await first.locator('[data-keep-error]').count()) !== 0) {
      throw new Error('the first child still shows its error after a valid save');
    }

    if (errors.length > 0) {
      throw new Error(`browser console/page errors:\n${errors.join('\n')}`);
    }
    return { children: CHILDREN, saved };
  } finally {
    await page.close();
  }
}
