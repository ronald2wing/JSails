/**
 * Browser QA against a served starter: one Chromium instance shared by every
 * browser stage, a page factory that keeps the console clean, and the passes
 * that observe hydration, the counter island, the native dialog, daisyUI
 * styling, the content-hashed asset URLs, Turbo soft navigation, the live
 * server component, and the static read-only fallback. Each pass returns the
 * facts it observed and throws on the first deviation.
 */
import { existsSync } from 'node:fs';

/** The Chromium or Chrome binary the browser stages launch. */
export const BROWSER_PATH = process.env.JSAILS_BROWSER_PATH ?? '/usr/bin/chromium';

/** Budget for a single browser wait. */
const BROWSER_TIMEOUT_MS = 30_000;

/**
 * The two fixed starter assets must be emitted as root-relative URLs carrying
 * a content-derived SHA-256 query (`?v=<64 hex chars>`). The hash itself is
 * content-dependent, so it is matched by shape, never by a literal value.
 */
const HASHED_CSS_ASSET = /^\/assets\/app\.css\?v=[0-9a-f]{64}$/;
const HASHED_JS_ASSET = /^\/assets\/app\.js\?v=[0-9a-f]{64}$/;

/** The single Chromium instance reused across browser stages. */
let browser = null;

/**
 * The in-flight import+launch promise, shared by every concurrent caller.
 *
 * A plain `if (browser === null) { await launch() }` is check-then-await: two
 * stages that start together both observe `null`, both launch, and one
 * instance leaks while the launch counter over-reports. Storing the promise
 * makes the check-and-set atomic, so exactly one launch happens and every
 * caller awaits the same result.
 */
let browserLaunch = null;

let launches = 0;

/** How many times a Chromium instance was actually launched this run. */
export function browserLaunches() {
  return launches;
}

/** Launches Chromium once with the default sandbox; fails clearly when the binary is absent. */
async function getBrowser() {
  if (!existsSync(BROWSER_PATH)) {
    throw new Error(
      `Chromium binary not found at "${BROWSER_PATH}". ` +
        `Set JSAILS_BROWSER_PATH to a Chromium/Chrome executable to run browser QA; ` +
        `browser verification cannot be claimed as passing without it.`,
    );
  }
  if (browser !== null) return browser;
  if (browserLaunch === null) {
    browserLaunch = (async () => {
      const { chromium } = await import('playwright-core');
      const launched = await chromium.launch({ executablePath: BROWSER_PATH });
      browser = launched;
      launches += 1;
      return launched;
    })();
    // A failed launch must not poison later attempts: clear the slot so a retry
    // can launch again. Every caller already awaiting this promise still sees
    // the rejection, so both consumers fail honestly rather than one hanging.
    browserLaunch.catch(() => {
      browserLaunch = null;
    });
  }
  return browserLaunch;
}

/** Closes the shared browser, best-effort, so a later call can never receive a closed one. */
export async function closeBrowser() {
  if (browser !== null) {
    try {
      await browser.close();
    } catch {
      // The browser is best-effort to close; never mask the real result.
    }
    browser = null;
  }
  browserLaunch = null;
}

/** A color is transparent only when it carries a zero alpha channel. */
function isTransparent(color) {
  if (typeof color !== 'string') return false;
  if (color === 'transparent') return true;
  // Comma syntax with a zero alpha in the 4th slot (rgba/hsla only).
  if (/^(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?\s*\)\s*$/i.test(color)) return true;
  // Slash syntax with a trailing "/ 0" alpha (oklch, oklab, color, lab, lch).
  if (/\/\s*0(?:\.0+)?\s*\)\s*$/i.test(color)) return true;
  return false;
}

/**
 * A fresh page on the shared browser. The starter ships no favicon, so
 * Chromium's automatic `/favicon.ico` request is fulfilled here and a "no
 * console errors" check reports only real application failures.
 */
export async function openQaPage() {
  const page = await (await getBrowser()).newPage();
  await page.route('**/favicon.ico', (route) =>
    route.fulfill({ status: 200, contentType: 'image/x-icon', body: '' }),
  );
  page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
  return page;
}

/**
 * One full pass against `url`: hydration, the counter, the native dialog,
 * daisyUI styling, the hashed asset URLs and their responses, and a clean
 * console.
 */
export async function runBrowserQa(url) {
  const page = await openQaPage();
  const errors = [];
  try {
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('#counter-root[data-hydrated="true"]');

    const counts = [];
    counts.push((await page.textContent('[data-counter-value]'))?.trim());
    await page.click('[data-counter-increment]');
    counts.push((await page.textContent('[data-counter-value]'))?.trim());
    await page.click('[data-counter-increment]');
    counts.push((await page.textContent('[data-counter-value]'))?.trim());

    // Native <dialog>: open, Esc closes and focus returns to the trigger, then
    // the close button works on a fresh open.
    await page.click('[data-open-dialog]');
    await page.waitForFunction(() => document.querySelector('dialog')?.open === true);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('dialog')?.open === false);
    const focusReturned = await page.evaluate(() =>
      document.activeElement?.matches('[data-open-dialog]'),
    );
    await page.click('[data-open-dialog]');
    await page.waitForFunction(() => document.querySelector('dialog')?.open === true);
    await page.click('[data-close-dialog]');
    await page.waitForFunction(() => document.querySelector('dialog')?.open === false);

    const styles = await page.evaluate(() => {
      const button = document.querySelector('[data-counter-increment]');
      const computed = getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return {
        backgroundColor: computed.backgroundColor,
        height: rect.height,
        width: rect.width,
        display: computed.display,
        visibility: computed.visibility,
      };
    });

    if (JSON.stringify(counts) !== JSON.stringify(['0', '1', '2'])) {
      throw new Error(`counter did not advance 0 -> 1 -> 2 (observed ${JSON.stringify(counts)})`);
    }
    if (focusReturned !== true) {
      throw new Error('focus did not return to the open-dialog trigger after Escape');
    }
    if (styles.visibility !== 'visible' || styles.display === 'none') {
      throw new Error('counter button is not visible');
    }
    if (styles.height < 38 || styles.width < 60) {
      throw new Error(
        `counter button dimensions not daisyUI-styled: ` +
          `${styles.width.toFixed(1)}x${styles.height.toFixed(1)}px`,
      );
    }
    if (isTransparent(styles.backgroundColor)) {
      throw new Error(`counter button background is transparent (daisyUI not applied)`);
    }

    // Reading the actual `href`/`src` from the document, never a hardcoded
    // path, proves the asset resolver ran; each resolved asset must then serve
    // 200 with the right content type.
    const assetRefs = await page.evaluate(() => {
      const link = document.querySelector('link[rel="stylesheet"]');
      const script = document.querySelector('script[type="module"]');
      return {
        css: link === null ? null : link.getAttribute('href'),
        js: script === null ? null : script.getAttribute('src'),
      };
    });
    if (assetRefs.css === null || !HASHED_CSS_ASSET.test(assetRefs.css)) {
      throw new Error(
        `stylesheet href ${JSON.stringify(assetRefs.css)} is not a content-hashed /assets/app.css?v=<sha256> URL`,
      );
    }
    if (assetRefs.js === null || !HASHED_JS_ASSET.test(assetRefs.js)) {
      throw new Error(
        `module script src ${JSON.stringify(assetRefs.js)} is not a content-hashed /assets/app.js?v=<sha256> URL`,
      );
    }
    const assets = await Promise.all(
      [assetRefs.css, assetRefs.js].map(async (path) => {
        const response = await fetch(new URL(path, url));
        return {
          path,
          status: response.status,
          contentType: response.headers.get('content-type') ?? '',
        };
      }),
    );
    for (const asset of assets) {
      if (asset.status !== 200) {
        throw new Error(`${asset.path} returned HTTP ${asset.status}, expected 200`);
      }
    }
    const cssAsset = assets.find((asset) => asset.path === assetRefs.css);
    if (!cssAsset.contentType.toLowerCase().startsWith('text/css')) {
      throw new Error(
        `${assetRefs.css} served with content-type ${JSON.stringify(cssAsset.contentType)}, expected text/css`,
      );
    }

    if (errors.length > 0) {
      throw new Error(`browser console/page errors:\n${errors.join('\n')}`);
    }

    return { counts, focusReturned, styles, assets };
  } finally {
    await page.close();
  }
}

/** Navigates a fresh page to `url` and asserts `selector` renders `expectedText`. */
export async function assertElementText(url, selector, expectedText) {
  const page = await openQaPage();
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector(selector);
    const text = (await page.textContent(selector))?.trim();
    if (text !== expectedText) {
      throw new Error(
        `expected ${selector} text ${JSON.stringify(expectedText)}, got ${JSON.stringify(text)} at ${url}`,
      );
    }
  } finally {
    await page.close();
  }
}

/**
 * One navigation pass: a Turbo soft navigation from the home page to `/about`
 * swaps only the document body, so a window-scoped marker stashed before the
 * click survives. A full reload would replace the document and drop it.
 */
export async function runNavigationQa(url) {
  const page = await openQaPage();
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('#counter-root[data-hydrated="true"]');
    await page.evaluate(() => {
      globalThis.__jsailsVerifySentinel = 'alive';
    });
    await page.locator('nav a[href="/about"]').click();
    await page.waitForURL(/\/about\/?$/);
    await page.waitForSelector('h1');
    const heading = (await page.textContent('h1'))?.trim();
    const sentinel = await page.evaluate(() => globalThis.__jsailsVerifySentinel);
    if (heading !== 'About') {
      throw new Error(`expected About heading after navigation, got ${JSON.stringify(heading)}`);
    }
    if (sentinel !== 'alive') {
      throw new Error(
        'window marker did not survive the About navigation (a full reload occurred)',
      );
    }
    return { heading, sentinel };
  } finally {
    await page.close();
  }
}

/**
 * The live server component on `/tasks` under a served app: the signed
 * snapshot renders the interactive form (never the static fallback), adding a
 * task updates the list and clears the input, and a blank title returns a
 * validation error without adding an item.
 */
export async function runServerComponentQa(url) {
  const page = await openQaPage();
  try {
    await page.goto(new URL('/tasks', url).href, { waitUntil: 'load' });
    await page.waitForSelector('[data-jsails-component="task-list"][data-hydrated="true"]');

    await page.locator('[data-task-input]').fill('First task');
    await page.locator('[data-task-submit]').click();
    await page.waitForSelector('[data-task-item]');
    const items = (await page.locator('[data-task-item]').allTextContents()).map((text) =>
      text.trim(),
    );
    if (JSON.stringify(items) !== JSON.stringify(['First task'])) {
      throw new Error(`expected a single "First task" item, got ${JSON.stringify(items)}`);
    }
    const cleared = await page.locator('[data-task-input]').inputValue();
    if (cleared !== '') {
      throw new Error(`expected the task input to clear after add, got ${JSON.stringify(cleared)}`);
    }

    await page.locator('[data-task-input]').fill('   ');
    await page.locator('[data-task-submit]').click();
    await page.waitForSelector('[data-task-error]');
    const itemCountAfterError = await page.locator('[data-task-item]').count();
    if (itemCountAfterError !== 1) {
      throw new Error(`blank title added an item (count ${itemCountAfterError}, expected 1)`);
    }

    return { items: items.length, errorShown: true };
  } finally {
    await page.close();
  }
}

/**
 * The static-exported `/tasks` page served from `out/`: the read-only
 * fallback renders (no signed snapshot, CSRF, component root id, or
 * interactive form), and the counter island, mounted outside the component
 * boundary, still hydrates and works.
 */
export async function runStaticTasksQa(url) {
  const page = await openQaPage();
  try {
    await page.goto(new URL('/tasks', url).href, { waitUntil: 'load' });
    await page.waitForSelector('#counter-root[data-hydrated="true"]');

    const body = (await page.locator('body').textContent()) ?? '';
    // JSX renders the notice across source lines; collapse whitespace so the
    // check is not sensitive to the template's wrapping.
    if (!body.replace(/\s+/g, ' ').includes('not available in the static export')) {
      throw new Error('static tasks page does not render the read-only fallback notice');
    }
    // The static fallback is wrapped in a `[data-jsails-component]` root (the
    // client still needs to locate the component boundary), so that marker is
    // expected. Only the interactive mount markers (a signed snapshot, CSRF, a
    // generated component id, and the input/submit form) must be absent.
    const liveMarkers = await page.evaluate(() => ({
      snapshot: document.querySelector('[data-jsails-component-snapshot]') !== null,
      csrf: document.querySelector('[data-jsails-component-csrf]') !== null,
      rootId: document.querySelector('[id^="jsails-component-"]') !== null,
      input: document.querySelector('[data-task-input]') !== null,
      submit: document.querySelector('[data-task-submit]') !== null,
    }));
    for (const [name, present] of Object.entries(liveMarkers)) {
      if (present) {
        throw new Error(`static tasks page unexpectedly carries a live ${name} marker`);
      }
    }

    await page.locator('[data-counter-increment]').click();
    const count = (await page.textContent('[data-counter-value]'))?.trim();
    if (count !== '1') {
      throw new Error(
        `static tasks counter did not advance to 1 (observed ${JSON.stringify(count)})`,
      );
    }

    return { counter: count };
  } finally {
    await page.close();
  }
}
