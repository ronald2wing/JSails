/**
 * Server-component scenarios. `component-poll-unchanged` is the idle poll of
 * a parent holding ten nested children: the client reports the render tag it
 * shows and the children it holds, and the update protocol answers
 * `unchanged`. Its exact counters hold the protocol's promises: the parent
 * renders once, no child renders (each is kept by reference), nothing is
 * re-signed (only the render tag and the snapshot check hash), and the reply
 * is a few dozen bytes. Each component render publishes on `jsails:render`,
 * so the `renders` counter counts component renders. Its request fact
 * `requestBytesOverSnapshot` is what the poll adds to the parent's own token
 * (the render tag and the ten held slots), held within 1 KiB.
 */

import { ORIGIN } from '../app.mjs';

const KEY = '0123456789abcdef0123456789abcdef';
const CHILDREN = 10;

/** The most a poll holding ten children may add to its own token. */
const MAX_REQUEST_BYTES_OVER_SNAPSHOT = 1024;

const APP_CONFIG = `import { serverComponentsPlugin } from 'jsails/server-components';

import { board, card } from './components.js';

export default {
  host: '127.0.0.1',
  port: 0,
  server: { origin: '${ORIGIN}' },
  extensions: [
    serverComponentsPlugin({ signingKey: '${KEY}', components: { board, card } }),
  ],
};
`;

const COMPONENTS = `import { channel } from 'node:diagnostics_channel';

import { z } from 'jsails/zod';
import {
  defineNestedComponent,
  defineServerComponent,
  renderNested,
} from 'jsails/server-components';

const renders = channel('jsails:render');

export const card = defineServerComponent({
  name: 'card',
  stateSchema: z.object({ count: z.number() }).strict(),
  initialState: () => ({ count: 0 }),
  authorize: () => true,
  render(state) {
    renders.publish({ component: 'card' });
    return 'card ' + state.count;
  },
});

export const board = defineServerComponent({
  name: 'board',
  stateSchema: z.object({ title: z.string() }).strict(),
  initialState: () => ({ title: 'board' }),
  authorize: () => true,
  async render(state, { context }) {
    renders.publish({ component: 'board' });
    const children = await Promise.all(
      Array.from({ length: ${CHILDREN} }, (_, index) =>
        renderNested(
          defineNestedComponent({ name: 'li', component: 'card', key: 'c' + index }),
          context,
        ),
      ),
    );
    return [state.title, ...children];
  },
});
`;

const PAGE = `import { renderServerComponent } from 'jsails/server-components';

export async function load(context) {
  return { board: await renderServerComponent('board', context) };
}

export default function Board({ board }) {
  return board;
}
`;

function attribute(html, name) {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  if (match === null) throw new Error(`the page carries no ${name}`);
  return match[1];
}

/** Mount the board through a page render and build its idle poll. */
async function idlePoll({ fetch }) {
  const page = await fetch({ path: '/', headers: { accept: 'text/html' } });
  const html = await page.text();
  const slots = Array.from({ length: CHILDREN }, (_, index) => ({
    slot: `k:c${index}`,
    component: 'card',
  }));
  return {
    path: '/_jsails/components/update',
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: ORIGIN,
    },
    body: JSON.stringify({
      v: 2,
      sequence: 1,
      snapshot: attribute(html, 'data-jsails-component-snapshot'),
      updates: {},
      action: { name: '$refresh', args: {} },
      have: { render: attribute(html, 'data-jsails-component-render'), slots },
    }),
  };
}

/** The bytes the idle poll adds to its own token; above 1 KiB the scenario fails. */
function pollFacts(request) {
  const { snapshot } = JSON.parse(request.body);
  const over = Buffer.byteLength(request.body) - Buffer.byteLength(snapshot);
  if (over > MAX_REQUEST_BYTES_OVER_SNAPSHOT) {
    throw new Error(
      `the poll adds ${over} bytes to its token, above ${MAX_REQUEST_BYTES_OVER_SNAPSHOT}`,
    );
  }
  return { requestBytesOverSnapshot: over };
}

export const scenarios = [
  {
    name: 'component-poll-unchanged',
    kind: 'request',
    files: {
      'jsails.app.js': APP_CONFIG,
      'components.js': COMPONENTS,
      'pages/index.js': PAGE,
    },
    prepare: idlePoll,
    requestFacts: pollFacts,
    expectStatus: 200,
    drivers: ['fetch'],
  },
];
