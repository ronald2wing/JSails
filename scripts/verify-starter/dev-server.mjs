/**
 * The `jsails dev` stage: a real dev toolchain run against the admin fixture,
 * driven through its printed `Serving at` URLs. The port changes on every
 * restart because the app runs with `PORT=0`, and the tsc-watch initial emit
 * triggers a benign restart whose first URL is already dead by the time a
 * client connects, so a URL is handed out only once it has been confirmed
 * live. The stage proves the initial build, a backend restart after a page
 * edit, a newly added route, and a Vite CSS rebuild that reloads the browser
 * by itself, then that teardown leaves no child process behind.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertElementText, openQaPage, runBrowserQa } from './browser.mjs';
import { ADMIN_FIXTURE, installedCli } from './fixtures.mjs';
import { killLeakedProcesses, settleProcessTree, snapshotProcessTree } from './process-tree.mjs';
import { sleep, spawnPiped, stopChild } from './processes.mjs';

/** Dev toolchain boot (initial tsc + vite build + watcher + serve) budget. */
const BOOT_TIMEOUT_MS = 180_000;
/** Budget for a backend restart or a Vite asset rebuild. */
const RESTART_TIMEOUT_MS = 90_000;
/** Grace given to the dev parent so its runtime tears down its children. */
const STOP_GRACE_MS = 8_000;
/** Budget for leaked child processes to exit before being reported. */
const LEAK_SETTLE_MS = 12_000;
/**
 * Quiet period with no new `Serving at` URL before the latest URL is probed
 * as live; this window absorbs the initial-emit restart burst before a client
 * is handed the port.
 */
const QUIESCENCE_MS = 2500;
/** Poll interval for new URLs and for retrying the bounded 2xx liveness probe. */
const PROBE_INTERVAL_MS = 100;

/** Matches each `Serving at http://127.0.0.1:<port>/` the dev toolchain prints. */
const SERVE_URL_PATTERN = /Serving at (https?:\/\/\S+)/g;

/**
 * The compiled readiness tracker from `core/dist`, loaded on first use: it
 * exists only once the `build-root` stage has run, so it must never be
 * imported at module load.
 */
let readinessModule = null;
function getReadinessModule() {
  readinessModule ??= import(new URL('../../core/dist/src/dev/readiness.js', import.meta.url).href);
  return readinessModule;
}

/**
 * Spawns the dev toolchain and resolves with a handle once the latest
 * `Serving at` URL is confirmed live. `waitForUrl()` resolves with each later
 * restart's live URL; `stop()` tears the parent down with a bounded
 * SIGTERM/SIGKILL grace so its runtime can dispose of its own child groups.
 */
async function spawnDevServer({ cmd, args, cwd, env, label }) {
  const { DevUrlTracker } = await getReadinessModule();
  return new Promise((resolve, reject) => {
    const child = spawnPiped(cmd, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let exited = null;
    let seenUrls = 0;
    const outputTails = () =>
      `stdout=${JSON.stringify(stdout.slice(-800))} stderr=${JSON.stringify(stderr.slice(-800))}`;

    const tracker = new DevUrlTracker({
      quiescenceMs: QUIESCENCE_MS,
      pollIntervalMs: PROBE_INTERVAL_MS,
    });
    const aborted = () => exited !== null;
    const waitForUrl = (timeoutMs = RESTART_TIMEOUT_MS) =>
      tracker.waitForLive({ timeoutMs, aborted }).then((live) => live.url);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const found = [...stdout.matchAll(SERVE_URL_PATTERN)];
      while (seenUrls < found.length) {
        tracker.noteUrl(found[seenUrls][1]);
        seenUrls += 1;
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label}: failed to spawn: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `${label}: exited before a live Serving URL was confirmed (code=${code} signal=${signal}); ${outputTails()}`,
        ),
      );
    });

    tracker.waitForLive({ timeoutMs: BOOT_TIMEOUT_MS, aborted }).then(
      (live) => {
        if (settled) return;
        settled = true;
        resolve({
          firstUrl: live.url,
          waitForUrl,
          pid: child.pid,
          stop: () => stopChild(child, STOP_GRACE_MS),
        });
      },
      (error) => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`${label}: ${error.message}; ${outputTails()}`));
      },
    );
  });
}

/**
 * Inserts a marker element as the last child of the home page's `<UiLayout>`
 * shell: the starter renders its pages inside that shared shell, so there is
 * no literal `</body>` to anchor on.
 */
function addDevMarkerToIndex(marker) {
  const indexPath = join(ADMIN_FIXTURE.dir, 'pages', 'index.tsx');
  const content = readFileSync(indexPath, 'utf8');
  if (content.includes('<div id="dev-marker">')) {
    throw new Error('pages/index.tsx already carries a dev marker; the fixture is not clean');
  }
  const replaced = content.replace(
    '</UiLayout>',
    `      <div id="dev-marker">${marker}</div>\n    </UiLayout>`,
  );
  if (replaced === content) {
    throw new Error('could not locate </UiLayout> in pages/index.tsx');
  }
  writeFileSync(indexPath, replaced);
}

/** A minimal second page compiled by `tsc --watch` and served as `/added`. */
const ADDED_PAGE_SOURCE = `export default function AddedPage() {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Added Route</title>
      </head>
      <body>
        <h1 id="added-route-marker">added-route-ok</h1>
      </body>
    </html>
  );
}
`;

/** Appends a custom-property rule to the stylesheet for the Vite rebuild check. */
function appendCustomProperty(propName, value) {
  const stylesPath = join(ADMIN_FIXTURE.dir, 'ui', 'styles.css');
  writeFileSync(
    stylesPath,
    `${readFileSync(stylesPath, 'utf8')}\n:root {\n  ${propName}: ${value};\n}\n`,
  );
}

/** Polls a file until it contains `needle`, bounded by `timeoutMs`. */
async function waitForFileToContain(filePath, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let content = '';
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      // The Vite rebuild momentarily empties/replaces the file; keep waiting.
    }
    if (content.includes(needle)) return;
    await sleep(250);
  }
  throw new Error(
    `timed out after ${timeoutMs} ms waiting for ${filePath} to contain ${JSON.stringify(needle)}`,
  );
}

/**
 * Proves the page links and has loaded the app stylesheet before the CSS
 * mutation. The reload check reads a custom property from that stylesheet,
 * so a page without it (a bare route) would never observe the rebuilt value
 * even after a correct reload.
 */
async function assertAppStylesheetLoaded(page, url) {
  const stylesheet = await page.evaluate(() => {
    const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find((candidate) => {
      const href = candidate.getAttribute('href');
      return href !== null && new URL(href, document.baseURI).pathname === '/assets/app.css';
    });
    if (link === undefined) return { found: false, loaded: false, href: null };
    return { found: true, loaded: link.sheet !== null, href: link.getAttribute('href') };
  });
  if (!stylesheet.found || !stylesheet.loaded) {
    throw new Error(
      `page ${url} does not have a loaded /assets/app.css stylesheet ` +
        `(found=${stylesheet.found}, loaded=${stylesheet.loaded}, ` +
        `href=${JSON.stringify(stylesheet.href)}); the CSS reload check requires ` +
        `a page that links the app stylesheet`,
    );
  }
}

/**
 * Exercises the live dev toolchain: initial smoke, an edited page picked up
 * after a backend restart, a newly added route, and a CSS custom property
 * rebuilt by Vite and observed after the browser's own reload. Returns a
 * human-readable summary.
 */
async function exerciseDevServer(dev) {
  const facts = [];

  // 1. Initial smoke against the first Serving URL (same port serves assets).
  const initial = await runBrowserQa(dev.firstUrl);
  facts.push(`initial smoke at ${dev.firstUrl} (bg ${initial.styles.backgroundColor})`);

  // 2. Edit the owned pages/index.tsx and wait for the backend restart.
  const marker = `DEV_MARKER_${Date.now().toString(36)}`;
  addDevMarkerToIndex(marker);
  const afterIndexEditUrl = await dev.waitForUrl();
  facts.push(`restarted at ${afterIndexEditUrl} after pages/index.tsx edit`);
  await assertElementText(afterIndexEditUrl, '#dev-marker', marker);

  // 3. Add a new pages/added.tsx route; it is compiled and served automatically.
  writeFileSync(join(ADMIN_FIXTURE.dir, 'pages', 'added.tsx'), ADDED_PAGE_SOURCE);
  const afterAddedRouteUrl = await dev.waitForUrl();
  facts.push(`restarted at ${afterAddedRouteUrl} after pages/added.tsx`);
  await assertElementText(
    new URL('/added', afterAddedRouteUrl).href,
    '#added-route-marker',
    'added-route-ok',
  );

  // 4. Edit ui/styles.css and prove the browser reloads itself. No explicit
  //    page.reload() here: the whole point is that a client-only change bumps
  //    the build generation, the SSE stream reports it, and the injected script
  //    reloads the page. A manual reload would pass even with the feature
  //    removed, so the assertion is a poll on the live page.
  //
  //    The value is an identifier token, not a number: lightningcss (Vite's CSS
  //    minifier) re-serializes bare integers with float32 precision (8675309
  //    becomes 8675310), which would make the assertion depend on minifier
  //    internals.
  const cssProp = '--jsails-verify-marker';
  const cssValue = 'jsails-verify-marker-ok';
  const appCss = join(ADMIN_FIXTURE.dir, 'public', 'assets', 'app.css');
  // The CSS mutation is observed through the app stylesheet, so the page must
  // be one that links it: the home page renders through UiLayout and carries
  // /assets/app.css, while the added route is a bare HTML page. The root comes
  // from the current serving URL, not dev.firstUrl, because PORT=0 rebinds on
  // every restart.
  const homeUrl = new URL('/', afterAddedRouteUrl).href;
  const page = await openQaPage();
  try {
    await page.goto(homeUrl, { waitUntil: 'load' });
    await assertAppStylesheetLoaded(page, homeUrl);
    // The reload client is injected by the dev server, not by a template.
    const injected = await page.evaluate(() => typeof window.__jsailsDevGeneration);
    if (injected !== 'number') {
      throw new Error(
        `expected the dev reload script to set __jsailsDevGeneration, got ${injected}`,
      );
    }
    appendCustomProperty(cssProp, cssValue);
    await waitForFileToContain(appCss, cssProp, RESTART_TIMEOUT_MS);
    // Poll the same page object: a reload keeps it, so a value that appears
    // without any navigation from us can only come from the reload script.
    await page.waitForFunction(
      (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() !== '',
      cssProp,
      { timeout: RESTART_TIMEOUT_MS },
    );
    const value = await page.evaluate((name) => {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }, cssProp);
    if (value !== cssValue) {
      throw new Error(
        `expected custom property ${cssProp} = ${JSON.stringify(cssValue)}, got ${JSON.stringify(value)} after auto-reload`,
      );
    }
    facts.push(`ui/styles.css change auto-reloaded the browser (no manual reload)`);
  } finally {
    await page.close();
  }

  return facts.join('; ');
}

/**
 * Runs `jsails dev` on the admin fixture, exercises it, and tears it down.
 * The owned process tree is snapshotted before teardown (afterwards the
 * detached children re-parent to init and would hide from a walk), and only
 * those captured descendants are checked and, with the starttime guard, killed.
 */
export async function runDevServerStage() {
  let dev = null;
  let failure = null;
  let summary = '';
  let before = null;
  try {
    dev = await spawnDevServer({
      cmd: process.execPath,
      args: [installedCli(ADMIN_FIXTURE.dir), 'dev', '--config', 'jsails.app.js'],
      cwd: ADMIN_FIXTURE.dir,
      env: { PORT: '0' },
      label: 'jsails dev',
    });
    summary = await exerciseDevServer(dev);
  } catch (error) {
    failure = error;
  } finally {
    if (dev !== null) {
      before = snapshotProcessTree([dev.pid]);
      try {
        await dev.stop();
      } catch (stopError) {
        failure ??= stopError;
      }
    }
  }
  const leaked = before === null ? [] : await settleProcessTree(before, LEAK_SETTLE_MS);
  if (leaked.length > 0) {
    killLeakedProcesses(leaked);
    failure ??= new Error(
      `jsails dev leaked ${leaked.length} child process(es) after teardown: ` +
        leaked.map((entry) => entry.pid).join(', '),
    );
  }
  if (failure !== null) throw failure;
  return summary;
}
