/**
 * A test-only page and Playwright spec injected into the admin fixture, never
 * part of the shipped starter: the page hydrates the real `rich-text` island,
 * and the spec types into the Editor.js surface in Chromium and inspects the
 * hidden submitted document.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PAGE_PATH = 'pages/editor-smoke.tsx';
const SPEC_PATH = 'test/browser/editor.spec.ts';

const PAGE_SOURCE = `import type { RequestContext } from 'jsails';
import { loadLayout, UiLayout, type LayoutAssets } from '../ui/layout.js';

export interface EditorSmokeProps {
  assets?: LayoutAssets;
}

export async function load(context: RequestContext): Promise<EditorSmokeProps> {
  return { assets: await loadLayout(context) };
}

export default function EditorSmokePage({ assets }: EditorSmokeProps) {
  const document = { version: 1, blocks: [] };
  return (
    <UiLayout title="Editor Smoke" assets={assets}>
      <div
        id="editor-smoke"
        data-jsails-island="rich-text"
        data-jsails-props={JSON.stringify({ name: 'body', document })}
      />
    </UiLayout>
  );
}
`;

const SPEC_SOURCE = `import { expect, test } from './fixtures.js';

test('rich-text editor hydrates and persists typed text', async ({ page }) => {
  await page.goto('/editor-smoke', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('.rich-text-editor')).toBeVisible();
  const hidden = page.locator('input[name="body"]');
  await expect(hidden).toHaveCount(1);

  // Editor.js renders its editable block inside the island surface.
  const editable = page.locator('.rich-text-editor-surface [contenteditable="true"]').first();
  await expect(editable).toBeVisible();
  await editable.click();

  await page.keyboard.insertText('Hello editor');

  // A change serializes through the adapter into the hidden submitted document.
  await expect.poll(async () => hidden.inputValue()).toContain('Hello editor');
  await expect.poll(async () => hidden.inputValue()).toContain('"type":"paragraph"');
});
`;

/** Writes the page and spec into `fixtureDir`. */
export function writeEditorSmoke(fixtureDir) {
  writeFileSync(join(fixtureDir, PAGE_PATH), PAGE_SOURCE);
  mkdirSync(dirname(join(fixtureDir, SPEC_PATH)), { recursive: true });
  writeFileSync(join(fixtureDir, SPEC_PATH), SPEC_SOURCE);
  return 'injected editor smoke page + Playwright spec into the fixture';
}
