/**
 * Server-component triggers before the client has hydrated, in Chromium,
 * against the admin fixture's `/tasks` page under `jsails serve`.
 *
 * Two passes, each in a fresh page:
 *
 * - Inert: the entry bundle (`/assets/app.js`) is blocked, so no JavaScript of
 *   the app ever runs. Clicking the bound form's submit button and pressing
 *   Enter in its input must not navigate (the window survives, the URL stays,
 *   no document request is made) and must send no action: `submit()` renders
 *   the form `method="dialog"`, which outside a `<dialog>` submits nowhere.
 * - Queued: the entry runs, but the Turbo chunk it loads before mounting the
 *   component bindings is held. A submit made in that gap is prevented by the
 *   eager listener and held; once the chunk is released the bindings mount,
 *   the held submit runs exactly once, and its task appears.
 */
import { openQaPage } from './browser.mjs';

const PAGE_ROUTE = '/tasks';
const ROOT = '[data-jsails-component="task-list"]';
const UPDATE_PATH = '/_jsails/components/update';
const ENTRY_PATH = '/assets/app.js';

/** How long a trigger is given to (wrongly) navigate or send before the pass checks. */
const SETTLE_MS = 750;

/** The console line Chromium writes for the deliberately blocked entry bundle. */
const BLOCKED_ENTRY = /^Failed to load resource: net::ERR_FAILED\b/;

/** Record navigations and component updates the page makes after `arm()`. */
function watchRequests(page) {
  const seen = { navigations: [], updates: [] };
  let armed = false;
  page.on('request', (request) => {
    if (!armed) return;
    if (request.isNavigationRequest()) seen.navigations.push(request.url());
    if (new URL(request.url()).pathname === UPDATE_PATH) seen.updates.push(request.postData());
  });
  return {
    seen,
    arm() {
      armed = true;
    },
  };
}

/** Mark the window so a navigation (which replaces it) is observable. */
async function markWindow(page) {
  const token = `pre-hydration-${Date.now()}`;
  await page.evaluate((value) => {
    globalThis.__preHydrationToken = value;
  }, token);
  return token;
}

/** Throw unless the page still shows the same window at the same URL. */
async function assertStayed(page, token, url, label) {
  const kept = await page.evaluate(() => globalThis.__preHydrationToken ?? null);
  if (kept !== token) throw new Error(`${label}: the page navigated (the window was replaced)`);
  if (page.url() !== url) throw new Error(`${label}: the URL changed to ${page.url()}`);
}

function wait(page, ms) {
  return page.evaluate((delay) => new Promise((resolve) => setTimeout(resolve, delay)), ms);
}

/** The inert pass: no app script at all. */
async function runInertPass(url) {
  const page = await openQaPage();
  const errors = [];
  try {
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !BLOCKED_ENTRY.test(message.text())) {
        errors.push(`console: ${message.text()}`);
      }
    });
    await page.route(
      (target) => target.pathname === ENTRY_PATH,
      (route) => route.abort(),
    );
    const target = new URL(PAGE_ROUTE, url).href;
    await page.goto(target, { waitUntil: 'load' });
    const form = page.locator(`${ROOT} form`);
    const method = await form.getAttribute('method');
    if (method !== 'dialog') {
      throw new Error(`the bound form renders method=${JSON.stringify(method)}, not "dialog"`);
    }
    const watch = watchRequests(page);
    const token = await markWindow(page);
    watch.arm();

    await page.locator('[data-task-input]').fill('Inert task');
    await page.locator('[data-task-submit]').click();
    await wait(page, SETTLE_MS);
    await assertStayed(page, token, target, 'submit click without the bundle');
    await page.locator('[data-task-input]').press('Enter');
    await wait(page, SETTLE_MS);
    await assertStayed(page, token, target, 'Enter without the bundle');

    if (watch.seen.navigations.length > 0) {
      throw new Error(`a document request was made: ${watch.seen.navigations.join(', ')}`);
    }
    if (watch.seen.updates.length > 0) throw new Error('an action was sent without the bundle');
    if ((await page.locator(`${ROOT}[data-hydrated="true"]`).count()) !== 0) {
      throw new Error('the component hydrated although its bundle was blocked');
    }
    if (errors.length > 0) throw new Error(`browser console/page errors:\n${errors.join('\n')}`);
    return { triggers: 2 };
  } finally {
    await page.close();
  }
}

/** The queued pass: the entry runs, the Turbo chunk (and so the bindings) is held. */
async function runQueuedPass(url) {
  const page = await openQaPage();
  const errors = [];
  const held = [];
  let releasing = false;
  try {
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    // A script other than the entry is fetched, and held when it is Turbo's
    // chunk (the one that defines the `turbo-stream` element; the minifier
    // picks the quote style, so the name is matched bare), so the entry and
    // any chunk it imports statically still evaluate.
    await page.route(
      (target) => target.pathname.endsWith('.js') && target.pathname !== ENTRY_PATH,
      async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        const fulfil = () => route.fulfill({ response, body });
        if (!releasing && body.includes('turbo-stream') && body.includes('customElements.define')) {
          held.push(fulfil);
        } else {
          await fulfil();
        }
      },
    );
    const target = new URL(PAGE_ROUTE, url).href;
    await page.goto(target, { waitUntil: 'domcontentloaded' });
    const started = Date.now();
    while (held.length === 0) {
      if (Date.now() - started > 15_000) {
        throw new Error('the entry never requested a Turbo chunk to hold');
      }
      await wait(page, 25);
    }
    if ((await page.locator(`${ROOT}[data-hydrated="true"]`).count()) !== 0) {
      throw new Error('the component bound before its Turbo chunk loaded');
    }

    const watch = watchRequests(page);
    const token = await markWindow(page);
    watch.arm();
    await page.locator('[data-task-input]').fill('Queued task');
    await page.locator('[data-task-submit]').click();
    await wait(page, SETTLE_MS);
    await assertStayed(page, token, target, 'submit while the bundle loads');
    if (watch.seen.updates.length > 0) {
      throw new Error('the submit was sent before the component bindings mounted');
    }
    if ((await page.locator('[data-task-item]').count()) !== 0) {
      throw new Error('a task appeared before the component bindings mounted');
    }

    releasing = true;
    for (const fulfil of held.splice(0)) await fulfil();
    await page.waitForSelector(`${ROOT}[data-hydrated="true"]`);
    await page.waitForSelector('[data-task-item]');
    await wait(page, SETTLE_MS);
    const items = (await page.locator('[data-task-item]').allTextContents()).map((text) =>
      text.trim(),
    );
    if (JSON.stringify(items) !== JSON.stringify(['Queued task'])) {
      throw new Error(`the queued submit produced ${JSON.stringify(items)}, not ["Queued task"]`);
    }
    if (watch.seen.updates.length !== 1) {
      throw new Error(`the queued submit was sent ${watch.seen.updates.length} times, not once`);
    }
    await assertStayed(page, token, target, 'the replayed submit');
    if (watch.seen.navigations.length > 0) {
      throw new Error(`a document request was made: ${watch.seen.navigations.join(', ')}`);
    }
    if (errors.length > 0) throw new Error(`browser console/page errors:\n${errors.join('\n')}`);
    return { items: items.length };
  } finally {
    releasing = true;
    for (const fulfil of held.splice(0))
      await fulfil().catch(() => {
        // The page is closing; a held response it no longer wants is moot.
      });
    await page.close();
  }
}

/** Both passes against a served fixture at `url`; returns what they observed. */
export async function runPreHydrationQa(url) {
  const inert = await runInertPass(url);
  const queued = await runQueuedPass(url);
  return { inertTriggers: inert.triggers, queuedItems: queued.items };
}
