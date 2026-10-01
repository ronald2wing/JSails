/**
 * Jamal runtime domain management: `jamal domain add|list|remove`.
 *
 * A production deploy routes traffic through the kamal-proxy container, and the
 * three `domain` verbs control that routing without re-running a full deploy.
 * They build their fixed `docker exec kamal-proxy ...` argv through the same
 * pure argv builders the production planner uses (`proxyDeployArgv`,
 * `proxyRemoveServiceArgv`, `proxyListArgv`) and execute it over the injected
 * {@link RemoteRunner} seam — the same ssh path `deploy` takes.
 *
 * `add <host>` binds a new public host to the LIVE release, whose container
 * the server's host state and proxy name (`liveWebContainer`), so the server
 * must already serve a release, and kamal-proxy must be running to take the
 * route (a stopped or missing one is refused before the route is sent). It
 * holds the app's deploy lock and runs through its fenced runner, so it never
 * re-routes the service while a release switches it. kamal-proxy's `deploy` replaces
 * every option of the service, so `add` passes the same route the release
 * switch does ({@link appProxyRoute}): the cache proxy as the target when it
 * is enabled, the health path, and `--forward-headers`. Otherwise the proxies
 * in front of the app would no longer be the ones its `JSAILS_TRUSTED_PROXIES`
 * states, and every client could end up keyed on one proxy address.
 *
 * `remove <host>` removes the service (and its routed host) from the proxy —
 * kamal-proxy removes by service, not by host, so `<host>` is validated but the
 * argv is service-scoped. `list` dumps the proxy's routing table verbatim. All
 * three require `config.production` for the SSH target and resolve the service
 * from `--service` (or `config.service`).
 *
 * These verbs drive the proxy's runtime `deploy`/`remove` API over ssh, not a
 * config file: a host bound by `add` is NOT recorded in `deploy.yml`, so a later
 * external `kamal deploy` (which regenerates the proxy from that file) may
 * overwrite or conflict with it. Use on-demand TLS for unknown/customer hosts,
 * and note that `--tls` static hosts and on-demand TLS are mutually exclusive.
 *
 * `--dry-run` prints the exact `ssh` argv without running it; no path here
 * writes a file or opens a connection beyond the remote runner.
 */

import { CONTROL_CHARS } from 'jsails/support';
import { JsailsError } from 'jsails/errors';
import { parseArgs } from 'node:util';

import { formatError } from './thrown-value.js';
import {
  loadProductionConfigOrReport,
  printDryRun,
  remoteRunnerFor,
  reportFailure,
  type JamalDeps,
} from './deps.js';
import type { JamalConfig } from './config/index.js';
import { defaultLockOwner, withDeployLock } from './production/execute.js';
import { observe } from './production/observe.js';
import { appProxyRoute, liveWebContainer } from './production/plan.js';
import type { RemoteRunner } from './production/transport.js';
import { proxyDeployArgv, proxyListArgv, proxyRemoveServiceArgv } from './production/proxy.js';
import { sshArgv } from './production/transport.js';
import { usageFailure } from './usage-failure.js';
import { runRemoteCommand } from './remote-command.js';
import { DOMAIN_USAGE } from './usage.js';

/** Upper bound on a fully-qualified hostname (RFC 1035). */
const MAX_HOST_LENGTH = 253;

/** Raised for an invalid domain or service name. Messages never embed input. */
/** Why a domain verb refused its host or service argument. */
type DomainErrorCode = 'invalid_host' | 'invalid_service';

/** Raised for an invalid domain or service name. Messages never embed input. */
class DomainError extends JsailsError {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Validate a public hostname and return it unchanged. The value must be a
 * lower-case DNS name: non-empty, at most 253 characters, no whitespace or
 * control characters, no wildcard, and only digits, lower-case letters, dots,
 * and internal hyphens — so a scheme (`https://`), a port (`:443`), a path
 * (`/check`), a query, a fragment, userinfo (`@`), an underscore, or an
 * upper-case label is rejected. Labels may not start or end with a hyphen, may
 * not exceed 63 characters, and the name may not start/end with a dot or
 * contain an empty label. The failure message names only the operation label.
 */
function assertDomainHost(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainError('invalid_host', `${label} must be a non-empty hostname`);
  }
  if (value.length > MAX_HOST_LENGTH) {
    throw new DomainError('invalid_host', `${label} exceeds the maximum hostname length`);
  }
  if (CONTROL_CHARS.test(value) || /\s/.test(value)) {
    throw new DomainError(
      'invalid_host',
      `${label} must not contain whitespace or control characters`,
    );
  }
  if (value.includes('*')) {
    throw new DomainError('invalid_host', `${label} must not contain a wildcard`);
  }
  if (/[^a-z0-9.-]/.test(value)) {
    throw new DomainError('invalid_host', `${label} must be a lower-case domain name`);
  }
  if (value.startsWith('.') || value.endsWith('.') || value.includes('..')) {
    throw new DomainError('invalid_host', `${label} has an invalid domain format`);
  }
  for (const segment of value.split('.')) {
    if (segment.length > 63) {
      throw new DomainError('invalid_host', `${label} has a domain label that is too long`);
    }
    if (segment.startsWith('-') || segment.endsWith('-')) {
      throw new DomainError('invalid_host', `${label} has an invalid domain label`);
    }
  }
  return value;
}

/** Reject a service name that cannot be a safe proxy value, value-free. */
function assertService(value: string, label: string): string {
  if (value.length === 0) {
    throw new DomainError('invalid_service', `${label} must be a non-empty name`);
  }
  if (CONTROL_CHARS.test(value) || /\s/.test(value)) {
    throw new DomainError(
      'invalid_service',
      `${label} must not contain whitespace or control characters`,
    );
  }
  return value;
}

/** Flags the `domain` verbs accept; parsed independently of the top-level set. */
const DOMAIN_OPTIONS = {
  service: { type: 'string' },
  'no-tls': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

/** A loaded production config plus the resolved service and SSH target. */
interface DomainTarget {
  readonly config: JamalConfig;
  readonly service: string;
  readonly server: string;
}

/**
 * Load the jamal config from `deps.cwd` and require `config.production` (the
 * SSH target). Reports a value-free failure and resolves `undefined` so the
 * caller returns exit code 1.
 */
async function loadDomainTarget(deps: JamalDeps): Promise<DomainTarget | undefined> {
  const config = await loadProductionConfigOrReport(deps, 'domain');
  if (config?.production === undefined) {
    return undefined;
  }
  return { config, service: config.service, server: config.production.server };
}

/**
 * Run the `jamal domain` command over the tokens after `domain`. Resolves to a
 * process exit code: 0 on success (including a dry run), 2 for a usage error
 * (bad flag, missing host, invalid host/service name), and 1 for a config,
 * server-read, or remote-run failure.
 */
export async function runDomainCommand(deps: JamalDeps, args: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: DOMAIN_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageFailure(deps, formatError(error));
  }

  const { values, positionals } = parsed;

  if (values.help) {
    deps.stdout(DOMAIN_USAGE);
    return 0;
  }

  const subcommand = positionals[0];
  if (subcommand !== 'add' && subcommand !== 'list' && subcommand !== 'remove') {
    return usageFailure(deps, 'a subcommand is required (add | list | remove)');
  }

  if (subcommand === 'add' || subcommand === 'remove') {
    if (positionals[1] === undefined) {
      return usageFailure(deps, `"jamal domain ${subcommand}" requires a host`);
    }
    if (positionals.length > 2) {
      return usageFailure(deps, `unexpected argument: ${positionals.slice(2).join(' ')}`);
    }
  } else if (positionals.length > 1) {
    return usageFailure(deps, `unexpected argument: ${positionals.slice(1).join(' ')}`);
  }

  const loaded = await loadDomainTarget(deps);
  if (loaded === undefined) {
    return 1;
  }
  const { config, server } = loaded;
  const target = config.production!;
  const ssh = target.ssh;

  let service: string;
  let host: string | undefined;
  try {
    service = assertService(values.service ?? config.service, '--service');
    if (subcommand === 'add' || subcommand === 'remove') {
      host = assertDomainHost(positionals[1], 'domain');
    }
  } catch (error) {
    return usageFailure(deps, formatError(error));
  }

  if (subcommand === 'list') {
    const argv = proxyListArgv();
    return values['dry-run']
      ? printDryRun(deps, sshArgv(server, argv, { ssh }))
      : runRemoteCommand(deps, target, argv, 'domain list');
  }

  if (subcommand === 'remove') {
    const argv = proxyRemoveServiceArgv({ service });
    return values['dry-run']
      ? printDryRun(deps, sshArgv(server, argv, { ssh }))
      : runRemoteCommand(deps, target, argv, 'domain remove');
  }

  // `add` routes the host to the release the server serves now.
  const addArgv = (container: string): readonly string[] =>
    proxyDeployArgv({
      service,
      ...appProxyRoute(config, container),
      host,
      tls: !values['no-tls'],
    });
  const remote = remoteRunnerFor(deps, target);
  const liveContainer = async (runner: RemoteRunner): Promise<string | undefined> => {
    const observed = await observe(runner, server, config);
    if (observed.web.kind === 'proxy-down') {
      deps.stderr('jamal: kamal-proxy is not running on the server; start it, then add the domain');
      return undefined;
    }
    const container = liveWebContainer(config, observed);
    if (container === undefined) {
      deps.stderr(
        'jamal: the server has no live release to route a domain to; run "jamal deploy" first',
      );
    }
    return container;
  };
  try {
    if (values['dry-run']) {
      const container = await liveContainer(remote);
      return container === undefined
        ? 1
        : printDryRun(deps, sshArgv(server, addArgv(container), { ssh }));
    }
    return await withDeployLock(
      {
        remoteRunner: remote,
        server,
        service: config.service,
        destination: target.destination,
        owner: defaultLockOwner('domain add'),
      },
      async (lock) => {
        const container = await liveContainer(lock.remote);
        return container === undefined
          ? 1
          : runRemoteCommand(deps, target, addArgv(container), 'domain add', {
              remote: lock.remote,
            });
      },
    );
  } catch (error) {
    await reportFailure(deps, error, 'domain add failed');
    return 1;
  }
}
