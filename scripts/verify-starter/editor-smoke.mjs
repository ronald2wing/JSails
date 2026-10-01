/**
 * Test-only pages and a Playwright spec injected into the admin fixture, never
 * part of the shipped starter. The pages render `RichTextField` (from
 * `@jsails/editor/server`) inside a GET form whose target page reads the
 * submitted field with `parseRichText` and renders it with `renderRichText`,
 * so the spec checks the whole path in Chromium: the island hydrates the
 * server markup, the author types, formats, links and ticks a task, the
 * form's `formdata` event carries the document, and the rendered post HTML
 * is what the author made.
 *
 * The spec also pastes clipboard HTML with a `javascript:` link, an
 * `<img onerror>` and Word markup (nothing runs, nothing unsafe reaches the
 * document), shows the read-only panel for a stored value `parseRichText`
 * refuses (a submit omits the field until "discard and start empty"), and
 * runs axe-core (`JSAILS_AXE_PATH`, the root checkout's `axe.min.js`) over
 * the editing and the unreadable states.
 *
 * State 1 runs against a stored document: with the client entry answered by
 * an empty script (the island never hydrates), with the lazy editor chunk
 * answered by a 404, and with the editor failing to mount, a submit sends the
 * source input's bytes, which the result page echoes (`#editor-smoke-body`)
 * and renders.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FORM_PAGE_PATH = 'pages/editor-smoke.tsx';
const INVALID_PAGE_PATH = 'pages/editor-smoke-invalid.tsx';
const STORED_PAGE_PATH = 'pages/editor-smoke-stored.tsx';
const RESULT_PAGE_PATH = 'pages/editor-smoke-result.tsx';
const SPEC_PATH = 'test/browser/editor.spec.ts';

/** A page holding one rich-text field for `value` in a GET form to the result page. */
function formPage(component, title, value) {
  return `import type { RequestContext } from 'jsails';
import { RichTextField } from '@jsails/editor/server';
import { loadLayout, UiLayout, type LayoutAssets } from '../ui/layout.js';

export interface ${component}Props {
  assets?: LayoutAssets;
}

export function load(context: RequestContext): ${component}Props {
  return { assets: loadLayout(context) };
}

export default function ${component}({ assets }: ${component}Props) {
  return (
    <UiLayout title="${title}" assets={assets}>
      <main>
        <h1>${title}</h1>
        <form id="editor-smoke-form" method="get" action="/editor-smoke-result">
          <RichTextField name="body" value={${value}} label="Post body" id="smoke-body" />
          <button type="submit">Save post</button>
        </form>
      </main>
    </UiLayout>
  );
}
`;
}

const FORM_PAGE_SOURCE = formPage('EditorSmokePage', 'Editor smoke', '{ version: 2, blocks: [] }');

const INVALID_PAGE_SOURCE = formPage(
  'EditorSmokeInvalidPage',
  'Editor smoke (unreadable)',
  "{ version: 2, blocks: [{ type: 'cta', label: 'Go', href: 'javascript:alert(1)' }] }",
);

const STORED_PAGE_SOURCE = formPage(
  'EditorSmokeStoredPage',
  'Editor smoke (stored)',
  "{ version: 2, blocks: [{ type: 'paragraph', content: [{ text: 'Stored <body> & ' }, { text: 'bold', marks: ['bold'] }, { text: ' link', href: '/docs' }] }] }",
);

const RESULT_PAGE_SOURCE = `import type { RequestContext } from 'jsails';
import { renderRichText } from '@jsails/editor/server';
import { parseRichText } from 'jsails/rich-text';
import { loadLayout, UiLayout, type LayoutAssets } from '../ui/layout.js';

export interface EditorSmokeResultProps {
  assets?: LayoutAssets;
  /** \`absent\` when no field was submitted, \`unreadable\` when it did not parse. */
  outcome: 'absent' | 'unreadable' | 'rendered';
  /** The submitted field's text, as received. */
  body?: string;
  html?: string;
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function load(context: RequestContext): EditorSmokeResultProps {
  const assets = loadLayout(context);
  const body = context.url.searchParams.get('body');
  if (body === null) {
    return { assets, outcome: 'absent' };
  }
  const parsed = parseRichText(readJson(body));
  return parsed.ok
    ? { assets, outcome: 'rendered', body, html: renderRichText(parsed.value) }
    : { assets, outcome: 'unreadable', body };
}

export default function EditorSmokeResultPage({
  assets,
  outcome,
  body,
  html,
}: EditorSmokeResultProps) {
  return (
    <UiLayout title="Editor smoke result" assets={assets}>
      <main>
        <h1>Editor smoke result</h1>
        <p id="editor-smoke-outcome">{outcome}</p>
        {body !== undefined && <pre id="editor-smoke-body">{body}</pre>}
        {html !== undefined && <article id="rendered" dangerouslySetInnerHTML={{ __html: html }} />}
      </main>
    </UiLayout>
  );
}
`;

const SPEC_SOURCE = `import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.js';

interface AxeViolation {
  id: string;
  nodes: { target: string[] }[];
}

/** The WCAG 2.1 A and AA violations axe-core finds inside the smoke form. */
async function axeViolations(page: Page): Promise<string[]> {
  const axePath = process.env.JSAILS_AXE_PATH;
  if (axePath === undefined || axePath === '') {
    throw new Error('JSAILS_AXE_PATH must name axe-core\\'s axe.min.js');
  }
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const axe = (window as unknown as {
      axe: { run(context: Element, options: object): Promise<{ violations: AxeViolation[] }> };
    }).axe;
    const form = document.querySelector('#editor-smoke-form');
    if (form === null) throw new Error('no smoke form');
    const result = await axe.run(form, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return result.violations;
  });
  return violations.map((violation) => \`\${violation.id}: \${violation.nodes.map((node) => node.target.join(' ')).join(', ')}\`);
}

async function gotoEditor(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-jsails-island="rich-text"] [data-state="editing"]')).toBeVisible();
  await expect(page.locator('[data-rich-text-source]')).toHaveCount(0);
}

test('the rich-text field edits, submits and renders a post', async ({ page }) => {
  await gotoEditor(page, '/editor-smoke');
  const surface = page.getByRole('textbox', { name: 'Post body' });
  await surface.click();

  await page.keyboard.type('Hello ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('bold');
  await page.keyboard.press('Control+b');
  await page.keyboard.type(' and Docs');
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog');
  const href = dialog.getByRole('textbox');
  await expect(href).toBeFocused();
  await href.fill('javascript:alert(1)');
  await href.press('Enter');
  await expect(href).toHaveAttribute('aria-invalid', 'true');
  await href.fill('/docs');
  await href.press('Enter');
  await expect(dialog).toBeHidden();

  await surface.click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Task list' }).click();
  await page.keyboard.type('Ship it');
  await page.getByRole('checkbox', { name: 'Not done' }).click();
  await expect(page.getByRole('checkbox', { name: 'Done' })).toBeChecked();

  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole('button', { name: 'Save post' }).click();
  await page.waitForURL(/\\/editor-smoke-result\\?/);
  await expect(page.locator('#editor-smoke-outcome')).toHaveText('rendered');
  const rendered = page.locator('#rendered');
  await expect(rendered.locator('p strong')).toHaveText('bold');
  await expect(rendered.locator('p a[href="/docs"]')).toHaveText('Docs');
  await expect(rendered.locator('p').first()).toHaveText('Hello bold and Docs');
  await expect(rendered.locator('ul.jsails-task-list li')).toHaveText('Ship it');
  await expect(rendered.locator('ul.jsails-task-list input[type="checkbox"]')).toBeChecked();
});

test('pasted HTML keeps its text and loses everything unsafe', async ({ page }) => {
  await gotoEditor(page, '/editor-smoke');
  await page.getByRole('textbox', { name: 'Post body' }).click();
  await page.evaluate(() => {
    const html = [
      '<p>Click <a href="javascript:window.__smokePwned=1">here</a> or <a href="/ok">there</a>',
      '<img src="/missing.png" onerror="window.__smokePwned=2"></p>',
      '<p class=MsoNormal><span style="mso-bidi-font-weight:bold"><b>Word text</b><o:p></o:p></span></p>',
    ].join('');
    const data = new DataTransfer();
    data.setData('text/html', html);
    data.setData('text/plain', 'Click here or there Word text');
    const target = document.querySelector('[role="textbox"]');
    if (target === null) throw new Error('no editor');
    target.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await page.getByRole('button', { name: 'Save post' }).click();
  await page.waitForURL(/\\/editor-smoke-result\\?/);
  await expect(page.locator('#editor-smoke-outcome')).toHaveText('rendered');
  const html = await page.locator('#rendered').innerHTML();
  expect(html).toContain('Click here or');
  expect(html).toContain('<a href="/ok">there</a>');
  expect(html).toContain('<strong>Word text</strong>');
  expect(html).not.toMatch(/javascript:|onerror|<img|mso-|<o:p|MsoNormal/i);
  expect(await page.evaluate(() => (window as unknown as { __smokePwned?: number }).__smokePwned)).toBeUndefined();
});

/** The stored page's source input: present, named \`body\`, and its bytes. */
async function storedSource(page: Page): Promise<string> {
  const source = page.locator('[data-rich-text-source]');
  await expect(source).toHaveCount(1);
  await expect(source).toHaveAttribute('name', 'body');
  const value = await source.getAttribute('value');
  if (value === null || value === '') throw new Error('the source input holds no document');
  return value;
}

/** Submit the smoke form and check the result received \`bytes\` and rendered them. */
async function expectRoundTrip(page: Page, bytes: string): Promise<void> {
  await page.getByRole('button', { name: 'Save post' }).click();
  await page.waitForURL(/\\/editor-smoke-result\\?/);
  await expect(page.locator('#editor-smoke-outcome')).toHaveText('rendered');
  await expect(page.locator('#editor-smoke-body')).toHaveText(bytes, { useInnerText: false });
  const rendered = page.locator('#rendered');
  await expect(rendered.locator('p')).toHaveText('Stored <body> & bold link');
  await expect(rendered.locator('p strong')).toHaveText('bold');
  await expect(rendered.locator('p a[href="/docs"]')).toHaveText('link');
}

test('a submit before the island hydrates sends the stored bytes back (state 1)', async ({ page }) => {
  // The client entry answers with an empty module: the page stays as the
  // server rendered it, as for a reader whose bundle has not run yet.
  await page.route(
    (url) => url.pathname === '/assets/app.js',
    (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
  );
  await page.goto('/editor-smoke-stored', { waitUntil: 'load' });
  await expect(page.locator('[data-jsails-island="rich-text"] [data-state="loading"]')).toContainText('needs JavaScript');
  await expect(page.getByRole('textbox', { name: 'Post body' })).toHaveCount(0);
  const bytes = await storedSource(page);
  expect(JSON.parse(bytes)).toEqual({
    version: 2,
    blocks: [{ type: 'paragraph', content: [{ text: 'Stored <body> & ' }, { text: 'bold', marks: ['bold'] }, { text: ' link', href: '/docs' }] }],
  });
  await expectRoundTrip(page, bytes);
});

test('a submit after the editor failed to mount sends the stored bytes back (state 1)', async ({ page }) => {
  // The editor is built into its host element last; a mount that throws
  // there stands for any failure the browser raises while mounting.
  await page.addInitScript(() => {
    const append = Element.prototype.append;
    Element.prototype.append = function (this: Element, ...nodes: (Node | string)[]): void {
      if (this.classList.contains('rich-text-editor-host')) throw new Error('mount failed');
      append.apply(this, nodes);
    };
  });
  await page.goto('/editor-smoke-stored', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-jsails-island="rich-text"] [data-state="failed"]')).toContainText('could not start');
  await expect(page.getByRole('textbox', { name: 'Post body' })).toHaveCount(0);
  await expectRoundTrip(page, await storedSource(page));
});

test('a submit after the editor chunk failed to load sends the stored bytes back (state 1)', async ({ page }) => {
  // The client entry runs, but the lazy editor chunk is gone (a deploy
  // replaced it, the connection dropped).
  await page.route(
    (url) => /\\/editor-runtime-[^/]*\\.js$/.test(url.pathname),
    (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: '' }),
  );
  await page.goto('/editor-smoke-stored', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-jsails-island="rich-text"] [data-state="failed"]')).toContainText('could not start');
  await expect(page.getByRole('textbox', { name: 'Post body' })).toHaveCount(0);
  await expectRoundTrip(page, await storedSource(page));
});

test('an unreadable stored value is shown read-only and kept until discarded', async ({ page }) => {
  await page.goto('/editor-smoke-invalid', { waitUntil: 'domcontentloaded' });
  const panel = page.locator('[data-jsails-island="rich-text"] [data-state="unreadable"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('listitem')).toHaveText(['blocks.0.href: link is not a path, fragment, http(s), mailto or tel URL']);
  await expect(page.getByRole('textbox', { name: 'Post body' })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole('button', { name: 'Save post' }).click();
  await page.waitForURL(/\\/editor-smoke-result/);
  await expect(page.locator('#editor-smoke-outcome')).toHaveText('absent');

  await page.goto('/editor-smoke-invalid', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Discard the stored content…' }).click();
  await page.getByRole('button', { name: 'Discard and start empty' }).click();
  await expect(page.getByRole('textbox', { name: 'Post body' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Post body' }).click();
  await page.keyboard.type('Fresh start');
  await page.getByRole('button', { name: 'Save post' }).click();
  await page.waitForURL(/\\/editor-smoke-result\\?/);
  await expect(page.locator('#rendered p')).toHaveText('Fresh start');
});
`;

/** Writes the pages and the spec into `fixtureDir`. */
export function writeEditorSmoke(fixtureDir) {
  writeFileSync(join(fixtureDir, FORM_PAGE_PATH), FORM_PAGE_SOURCE);
  writeFileSync(join(fixtureDir, INVALID_PAGE_PATH), INVALID_PAGE_SOURCE);
  writeFileSync(join(fixtureDir, STORED_PAGE_PATH), STORED_PAGE_SOURCE);
  writeFileSync(join(fixtureDir, RESULT_PAGE_PATH), RESULT_PAGE_SOURCE);
  mkdirSync(dirname(join(fixtureDir, SPEC_PATH)), { recursive: true });
  writeFileSync(join(fixtureDir, SPEC_PATH), SPEC_SOURCE);
  return 'injected editor smoke pages + Playwright spec into the fixture';
}
