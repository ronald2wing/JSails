/**
 * A supervised candidate process for the listen-on-handle tests
 * (`serve.test.ts`): it stands for a production child a supervisor started,
 * in the test environment its parent passes. It assembles an application in
 * the directory named by its first argument; on `handle` it stands by on the
 * parent's native listening handle sent with the message, or on `{ fd }` of a
 * listening descriptor it inherited when the message names one, and reports
 * `ready` (with whether its server listens). It accepts on `accept`, answers
 * `count` with the requests it served, and closes and exits on `close`.
 */

import { publicAccess } from '../../src/api/access-ref.js';
import { createApplication, type StandbyServer } from '../../src/app/application.js';
import { validateAppConfig } from '../../src/app/config/index.js';
import type { ListenHandle } from '../../src/app/serve.js';
import { definePlugin } from '../../src/plugins/contract/define-plugin.js';

const dir = process.argv[2];
if (dir === undefined) throw new Error('standby-child needs an app directory');

let served = 0;
const routes = definePlugin({
  name: 'standby-routes',
  setup({ routes: registrar }) {
    registrar.add({
      methods: ['GET'],
      path: '/pid',
      access: publicAccess('standby test'),
      handler: () => {
        served += 1;
        return new Response(String(process.pid));
      },
    });
  },
})();

const app = await createApplication(
  validateAppConfig({ rootDir: dir, plugins: { use: [routes] } }, { cwd: dir }),
);
let standby: StandbyServer | undefined;

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

process.on('message', (message: { type?: string; fd?: number }, sent?: ListenHandle) => {
  const run = async (): Promise<void> => {
    const handle = sent ?? (message.fd === undefined ? undefined : { fd: message.fd });
    if (message.type === 'handle' && handle !== undefined) {
      standby = await app.standby({ handle });
      send({ type: 'ready', listening: standby.server.listening });
    } else if (message.type === 'count') {
      send({ type: 'count', served });
    } else if (message.type === 'accept' && standby !== undefined) {
      const accepted = await standby.accept();
      send({ type: 'accepted', port: accepted.port });
    } else if (message.type === 'close') {
      await app.close();
      process.disconnect?.();
    }
  };
  run().catch((error: unknown) => {
    send({ type: 'failed', name: error instanceof Error ? error.name : 'unknown' });
    process.exitCode = 1;
    process.disconnect?.();
  });
});

send({ type: 'started' });
