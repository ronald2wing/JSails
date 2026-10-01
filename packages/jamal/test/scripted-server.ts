/**
 * A scripted server for the verb tests: it answers the commands a verb sends
 * to read the host (the framed host state, the app's containers, the proxy's
 * routes and image, the ssh user's home) from a {@link HostSpec}, takes and
 * releases the deploy lock (recording each lock op's kind), unwraps a command
 * fenced by the lock, and records every other command with its stdin,
 * answered by the test. So a verb test
 * asserts the commands the verb itself sends, against a host it describes in
 * one line.
 */

import type { JamalConfig } from '../src/config/index.js';
import { encodeHostState } from '../src/production/host-state.js';
import {
  hostManifestFile,
  hostSecretsFilePath,
  hostStateFile,
} from '../src/production/host-layout.js';
import { encodeManifest } from '../src/production/manifest.js';
import { APP_CONTAINERS_FORMAT } from '../src/production/observe.js';
import type { CommandResult } from '../src/production/process-runner.js';
import { PROXY_IMAGE_DEFAULT, proxyListArgv } from '../src/production/proxy.js';
import {
  NO_SUCH_CONTAINER_EXIT,
  decodeRemoteOp,
  remoteOpArgv,
} from '../src/production/remote-op.js';
import type { RemoteRunner } from '../src/production/transport.js';
import {
  imageOf,
  manifestOf,
  release,
  webContainer,
  type HostSpec,
} from './production/host-observation.js';

/** One command a verb sent. */
export interface ScriptedCall {
  readonly server: string;
  /** The argv, a fenced command's inner one. */
  readonly remoteArgv: string[];
  /** The stdin, without a fenced command's token line. */
  readonly stdin?: Buffer;
  /** Whether it arrived fenced by the deploy lock. */
  readonly fenced: boolean;
}

/** Options for {@link scriptedServer}. */
export interface ScriptedServerOptions {
  readonly config: JamalConfig;
  /** The host the reads report; by default release 1 is live (and served, when routed). */
  readonly host?: HostSpec;
  /** The answer to a recorded command; exit 0 with no output by default. */
  readonly answer?: (remoteArgv: readonly string[]) => Partial<CommandResult> | undefined;
}

/** The host a verb test reads by default: release 1 live, its container running. */
export function liveHost(config: JamalConfig): HostSpec {
  const routed = config.production?.domain !== undefined;
  return {
    releases: [1],
    state: { v: 1, seq: 1, live: release(1), previous: null, updatedAt: 't', by: 'b' },
    containers: [1],
    ...(routed ? { serving: 1 } : {}),
  };
}

/** The framed `host.read-state` dump of `spec`. */
function stateDump(config: JamalConfig, spec: HostSpec): Buffer {
  const service = config.service;
  const destination = config.production?.destination;
  const frames: Buffer[] = [];
  const file = (path: string, bytes: Uint8Array): void => {
    frames.push(Buffer.from(`F ${bytes.length} ${path}\n`), Buffer.from(bytes));
  };
  if (spec.state === 'unreadable')
    file(hostStateFile(service, destination), Buffer.from('{"v":0}\n'));
  else if (spec.state !== undefined)
    file(hostStateFile(service, destination), encodeHostState(spec.state));
  const releases = (spec.releases ?? []).map((entry) =>
    typeof entry === 'number' ? ([entry, undefined] as const) : entry,
  );
  for (const [n, previous] of releases) {
    file(
      hostManifestFile(service, destination, release(n)),
      encodeManifest(manifestOf(config, n, previous)),
    );
  }
  for (const [n] of releases) {
    if (spec.secretsGone?.includes(n) === true) continue;
    frames.push(
      Buffer.from(`E ${hostSecretsFilePath(service, destination, release(n), 'secrets.json')}\n`),
    );
  }
  return Buffer.concat(frames);
}

/** The `docker ps` lines of the app's containers. */
function containerLines(config: JamalConfig, spec: HostSpec): string {
  return (spec.containers ?? [])
    .map((entry) => (typeof entry === 'number' ? { n: entry } : entry))
    .map(
      ({ n, state }) =>
        `${JSON.stringify({
          name: webContainer(config, n),
          state: state ?? 'running',
          image: imageOf(config, n),
          release: release(n),
          role: 'web',
          destination: config.production?.destination ?? '',
        })}\n`,
    )
    .join('');
}

/** What `docker exec` prints when kamal-proxy is down. */
const PROXY_DOWN_STDERR = {
  stopped: 'Error response from daemon: container 0123abcd is not running\n',
  missing: 'Error response from daemon: No such container: kamal-proxy\n',
} as const;

/** kamal-proxy's `list` table for `spec`. */
function proxyListing(config: JamalConfig, spec: HostSpec): string {
  const serving = spec.serving;
  const header = 'Service  Host  Path  Target  State  TLS\n';
  if (serving === undefined || serving === null) return header;
  const target = typeof serving === 'number' ? webContainer(config, serving) : serving;
  return `${header}${config.service}  example.com  /  ${target}:3000  running  yes\n`;
}

/** A scripted server for `options.config`, and the commands the verb sent. */
export function scriptedServer(options: ScriptedServerOptions): {
  remote: RemoteRunner;
  calls: ScriptedCall[];
  locks: string[];
} {
  const { config } = options;
  const spec = options.host ?? liveHost(config);
  const calls: ScriptedCall[] = [];
  const locks: string[] = [];
  const done = (stdout = '', exitCode = 0): CommandResult => ({ exitCode, stdout, stderr: '' });
  const remote: RemoteRunner = {
    async run(server, remoteArgv, runOptions) {
      const call = typeof runOptions === 'string' ? { stdin: runOptions } : (runOptions ?? {});
      const decoded = decodeRemoteOp(remoteArgv);
      const fenced = decoded?.kind === 'fenced';
      const op = decoded?.kind === 'fenced' ? decoded.op : decoded;
      const argv = op === undefined ? [...remoteArgv] : [...remoteOpArgv(op)];
      switch (op?.kind) {
        case 'host.read-state':
          call.stdoutTo?.end(stateDump(config, spec));
          return done();
        case 'host.home':
          return done('/home/deploy\n');
        case 'lock.acquire':
          locks.push(op.kind);
          return done('1\n');
        case 'lock.release':
        case 'lock.force-release':
          locks.push(op.kind);
          return done();
        case 'container.image-digest':
          return spec.proxy === 'missing' ||
            (spec.proxy === undefined && spec.serving === undefined)
            ? done('', NO_SUCH_CONTAINER_EXIT)
            : done(`["${PROXY_IMAGE_DEFAULT}"]\n`);
        case 'docker':
          if (argv[1] === 'ps' && argv.includes(APP_CONTAINERS_FORMAT)) {
            return done(containerLines(config, spec));
          }
          // The proxy is read only for a host that says what it serves, or
          // that it is down, answered as `docker exec` answers then.
          if (argv.join(' ') === proxyListArgv().join(' ')) {
            if (spec.proxy !== undefined) {
              return { exitCode: 1, stdout: '', stderr: PROXY_DOWN_STDERR[spec.proxy] };
            }
            if (spec.serving !== undefined) return done(proxyListing(config, spec));
          }
          break;
        default:
          break;
      }
      let stdin: Buffer | undefined;
      if (call.stdinFrom !== undefined) {
        const chunks: Buffer[] = [];
        for await (const chunk of call.stdinFrom) chunks.push(Buffer.from(chunk as Buffer));
        stdin = Buffer.concat(chunks);
      } else if (call.stdin !== undefined) {
        stdin = Buffer.from(call.stdin);
      }
      if (fenced && stdin !== undefined) stdin = stdin.subarray(stdin.indexOf(0x0a) + 1);
      calls.push({ server, remoteArgv: argv, fenced, ...(stdin === undefined ? {} : { stdin }) });
      const answer = options.answer?.(argv) ?? {};
      return {
        exitCode: answer.exitCode ?? 0,
        stdout: answer.stdout ?? '',
        stderr: answer.stderr ?? '',
      };
    },
  };
  return { remote, calls, locks };
}
