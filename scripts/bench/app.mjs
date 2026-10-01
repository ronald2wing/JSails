/**
 * The framework side of the bench: a throwaway project, the application the
 * production `serve` path builds from it (the kernel's `loadApp` then
 * `createApplication`, from the repo's `core/dist`), and the two request
 * drivers:
 *
 * - `fetch`: `Application.fetch`, the in-process pipeline;
 * - `listener`: the real `node:http` request listeners of `Application.serve()`
 *   (the Node adapter plus the server's own request tracking), driven over an
 *   in-memory socket (`collectors/listener.mjs`), so the adapter's header
 *   copying and body writing are measured without a network.
 *
 * Nothing here imports the framework statically: the bench child installs the
 * collectors first, then loads the framework through these functions.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { writeProject } from '../import-graph/scenarios.mjs';

export const ORIGIN = 'http://localhost';

/** Writes a scenario's project files into a new directory linked to `core/`. */
export function createProject(root, files) {
  return writeProject(root, files);
}

/** The application `jsails serve` would build for the project in `dir`. */
export async function openApp(root, dir) {
  const dist = join(root, 'core', 'dist', 'src');
  const { loadApp } = await import(pathToFileURL(join(dist, 'kernel', 'load-app.js')).href);
  const { createApplication } = await import(
    pathToFileURL(join(dist, 'app', 'application.js')).href
  );
  const app = await loadApp({ cwd: dir, env: {} });
  return createApplication(app);
}

/** A fresh `Request` for a scenario's request description. */
export function requestFor({ path, method = 'GET', headers = {}, body }) {
  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}

/** The `fetch` driver: `{ send, close }`. */
export function fetchDriver(app, request) {
  return {
    async send() {
      const response = await app.fetch(requestFor(request));
      const body = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, bytes: body.byteLength };
    },
    close: () => app.close(),
  };
}

/**
 * The `listener` driver: serves the app (assembly, serve hooks, a loopback
 * listen on the configured port 0) and drives its request listeners directly.
 */
export async function listenerDriver(app, request, collectors) {
  const handle = await app.serve();
  // The Node adapter installs its own global Response when its listener is
  // created; count constructions through it as well.
  collectors.adoptGlobals();
  const { driveListener } = await import('./collectors/listener.mjs');
  const listeners = handle.server.listeners('request');
  const listener = (req, res) => {
    for (const each of listeners) each.call(handle.server, req, res);
  };
  return {
    async send() {
      const result = await driveListener(listener, requestFor(request));
      return { status: result.status, bytes: result.body.byteLength };
    },
    close: () => handle.close(),
  };
}
