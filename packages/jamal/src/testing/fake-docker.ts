/**
 * The production server's Docker engine, as a test model.
 *
 * {@link FakeDocker} keeps the state the deploy engine touches: images by
 * digest with the tags that point at them, containers (name, image digest,
 * labels, environment, state, restart count, mounts, networks), named
 * volumes, networks, and the kamal-proxy routing table. {@link FakeDocker.exec}
 * answers one `docker` argv the way the Docker CLI would, with the same exit
 * statuses the engine reads (125 for a refused `run`, 1 for a missing or
 * stopped container), and everything else is recorded as unmodelled.
 *
 * The details that decide whether a deploy is right are modelled exactly: a
 * container reads its `--env-file` once, at creation, with Docker's own line
 * format (no quoting, no escaping, `-e` wins over the file); a release's
 * secrets file is read through its bind mount the way the JSails resolver
 * reads `JSAILS_SECRETS_FILE`, and only when any uid could read it
 * ({@link FakeDocker.appEnvironment}); a `-v` source is a host path only
 * when absolute and is otherwise a volume name, as for a Docker CLI before
 * 23, so a `./` source is refused; `docker run`
 * uses the image a tag pointed at when it was last pulled, not the one the
 * registry holds now; a pull records the repository digest it resolved, which
 * `docker image inspect` reports as `RepoDigests` (for a public image named
 * by digest, the digest it names); and kamal-proxy only routes to a container
 * it can reach on a shared network and that answers its health check. An attached
 * `docker run --rm` (the deploy check) is a one-off process: it is recorded
 * with the environment it ran with, exits 0, and leaves no container.
 *
 * Commands that run inside an accessory (the backup dump, staging and loading
 * a restore) are recognized by comparing the argv with the builders in
 * `production/backup.ts`, never by reading their shell text. An accessory's
 * data is one opaque byte string on its volume; a dump is that data behind
 * the leading bytes `detectBackupKind` recognizes.
 */

import { createHash, randomBytes } from 'node:crypto';

import { JsailsError } from 'jsails/errors';

import {
  BACKUP_EXIT,
  applyDatabaseArgv,
  discardStageArgv,
  dumpArgv,
  stageArgv,
  stagePath,
  type BackupKind,
} from '../production/backup.js';
import { APP_CONTAINERS_FORMAT } from '../production/observe.js';
import { PROXY_CONTAINER_NAME } from '../production/proxy.js';
import { SERVICE_CONVENTIONS } from '../service-conventions.js';
import type { FakeFileSystem } from './fake-file-system.js';
import { imageDigest, imageRepository, type FakeRegistry } from './fake-registry.js';

/** The answer to one command: its exit status and output. */
export interface FakeOutput {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** A container's lifecycle state. */
export type FakeContainerState = 'running' | 'exited';

/** One container. */
export interface FakeContainer {
  readonly id: string;
  readonly name: string;
  /** The reference `docker run` was given. */
  readonly image: string;
  /** The digest that reference resolved to when the container was created. */
  readonly imageDigest: string;
  readonly labels: Readonly<Record<string, string>>;
  /** The environment the container started with; never re-read. */
  readonly env: Readonly<Record<string, string>>;
  readonly state: FakeContainerState;
  readonly restartCount: number;
  readonly restartPolicy: string | undefined;
  /** The `-v` specs it was created with. */
  readonly mounts: readonly string[];
  readonly networks: ReadonlySet<string>;
  readonly ports: readonly string[];
  readonly command: readonly string[];
  /** Creation order on this host, from 1. */
  readonly created: number;
}

/** One attached `docker run --rm`: what it ran, and with which environment. */
export interface FakeOneOffRun {
  /** The digest the image reference resolved to. */
  readonly imageDigest: string;
  readonly network: string;
  readonly env: Readonly<Record<string, string>>;
  /** The `-v` specs it ran with. */
  readonly mounts: readonly string[];
  readonly command: readonly string[];
}

/** What {@link FakeDocker.appEnvironment} reads: a container or a one-off run. */
export interface FakeProcessView {
  readonly env: Readonly<Record<string, string>>;
  readonly mounts: readonly string[];
}

/** Why {@link FakeDocker.appEnvironment} could not read a release's secrets file. */
export class FakeSecretsFileError extends JsailsError {
  readonly code = 'secrets_file_unreadable';
}

/** The variable naming a release's secrets file, as the JSails resolver reads it. */
const SECRETS_FILE_VARIABLE = 'JSAILS_SECRETS_FILE';

/** The one control variable a secrets file may carry; never an app variable. */
const CREDENTIALS_KEY_VARIABLE = 'JSAILS_CREDENTIALS_KEY';

/** The mode bits another uid needs: read on the file, read and search on its directory. */
const OTHER_READ = 0o004;
const OTHER_READ_SEARCH = 0o005;

/** One local image and the references that point at it. */
export interface FakeLocalImage {
  readonly digest: string;
  readonly repository: string;
  readonly tags: readonly string[];
}

/** One kamal-proxy route. */
export interface FakeRoute {
  readonly service: string;
  /** `<container>:<port>`. */
  readonly target: string;
  readonly host: string | undefined;
  readonly tls: boolean;
  readonly healthCheckPath: string | undefined;
}

/** The leading bytes of each kind's dump, as `detectBackupKind` recognizes them. */
export const FAKE_DUMP_HEADS: Readonly<Record<BackupKind, string>> = Object.freeze({
  mariadb: '-- MariaDB dump 10.19\n',
  postgres: 'PGDMP',
  valkey: 'REDIS0011',
});

/** The volume entry that holds an accessory's data. */
const VOLUME_DATA = 'data';

/** The names the Docker daemon accepts for a local volume. */
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]+$/;

/** The default bridge every container joins without `--network`. */
const DEFAULT_NETWORK = 'bridge';

/** Docker's built-in network that gives a container no interface but loopback. */
const NO_NETWORK = 'none';

const RUN_VALUED_FLAGS = new Set([
  '--name',
  '--network',
  '--restart',
  '--label',
  '-e',
  '--env-file',
  '-v',
  '-p',
  '--log-driver',
  '--log-opt',
  '--entrypoint',
]);
const RUN_BOOLEAN_FLAGS = new Set(['-d', '--rm', '-i']);

const PROXY_VALUED_FLAGS = new Set([
  '--target',
  '--host',
  '--path-prefix',
  '--health-check-path',
  '--health-check-interval',
  '--health-check-timeout',
  '--tls-on-demand-url',
  '--target-timeout',
  '--max-request-body',
  '--max-response-body',
  '--canonical-host',
  '--client-ip-header',
  '--log-request-header',
  '--log-response-header',
  '--scope-cookie',
  '--metrics-port',
]);
const PROXY_BOOLEAN_FLAGS = new Set([
  '--tls',
  '--tls-staging',
  '--strip-path-prefix',
  '--tls-redirect',
  '--forward-headers',
  '--exclude-metrics',
]);

/** Commands inside a container that only report health. */
const PROBES: readonly (readonly string[])[] = [
  ['mariadb-admin', 'ping'],
  ['pg_isready'],
  ['valkey-cli', 'ping'],
  ['varnishlog', '-c', '-n', '/tmp'],
  ['varnishreload'],
];

/**
 * Leading white space as Go's `unicode.IsSpace` defines it, which Docker
 * trims from each env-file line. It differs from JavaScript's `\s`: U+0085
 * is space and U+FEFF is not.
 */
const GO_LEADING_SPACE =
  /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;

/** The longest line Docker's env-file scanner reads, newline excluded. */
const ENV_FILE_MAX_LINE_BYTES = 64 * 1024 - 1;

type MutableContainer = {
  -readonly [K in keyof FakeContainer]: FakeContainer[K];
} & {
  readonly healthy: boolean;
  readonly networks: Set<string>;
  /** The container's writable layer: files written inside it, by absolute path. */
  readonly files: Map<string, Buffer>;
};

interface StoredImage {
  readonly digest: string;
  readonly repository: string;
  readonly healthy: boolean;
}

/**
 * Parse Docker's env-file format (the CLI's `opts.ParseEnvFile`), or say why
 * Docker would refuse the file.
 */
export function parseDockerEnvFile(data: Buffer): Record<string, string> | string {
  const text = data.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(data)) return 'env file is not valid UTF-8';
  const values: Record<string, string> = {};
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const [index, raw] of lines.entries()) {
    // bufio.ScanLines drops one carriage return before the newline.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (Buffer.byteLength(line, 'utf8') > ENV_FILE_MAX_LINE_BYTES) return 'env file line too long';
    // A byte order mark is dropped from the first line only.
    const unmarked = index === 0 && line.startsWith('\uFEFF') ? line.slice(1) : line;
    const trimmed = unmarked.replace(GO_LEADING_SPACE, '');
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    const key = equals === -1 ? trimmed : trimmed.slice(0, equals);
    // Docker's own whitespace set for a name is space and tab.
    if (/[ \t]/u.test(key)) return 'env file variable contains whitespace';
    if (key === '') return 'env file line has no variable name';
    // A bare name takes its value from the Docker CLI's environment, which
    // holds nothing on the server.
    if (equals !== -1) values[key] = trimmed.slice(equals + 1);
  }
  return values;
}

/** A Docker engine over the host's file system, pulling from one registry. */
export class FakeDocker {
  readonly #fs: FakeFileSystem;
  readonly #registry: FakeRegistry;
  readonly #onUnmodelled: (argv: readonly string[]) => void;
  readonly #images = new Map<string, StoredImage>();
  readonly #tags = new Map<string, string>();
  /** The `repo@sha256:…` references each local image was pulled as, by digest. */
  readonly #repoDigests = new Map<string, Set<string>>();
  readonly #containers = new Map<string, MutableContainer>();
  readonly #volumes = new Map<string, Map<string, Buffer>>();
  readonly #networks = new Set<string>([DEFAULT_NETWORK]);
  readonly #routes = new Map<string, FakeRoute>();
  /** The ids of every container kamal-proxy ever routed to. */
  readonly #served = new Set<string>();
  readonly #oneOffRuns: FakeOneOffRun[] = [];
  #created = 0;

  constructor(
    fs: FakeFileSystem,
    registry: FakeRegistry,
    onUnmodelled: (argv: readonly string[]) => void,
  ) {
    this.#fs = fs;
    this.#registry = registry;
    this.#onUnmodelled = onUnmodelled;
  }

  /** Every container, oldest first. */
  containers(): readonly FakeContainer[] {
    return [...this.#containers.values()].sort((a, b) => a.created - b.created);
  }

  /** Every attached `docker run --rm`, in order. */
  oneOffRuns(): readonly FakeOneOffRun[] {
    return [...this.#oneOffRuns];
  }

  /** The container named `name`, if any. */
  container(name: string): FakeContainer | undefined {
    return this.#containers.get(name);
  }

  /**
   * The variables a JSails app in `view` resolves: its real environment over
   * the values of the secrets file `JSAILS_SECRETS_FILE` names, read through
   * the bind mount that holds it, as a uid other than the ssh user's (the
   * image's own) would: the file must grant other-read and its mounted
   * directory other-read-and-search. The credentials key ring the file may
   * carry opens the sealed credentials and is no app variable, so it is left
   * out. Throws {@link FakeSecretsFileError} where the app would refuse to
   * start.
   */
  appEnvironment(view: FakeProcessView): Readonly<Record<string, string>> {
    const path = view.env[SECRETS_FILE_VARIABLE];
    if (path === undefined || path === '') return { ...view.env };
    const mount = view.mounts
      .map((spec) => spec.split(':'))
      .find(([, target]) => target !== undefined && path.startsWith(`${target}/`));
    const [source, target] = mount ?? [];
    if (source === undefined || target === undefined || !source.startsWith('/')) {
      throw new FakeSecretsFileError('the secrets file is not on a bind mount');
    }
    const directory = this.#fs.directory(source);
    const file = this.#fs.file(`${source}${path.slice(target.length)}`);
    if (directory === undefined || file === undefined) {
      throw new FakeSecretsFileError('the secrets file does not exist on the host');
    }
    if (
      (directory.mode & OTHER_READ_SEARCH) !== OTHER_READ_SEARCH ||
      (file.mode & OTHER_READ) === 0
    ) {
      throw new FakeSecretsFileError('the secrets file is not readable by the app uid');
    }
    const document = JSON.parse(file.data.toString('utf8')) as {
      v: number;
      values: Record<string, string>;
    };
    if (document.v !== 1) throw new FakeSecretsFileError('unsupported secrets file version');
    const values: Record<string, string> = { ...document.values };
    delete values[CREDENTIALS_KEY_VARIABLE];
    return { ...values, ...view.env };
  }

  /** The credentials key ring `view`'s secrets file delivers, if any. */
  deliveredCredentialsKey(view: FakeProcessView): string | undefined {
    const path = view.env[SECRETS_FILE_VARIABLE];
    if (path === undefined) return undefined;
    const [source, target] =
      view.mounts.map((spec) => spec.split(':')).find(([, t]) => path.startsWith(`${t}/`)) ?? [];
    if (source === undefined || target === undefined) return undefined;
    const file = this.#fs.file(`${source}${path.slice(target.length)}`);
    if (file === undefined) return undefined;
    const document = JSON.parse(file.data.toString('utf8')) as { values: Record<string, string> };
    return document.values[CREDENTIALS_KEY_VARIABLE];
  }

  /** Every local image with the references that point at it. */
  images(): readonly FakeLocalImage[] {
    return [...this.#images.values()].map((image) => ({
      digest: image.digest,
      repository: image.repository,
      tags: [...this.#tags].filter(([, digest]) => digest === image.digest).map(([ref]) => ref),
    }));
  }

  /** The kamal-proxy route of `service`, if one was deployed. */
  route(service: string): FakeRoute | undefined {
    return this.#routes.get(service);
  }

  /** The container kamal-proxy sends `service`'s traffic to, if any. */
  serving(service: string): FakeContainer | undefined {
    const target = this.#routes.get(service)?.target;
    return target === undefined ? undefined : this.#containers.get(targetName(target));
  }

  /** Whether kamal-proxy ever routed traffic to the container `name` (this incarnation). */
  hasServed(name: string): boolean {
    const container = this.#containers.get(name);
    return container !== undefined && this.#served.has(container.id);
  }

  /** The data stored on `volume`, if any. */
  volumeData(volume: string): Buffer | undefined {
    return this.#volumes.get(volume)?.get(VOLUME_DATA);
  }

  /** Replace the data stored on `volume`, creating the volume when missing. */
  setVolumeData(volume: string, data: Buffer): void {
    this.#volume(volume).set(VOLUME_DATA, Buffer.from(data));
  }

  /** Create the network `name` (idempotent). */
  createNetwork(name: string): void {
    this.#networks.add(name);
  }

  /** Attach the container `name` to `network`; false when either is missing. */
  connect(network: string, name: string): boolean {
    const container = this.#containers.get(name);
    if (container === undefined || !this.#networks.has(network)) return false;
    container.networks.add(network);
    return true;
  }

  /** Stop the container `name`; false when it does not exist. */
  stop(name: string): boolean {
    const container = this.#containers.get(name);
    if (container === undefined) return false;
    container.state = 'exited';
    return true;
  }

  /** Start the container `name`; false when it does not exist. */
  start(name: string): boolean {
    const container = this.#containers.get(name);
    if (container === undefined) return false;
    container.state = 'running';
    return true;
  }

  /** Remove the container `name` (`force` also removes a running one); false when refused. */
  remove(name: string, force: boolean): boolean {
    const container = this.#containers.get(name);
    if (container === undefined || (container.state === 'running' && !force)) return false;
    this.#containers.delete(name);
    return true;
  }

  /**
   * Run the Valkey restore's throwaway swap on the volume of `mount`
   * (`<volume>:<dir>`): the staged dump becomes the data. False when nothing
   * is staged or the dump is not a Valkey one, leaving the data as it was.
   */
  swapValkeyStage(mount: string): boolean {
    const [volume, dir] = mount.split(':');
    if (volume === undefined || dir === undefined) return false;
    const files = this.#volume(volume);
    const staged = files.get(stageEntry('valkey'));
    const head = FAKE_DUMP_HEADS.valkey;
    if (staged === undefined || !staged.subarray(0, head.length).equals(Buffer.from(head))) {
      return false;
    }
    files.set(VOLUME_DATA, staged.subarray(head.length));
    files.delete(stageEntry('valkey'));
    return true;
  }

  /** Answer one `docker` argv. */
  exec(argv: readonly string[], stdin?: Buffer): FakeOutput {
    const [, verb, ...rest] = argv;
    switch (verb) {
      case 'pull':
        return rest.length === 1 ? this.#pull(rest[0]!) : this.#unmodelled(argv);
      case 'run':
        return this.#run(argv, rest);
      case 'rm':
        return this.#rm(argv, rest);
      case 'stop':
        return this.#lifecycle(argv, rest, (name) => this.stop(name), ['-t']);
      case 'start':
        return this.#lifecycle(argv, rest, (name) => this.start(name), []);
      case 'restart':
        return this.#lifecycle(argv, rest, (name) => this.start(name), ['-t']);
      case 'inspect':
        return this.#inspect(argv, rest);
      case 'container':
        return rest[0] === 'inspect' ? this.#inspect(argv, rest.slice(1)) : this.#unmodelled(argv);
      case 'image':
        return rest[0] === 'inspect'
          ? this.#imageInspect(argv, rest.slice(1))
          : this.#unmodelled(argv);
      case 'ps':
        return this.#ps(argv, rest);
      case 'exec':
        return this.#exec(argv, rest, stdin);
      case 'volume':
        if (rest[0] === 'create' && rest.length === 2) {
          this.#volume(rest[1]!);
          return ok(`${rest[1]}\n`);
        }
        return this.#unmodelled(argv);
      default:
        return this.#unmodelled(argv);
    }
  }

  #unmodelled(argv: readonly string[]): FakeOutput {
    this.#onUnmodelled(argv);
    return failure(127, 'not modelled by the fake host');
  }

  #volume(name: string): Map<string, Buffer> {
    let files = this.#volumes.get(name);
    if (files === undefined) {
      files = new Map();
      this.#volumes.set(name, files);
    }
    return files;
  }

  /** Resolve `ref` from the registry into the local store, or say it does not exist. */
  #pull(ref: string): FakeOutput {
    const image = this.#resolveRemote(ref);
    if (image === undefined) return failure(1, 'manifest unknown');
    this.#images.set(image.digest, image);
    if (!ref.includes('@')) this.#tags.set(ref, image.digest);
    const pinned = this.#repoDigests.get(image.digest) ?? new Set<string>();
    pinned.add(`${image.repository}@${image.digest}`);
    this.#repoDigests.set(image.digest, pinned);
    return ok(`Digest: ${image.digest}\n`);
  }

  /** `docker image inspect -f '{{json .RepoDigests}}' <id or reference>`. */
  #imageInspect(argv: readonly string[], rest: readonly string[]): FakeOutput {
    const [flag, format, ref, ...extra] = rest;
    if ((flag !== '-f' && flag !== '--format') || ref === undefined || extra.length > 0) {
      return this.#unmodelled(argv);
    }
    if (format !== '{{json .RepoDigests}}') return this.#unmodelled(argv);
    const at = ref.indexOf('@');
    const digest = ref.startsWith('sha256:')
      ? ref
      : at === -1
        ? this.#tags.get(ref)
        : ref.slice(at + 1);
    if (digest === undefined || !this.#images.has(digest)) return failure(1, 'No such image');
    return ok(`${JSON.stringify([...(this.#repoDigests.get(digest) ?? [])].sort())}\n`);
  }

  /**
   * The image `ref` names in the registry; a repository nobody pushed to is
   * a public image (an accessory, the proxy) that is always available.
   */
  #resolveRemote(ref: string): StoredImage | undefined {
    const pushed = this.#registry.resolve(ref);
    if (pushed !== undefined) return pushed;
    if (this.#registry.hasRepository(imageRepository(ref))) return undefined;
    const at = ref.indexOf('@');
    return {
      digest: at === -1 ? imageDigest(`public:${ref}`) : ref.slice(at + 1),
      repository: imageRepository(ref),
      healthy: true,
    };
  }

  /** The local image `ref` names, pulling it when it is not local yet (`docker run`). */
  #localImage(ref: string): StoredImage | undefined {
    const at = ref.indexOf('@');
    const digest = at === -1 ? this.#tags.get(ref) : ref.slice(at + 1);
    const local = digest === undefined ? undefined : this.#images.get(digest);
    if (local !== undefined) return local;
    return this.#pull(ref).exitCode === 0 ? this.#localImage(ref) : undefined;
  }

  #run(argv: readonly string[], rest: readonly string[]): FakeOutput {
    const flags = new Map<string, string[]>();
    let index = 0;
    for (; index < rest.length; index += 1) {
      const token = rest[index]!;
      if (!token.startsWith('-')) break;
      if (RUN_BOOLEAN_FLAGS.has(token)) {
        flags.set(token, []);
      } else if (RUN_VALUED_FLAGS.has(token) && rest[index + 1] !== undefined) {
        flags.set(token, [...(flags.get(token) ?? []), rest[index + 1]!]);
        index += 1;
      } else {
        return this.#unmodelled(argv);
      }
    }
    const ref = rest[index];
    const detached = flags.has('-d');
    if (ref === undefined || (!detached && !flags.has('--rm'))) return this.#unmodelled(argv);
    // A CLI before Docker 23 hands every source to the daemon as written,
    // and the daemon takes one that is not absolute for a volume name. The
    // model is that oldest supported engine, so a `./` source fails here.
    for (const mount of flags.get('-v') ?? []) {
      const source = mount.split(':')[0]!;
      if (!source.startsWith('/') && !VOLUME_NAME.test(source)) {
        return failure(125, 'includes invalid characters for a local volume name');
      }
    }
    const name = flags.get('--name')?.at(-1) ?? `c${this.#created + 1}`;
    if (detached && this.#containers.has(name)) {
      return failure(125, 'Conflict. The container name is already in use');
    }
    const env: Record<string, string> = {};
    for (const path of flags.get('--env-file') ?? []) {
      const file = this.#fs.file(path);
      if (file === undefined) return failure(125, 'open env file: no such file or directory');
      const parsed = parseDockerEnvFile(file.data);
      if (typeof parsed === 'string') return failure(125, parsed);
      Object.assign(env, parsed);
    }
    for (const entry of flags.get('-e') ?? []) {
      const equals = entry.indexOf('=');
      if (equals !== -1) env[entry.slice(0, equals)] = entry.slice(equals + 1);
    }
    const labels: Record<string, string> = {};
    for (const entry of flags.get('--label') ?? []) {
      const equals = entry.indexOf('=');
      labels[equals === -1 ? entry : entry.slice(0, equals)] =
        equals === -1 ? '' : entry.slice(equals + 1);
    }
    const network = flags.get('--network')?.at(-1) ?? DEFAULT_NETWORK;
    if (network !== NO_NETWORK && !this.#networks.has(network)) {
      return failure(125, 'network not found');
    }
    const image = this.#localImage(ref);
    if (image === undefined) return failure(125, 'Unable to find image');
    if (!detached) {
      this.#oneOffRuns.push({
        imageDigest: image.digest,
        network,
        env,
        mounts: flags.get('-v') ?? [],
        command: rest.slice(index + 1),
      });
      return ok('');
    }
    for (const mount of flags.get('-v') ?? []) {
      const source = mount.split(':')[0]!;
      if (!source.startsWith('/')) this.#volume(source);
    }
    this.#created += 1;
    const id = randomBytes(32).toString('hex');
    this.#containers.set(name, {
      id,
      name,
      image: ref,
      imageDigest: image.digest,
      labels,
      env,
      state: 'running',
      restartCount: 0,
      restartPolicy: flags.get('--restart')?.at(-1),
      mounts: flags.get('-v') ?? [],
      networks: new Set([network]),
      ports: flags.get('-p') ?? [],
      command: rest.slice(index + 1),
      created: this.#created,
      healthy: image.healthy,
      files: new Map(),
    });
    return ok(`${id}\n`);
  }

  #rm(argv: readonly string[], rest: readonly string[]): FakeOutput {
    const force = rest[0] === '-f';
    const names = (force ? rest.slice(1) : rest).filter((token) => token !== '--');
    if (names.length !== 1 || names[0]!.startsWith('-')) return this.#unmodelled(argv);
    const name = names[0]!;
    if (!this.#containers.has(name)) return failure(1, 'No such container');
    return this.remove(name, force)
      ? ok(`${name}\n`)
      : failure(1, 'cannot remove container: container is running');
  }

  #lifecycle(
    argv: readonly string[],
    rest: readonly string[],
    apply: (name: string) => boolean,
    valued: readonly string[],
  ): FakeOutput {
    const names: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;
      if (valued.includes(token)) index += 1;
      else if (token !== '--') names.push(token);
    }
    if (names.length !== 1 || names[0]!.startsWith('-')) return this.#unmodelled(argv);
    return apply(names[0]!) ? ok(`${names[0]}\n`) : failure(1, 'No such container');
  }

  #inspect(argv: readonly string[], rest: readonly string[]): FakeOutput {
    let format: string | undefined;
    const names: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;
      if (token === '--type') {
        if (rest[index + 1] !== 'container') return this.#unmodelled(argv);
        index += 1;
      } else if (token === '-f' || token === '--format') {
        format = rest[index + 1];
        index += 1;
      } else {
        names.push(token);
      }
    }
    if (names.length !== 1) return this.#unmodelled(argv);
    const container = this.#containers.get(names[0]!);
    if (container === undefined) return failure(1, 'No such container');
    if (format === undefined) {
      return ok(
        `${JSON.stringify([
          {
            Id: container.id,
            Name: `/${container.name}`,
            State: { Running: container.state === 'running' },
            Config: { Image: container.image, Labels: container.labels },
          },
        ])}\n`,
      );
    }
    if (format === '{{.State.Running}}') return ok(`${container.state === 'running'}\n`);
    // The model's image id is the image's digest.
    if (format === '{{.Image}}') return ok(`${container.imageDigest}\n`);
    return this.#unmodelled(argv);
  }

  #ps(argv: readonly string[], rest: readonly string[]): FakeOutput {
    let all = false;
    let format: string | undefined;
    const filters: ((container: FakeContainer) => boolean)[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;
      const value = rest[index + 1];
      if (token === '-a') {
        all = true;
      } else if (token === '--no-trunc') {
        continue;
      } else if (token === '--filter' && value?.startsWith('name=') === true) {
        const name = value.slice('name='.length);
        filters.push((c) => c.name.includes(name));
        index += 1;
      } else if (token === '--filter' && value?.startsWith('label=') === true) {
        const label = value.slice('label='.length);
        const equals = label.indexOf('=');
        const key = equals === -1 ? label : label.slice(0, equals);
        const wanted = equals === -1 ? undefined : label.slice(equals + 1);
        filters.push((c) => (wanted === undefined ? key in c.labels : c.labels[key] === wanted));
        index += 1;
      } else if (token === '--format' && value !== undefined) {
        format = value;
        index += 1;
      } else {
        return this.#unmodelled(argv);
      }
    }
    const listed = this.containers()
      .filter((c) => all || c.state === 'running')
      .filter((c) => filters.every((keep) => keep(c)));
    if (format === APP_CONTAINERS_FORMAT) {
      const lines = listed.map((c) =>
        JSON.stringify({
          name: c.name,
          state: c.state,
          image: c.image,
          release: c.labels['jsails.release'] ?? '',
          role: c.labels['jsails.role'] ?? '',
          destination: c.labels['jsails.destination'] ?? '',
        }),
      );
      return ok(lines.map((line) => `${line}\n`).join(''));
    }
    if (format !== undefined) return this.#unmodelled(argv);
    const rows = listed.map((c) => `${c.id.slice(0, 12)}  ${c.image}  ${c.state}  ${c.name}`);
    return ok(['CONTAINER ID  IMAGE  STATUS  NAMES', ...rows].join('\n') + '\n');
  }

  #exec(argv: readonly string[], rest: readonly string[], stdin: Buffer | undefined): FakeOutput {
    const interactive = rest[0] === '-i';
    const name = interactive ? rest[1] : rest[0];
    const command = rest.slice(interactive ? 2 : 1);
    if (name === undefined || command.length === 0) return this.#unmodelled(argv);
    const container = this.#containers.get(name);
    if (container === undefined) return failure(1, 'No such container');
    if (container.state !== 'running') return failure(1, 'container is not running');

    const backup = this.#backupExec(argv, container, stdin);
    if (backup !== undefined) return backup;
    if (name === PROXY_CONTAINER_NAME && command[0] === 'kamal-proxy') {
      return this.#proxy(argv, container, command.slice(1));
    }
    if (command[0] === 'node' && command[1] === '-e' && command.length === 3) {
      return container.healthy ? ok() : failure(1, 'unhealthy');
    }
    if (PROBES.some((probe) => sameArgv(probe, command))) return ok();
    return this.#unmodelled(argv);
  }

  /** A backup or restore command run inside an accessory, recognized by its builder. */
  #backupExec(
    argv: readonly string[],
    container: MutableContainer,
    stdin: Buffer | undefined,
  ): FakeOutput | undefined {
    const kind = accessoryKind(container.image);
    if (kind === undefined) return undefined;
    const volume = this.#volume(SERVICE_CONVENTIONS[kind].volume);
    const head = Buffer.from(FAKE_DUMP_HEADS[kind]);
    const credentials = (): boolean =>
      kind !== 'mariadb' ||
      ['MARIADB_DATABASE', 'MARIADB_USER', 'MARIADB_PASSWORD'].every(
        (key) => (container.env[key] ?? '') !== '',
      );

    if (sameArgv(argv, dumpArgv(kind, container.name))) {
      if (!credentials()) return failure(BACKUP_EXIT.noCredentials, 'no credentials');
      return {
        exitCode: 0,
        stdout: Buffer.concat([head, volume.get(VOLUME_DATA) ?? Buffer.alloc(0)]),
        stderr: '',
      };
    }
    const sha256 = argv.at(-1);
    if (sha256 !== undefined && sameArgv(argv, stageArgv(kind, container.name, sha256))) {
      const received = stdin ?? Buffer.alloc(0);
      if (createHash('sha256').update(received).digest('hex') !== sha256) {
        return failure(BACKUP_EXIT.checksumMismatch, '');
      }
      stageStore(kind, container, volume).set(stageEntry(kind), received);
      return ok();
    }
    if (sameArgv(argv, discardStageArgv(kind, container.name))) {
      stageStore(kind, container, volume).delete(stageEntry(kind));
      return ok();
    }
    if (kind !== 'valkey' && sameArgv(argv, applyDatabaseArgv(kind, container.name))) {
      const staged = container.files.get(stageEntry(kind));
      // The apply script's EXIT trap removes the staged dump however it ends.
      container.files.delete(stageEntry(kind));
      if (!credentials()) return failure(BACKUP_EXIT.noCredentials, 'no credentials');
      if (staged === undefined || !staged.subarray(0, head.length).equals(head)) {
        return failure(1, 'the staged file is not a dump');
      }
      volume.set(VOLUME_DATA, staged.subarray(head.length));
      return ok();
    }
    return undefined;
  }

  #proxy(argv: readonly string[], proxy: MutableContainer, command: readonly string[]): FakeOutput {
    const [verb, service, ...rest] = command;
    if (verb === 'list' && service === undefined) {
      // kamal-proxy's own table: one row per service, its target in a column.
      const rows = [...this.#routes.values()].map(
        (route) =>
          `${route.service}  ${route.host ?? '*'}  /  ${route.target}  running  ${route.tls ? 'yes' : 'no'}`,
      );
      return ok(['Service  Host  Path  Target  State  TLS', ...rows].join('\n') + '\n');
    }

    if (verb === 'remove' && service !== undefined && rest.length === 0) {
      return this.#routes.delete(service) ? ok() : failure(1, 'service not found');
    }
    if (verb !== 'deploy' || service === undefined) return this.#unmodelled(argv);
    const flags = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index]!;
      if (PROXY_BOOLEAN_FLAGS.has(token)) {
        flags.set(token, '');
      } else if (PROXY_VALUED_FLAGS.has(token) && rest[index + 1] !== undefined) {
        flags.set(token, rest[index + 1]!);
        index += 1;
      } else {
        return this.#unmodelled(argv);
      }
    }
    const target = flags.get('--target');
    if (target === undefined) return this.#unmodelled(argv);
    const backend = this.#containers.get(targetName(target));
    const reachable =
      backend !== undefined &&
      backend.state === 'running' &&
      [...backend.networks].some((network) => proxy.networks.has(network));
    // kamal-proxy keeps the previous target when the new one never passes its
    // health check, and the deploy command fails.
    if (!reachable || !backend.healthy) {
      return failure(1, 'target failed to become healthy');
    }
    this.#served.add(backend.id);
    this.#routes.set(service, {
      service,
      target,
      host: flags.get('--host'),
      tls: flags.has('--tls'),
      healthCheckPath: flags.get('--health-check-path'),
    });
    return ok();
  }
}

/** The container part of a `<container>:<port>` target. */
function targetName(target: string): string {
  const colon = target.lastIndexOf(':');
  return colon === -1 ? target : target.slice(0, colon);
}

/** The accessory kind an image belongs to, by the pinned images jamal runs. */
function accessoryKind(image: string): BackupKind | undefined {
  for (const kind of Object.keys(SERVICE_CONVENTIONS) as BackupKind[]) {
    if (SERVICE_CONVENTIONS[kind].image === image) return kind;
  }
  return undefined;
}

/** Where `kind` stages a restore: the container's writable layer, or Valkey's volume. */
function stageStore(
  kind: BackupKind,
  container: MutableContainer,
  volume: Map<string, Buffer>,
): Map<string, Buffer> {
  return kind === 'valkey' ? volume : container.files;
}

/** The entry a staged dump is stored under: a path in the container, or a name on the volume. */
function stageEntry(kind: BackupKind): string {
  const path = stagePath(kind);
  return kind === 'valkey' ? path.slice(SERVICE_CONVENTIONS.valkey.dataDir.length + 1) : path;
}

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

function ok(stdout = ''): FakeOutput {
  return { exitCode: 0, stdout: Buffer.from(stdout), stderr: '' };
}

function failure(exitCode: number, stderr: string): FakeOutput {
  return { exitCode, stdout: Buffer.alloc(0), stderr };
}
