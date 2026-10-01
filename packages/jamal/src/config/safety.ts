/**
 * Value-safety checks run on the schema-parsed config. Zod has already checked
 * shape and ranges; these guards reject control characters, reserved keys,
 * argv-splitting whitespace, and path traversal. Every message names the field
 * and never echoes the offending value.
 */

import { isForbiddenKey } from '../object-shape.js';
import {
  CREDENTIALS_KEY_ENV,
  ENVIRONMENT_NAME_ENV,
  formatTrustedProxies,
  isEnvironmentName,
  RESERVED_KEYS,
  TRUSTED_PROXIES_ENV,
} from 'jsails/internal';
import { JsailsError } from 'jsails/errors';
import { CONTROL_CHARS } from 'jsails/support';

import { JamalConfigError } from '../error.js';
import { isPinnedImage } from '../production/image-ref.js';
import type { ParsedJamalConfig, ParsedSshConfig } from './schema.js';
import { SecretRef } from './secret-ref.js';
import { assertVolumeName, parseVolumeSpec } from './volume-spec.js';

function assertNoControlChars(value: string, field: string): void {
  if (CONTROL_CHARS.test(value)) {
    throw new JamalConfigError(`config.${field} must not contain control characters`);
  }
}

/**
 * Reject own keys that collide with `Object.prototype` before Zod parsing.
 * Zod's record parser reassigns entries onto a fresh object, so an own
 * `__proto__` key (producible via `JSON.parse`) is silently dropped before the
 * post-parse `assertRecordKey` runs; this scan closes that gap.
 */
export function assertNoDangerousKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoDangerousKeys(item);
    }
    return;
  }
  if (typeof value !== 'object' || value === null || value instanceof SecretRef) {
    return;
  }
  for (const key of Object.keys(value)) {
    if (isForbiddenKey(key)) {
      throw new JamalConfigError('config contains a reserved key');
    }
  }
  for (const child of Object.values(value)) {
    assertNoDangerousKeys(child);
  }
}

/**
 * The app's service name. It becomes the Compose project name (lowercase
 * letters, digits, `_`, `-`), container and volume name prefixes, the proxy
 * service, and the remote lock and release paths, so it is held to the
 * narrowest of those grammars.
 */
const APP_SERVICE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** An environment variable name: what Compose interpolation and env files accept. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A Compose service name that is also a valid hostname label. */
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

/** Names the application service and its port alias own. */
const RESERVED_SERVICE_NAMES: ReadonlySet<string> = new Set(['app', 'web']);

function assertRecordKey(key: string, field: string): void {
  if (key.length === 0) {
    throw new JamalConfigError(`config.${field} keys must be non-empty`);
  }
  if (CONTROL_CHARS.test(key)) {
    throw new JamalConfigError(`config.${field} keys must not contain control characters`);
  }
  if (isForbiddenKey(key)) {
    throw new JamalConfigError(`config.${field} keys must not use a reserved key`);
  }
}

function assertHealthPath(path: string): void {
  if (!path.startsWith('/')) {
    throw new JamalConfigError('config.health.path must start with "/"');
  }
  if (path.includes('\\') || CONTROL_CHARS.test(path)) {
    throw new JamalConfigError(
      'config.health.path must not contain a backslash or control characters',
    );
  }
}

/**
 * Validate an on-demand TLS allowlist URL: an absolute `http://` or `https://`
 * URL, or a local path starting with `/`. Rejects whitespace/control characters
 * (so the value is a single unambiguous token) and any other scheme.
 */
function assertOnDemandTlsUrl(value: string): void {
  if (CONTROL_CHARS.test(value) || /\s/.test(value)) {
    throw new JamalConfigError(
      'config.production.onDemandTlsUrl must not contain whitespace or control characters',
    );
  }
  if (!value.startsWith('http://') && !value.startsWith('https://') && !value.startsWith('/')) {
    throw new JamalConfigError(
      'config.production.onDemandTlsUrl must be an absolute http:// or https:// URL, ' +
        'or a local path starting with "/"',
    );
  }
}

/**
 * A destination becomes a filename suffix and a directory name, so it must be
 * a safe token. Mirrors Kamal's destination naming.
 */
function assertDestination(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new JamalConfigError(
      'config.production.destination must contain only letters, digits, "-", and "_"',
    );
  }
}

/** The secrets path must stay inside the project root. */
function assertSecretsPath(value: string): void {
  if (CONTROL_CHARS.test(value)) {
    throw new JamalConfigError('config.production.secretsPath must not contain control characters');
  }
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) {
    throw new JamalConfigError(
      'config.production.secretsPath must be relative to the project root',
    );
  }
  if (value.split(/[/\\]/).includes('..')) {
    throw new JamalConfigError('config.production.secretsPath must not escape the project root');
  }
}

/** A Zod-parsed env entry shape. */
type ParsedEnvEntry = { value: string | SecretRef; alias?: string; clear?: boolean };

/** Structural guard for an env entry object (not a string or SecretRef). */
function isEnvEntry(value: unknown): value is ParsedEnvEntry {
  return (
    typeof value === 'object' && value !== null && !(value instanceof SecretRef) && 'value' in value
  );
}

function assertEnvName(value: string): void {
  if (!ENV_NAME.test(value)) {
    throw new JamalConfigError(
      'config.env keys and aliases must start with a letter or "_" and use only letters, digits, and "_"',
    );
  }
}

/**
 * Refuse the credentials key as a container variable or a secret reference:
 * `jamal deploy` delivers it itself (`credentials-delivery.ts`), so a config
 * entry could only shadow it or carry it through a second route.
 */
function assertNotCredentialsKey(name: string | undefined): void {
  if (name === CREDENTIALS_KEY_ENV) {
    throw new JamalConfigError(
      `config.env must not name ${CREDENTIALS_KEY_ENV}: jamal deploy delivers the credentials key to the app itself`,
      { suggestion: `remove the ${CREDENTIALS_KEY_ENV} entry from config.env` },
    );
  }
}

/**
 * Refuse the trusted-proxy variable as a container variable: `jamal deploy`
 * derives it from the proxy topology it configures (`config.proxy`, the
 * cache proxy; `production/proxy-trust.ts`), so a hand-written count could
 * only disagree with the proxies actually in front of the app.
 */
function assertNotTrustedProxies(name: string): void {
  if (name === TRUSTED_PROXIES_ENV) {
    throw new JamalConfigError(
      `config.env must not name ${TRUSTED_PROXIES_ENV}: jamal deploy derives it from the proxies it puts in front of the app`,
      {
        suggestion: `remove the ${TRUSTED_PROXIES_ENV} entry; describe proxies in front of kamal-proxy with config.proxy`,
      },
    );
  }
}

/**
 * Refuse a `config.proxy.upstreamCidrs` entry the app would refuse as a
 * trusted range, when the config loads: the list reaches the app as part of
 * `JSAILS_TRUSTED_PROXIES`, and a deployed app refuses to boot on a range it
 * cannot read.
 */
function assertUpstreamCidrs(cidrs: readonly string[]): void {
  try {
    formatTrustedProxies({ cidrs });
  } catch (error) {
    if (!(error instanceof JsailsError)) throw error;
    // The app's own error names its config key; this one names jamal's.
    throw new JamalConfigError(
      'config.proxy.upstreamCidrs entries must be IP addresses or CIDR ranges',
      {
        suggestion:
          'list the address ranges the CDN or load balancer publishes, e.g. 173.245.48.0/20',
      },
    );
  }
}

/**
 * Refuse a variable the JSails environment resolver reserves (`RESERVED_KEYS`)
 * as a `config.env` name, when the config loads rather than when the deployed
 * container boots: the resolver lets only a run's real environment set them,
 * and `config.env` is a committed file that every container of the app gets.
 * `name` is the entry's key or its alias; `container` is the variable the
 * container receives (the alias when one is set), and `clear` whether it
 * travels on the `docker run` command line.
 *
 * `JSAILS_ENV` is the one exception: a clear entry is how a deploy chooses the
 * environment its container runs as (`credentials-delivery.ts`), since a clear
 * `-e` follows the release's own and wins. In the secrets file it is a key
 * the app refuses at boot, and as a key that an alias renames it would only
 * read the environment jamal itself runs as.
 */
function assertNotReservedName(name: string, container: string, clear: boolean): void {
  assertNotTrustedProxies(name);
  if (name === CREDENTIALS_KEY_ENV) {
    assertNotCredentialsKey(name);
    return;
  }
  if (!RESERVED_KEYS.includes(name)) return;
  if (name === ENVIRONMENT_NAME_ENV) {
    if (name === container && clear) return;
    throw new JamalConfigError(
      `config.env sets ${ENVIRONMENT_NAME_ENV} other than as a clear entry of its own: the release passes ${ENVIRONMENT_NAME_ENV} on the command line, which only a clear entry can override`,
      {
        suggestion: `give ${ENVIRONMENT_NAME_ENV} a literal value (or clear: true) and no alias, under its own name`,
      },
    );
  }
  if (name === 'NODE_ENV') {
    throw new JamalConfigError(
      `config.env must not name NODE_ENV: the app derives it from ${ENVIRONMENT_NAME_ENV} (development, test, otherwise production) and refuses to start when they disagree`,
      {
        suggestion: `remove the NODE_ENV entry; set ${ENVIRONMENT_NAME_ENV} as a clear config.env entry to choose the environment`,
      },
    );
  }
  throw new JamalConfigError(
    `config.env must not name ${name}: the JSails environment resolver reserves it for the real environment of a run, never a committed config`,
    { suggestion: `remove the ${name} entry from config.env` },
  );
}

/**
 * A literal `JSAILS_ENV` must be a name the app's resolver accepts, or every
 * container of the release refuses to start; checked without echoing it.
 */
function assertEnvironmentNameValue(container: string, value: string | SecretRef): void {
  if (container !== ENVIRONMENT_NAME_ENV || typeof value !== 'string') return;
  if (!isEnvironmentName(value)) {
    throw new JamalConfigError(
      `config.env ${ENVIRONMENT_NAME_ENV} must be an environment name: 1 to 64 letters, digits, "-" or "_", starting with a letter or a digit`,
      { suggestion: `set ${ENVIRONMENT_NAME_ENV} to a name such as production or staging` },
    );
  }
}

function assertSafeToken(value: string, field: string): void {
  if (CONTROL_CHARS.test(value) || /\s/.test(value)) {
    throw new JamalConfigError(`config.${field} must not contain whitespace or control characters`);
  }
}

function assertSshConfig(ssh: ParsedSshConfig): void {
  if (ssh.user !== undefined) {
    if (ssh.user.startsWith('-')) {
      throw new JamalConfigError('config.production.ssh.user must not start with "-"');
    }
    assertSafeToken(ssh.user, 'production.ssh.user');
  }
  // A ProxyCommand is a command line by nature (`ssh -W %h:%p bastion`); it is
  // one `-o ProxyCommand=...` argument locally, so only control characters
  // could break it.
  if (ssh.proxyCommand !== undefined) {
    assertNoControlChars(ssh.proxyCommand, 'production.ssh.proxyCommand');
  }
  if (ssh.logLevel !== undefined) {
    assertSafeToken(ssh.logLevel, 'production.ssh.logLevel');
  }
  if (ssh.config !== undefined) {
    assertSafeToken(ssh.config, 'production.ssh.config');
  }
  for (const key of ssh.keys ?? []) {
    assertSafeToken(key, 'production.ssh.keys');
  }
}

export function assertSafeConfig(config: ParsedJamalConfig): void {
  if (config.proxy?.upstreamCidrs !== undefined) {
    assertUpstreamCidrs(config.proxy.upstreamCidrs);
  }
  if (!APP_SERVICE_NAME.test(config.service)) {
    throw new JamalConfigError(
      'config.service must start with a lowercase letter or digit and use only lowercase ' +
        'letters, digits, "_", or "-" (at most 63 characters)',
    );
  }
  assertNoControlChars(config.image, 'image');
  if (config.command !== undefined) {
    assertNoControlChars(config.command, 'command');
  }
  if (config.health !== undefined) {
    assertHealthPath(config.health.path);
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    assertRecordKey(key, 'env');
    assertEnvName(key);
    if (typeof value === 'string') {
      assertNoControlChars(value, 'env');
    }
    if (value instanceof SecretRef) {
      assertNotCredentialsKey(value.name);
    }
    const entry = isEnvEntry(value) ? value : undefined;
    if (entry !== undefined) {
      if (entry.value instanceof SecretRef) {
        assertNotCredentialsKey(entry.value.name);
      }
      if (typeof entry.value === 'string') {
        assertNoControlChars(entry.value, 'env');
      }
      if (entry.alias !== undefined) {
        assertSafeToken(entry.alias, 'env');
        assertEnvName(entry.alias);
        if (isForbiddenKey(entry.alias)) {
          throw new JamalConfigError('config.env aliases must not use a reserved key');
        }
      }
    }
    // The channel follows `env-resolve.ts`: a secret reference travels in the
    // secrets file unless the entry opts it onto the command line.
    const entryValue = entry === undefined ? (value as string | SecretRef) : entry.value;
    const clear = !(entryValue instanceof SecretRef) || entry?.clear === true;
    const container = entry?.alias ?? key;
    assertNotReservedName(key, container, clear);
    if (entry?.alias !== undefined) assertNotReservedName(entry.alias, container, clear);
    assertEnvironmentNameValue(container, entryValue);
  }
  for (const key of Object.keys(config.services ?? {})) {
    assertRecordKey(key, 'services');
    // A service name becomes a Compose service key and, inside the local
    // network, a hostname, so it uses the characters both allow.
    if (!SERVICE_NAME.test(key)) {
      throw new JamalConfigError(
        'config.services keys must start with a letter or digit and use only letters, digits, ".", "_", or "-"',
      );
    }
    // `app` is the application's own Compose service and `web`/`app` name its
    // port in config.local.ports, so a backing service cannot take them.
    if (RESERVED_SERVICE_NAMES.has(key)) {
      throw new JamalConfigError('config.services keys must not be "app" or "web"');
    }
  }
  for (const [name, value] of Object.entries(config.volumes ?? {})) {
    assertVolumeName(name);
    parseVolumeSpec(value);
  }
  for (const key of Object.keys(config.local?.ports ?? {})) {
    assertRecordKey(key, 'local.ports');
  }
  if (config.production !== undefined) {
    assertNoControlChars(config.production.server, 'production.server');
    if (config.production.domain !== undefined) {
      assertNoControlChars(config.production.domain, 'production.domain');
    }
    if (config.production.onDemandTlsUrl !== undefined) {
      assertOnDemandTlsUrl(config.production.onDemandTlsUrl);
    }
    if (config.production.domain !== undefined && config.production.onDemandTlsUrl !== undefined) {
      throw new JamalConfigError(
        'config.production.domain and config.production.onDemandTlsUrl are mutually exclusive',
      );
    }
    if (config.production.registry !== undefined) {
      assertNoControlChars(config.production.registry.server, 'production.registry.server');
      assertNoControlChars(config.production.registry.username, 'production.registry.username');
    }
    if (config.production.ssh !== undefined) {
      assertSshConfig(config.production.ssh);
    }
    if (config.production.destination !== undefined) {
      assertDestination(config.production.destination);
    }
    if (config.production.secretsPath !== undefined) {
      assertSecretsPath(config.production.secretsPath);
    }
  }
  if (config.logging !== undefined) {
    assertSafeToken(config.logging.driver, 'logging.driver');
    for (const [key, value] of Object.entries(config.logging.options ?? {})) {
      assertSafeToken(key, 'logging.options');
      assertSafeToken(value, 'logging.options');
    }
  }
  if (config.cacheProxy !== undefined) {
    if (config.cacheProxy.image !== undefined) {
      assertSafeToken(config.cacheProxy.image, 'cacheProxy.image');
      if (!isPinnedImage(config.cacheProxy.image)) {
        throw new JamalConfigError(
          'config.cacheProxy.image must be pinned by digest ("<repository>@sha256:<64 hex digits>"), so a release records the exact cache proxy it ran',
        );
      }
    }
    if (config.cacheProxy.size !== undefined) {
      assertSafeToken(config.cacheProxy.size, 'cacheProxy.size');
    }
    for (const name of config.cacheProxy.cookieAllowlist ?? []) {
      assertSafeToken(name, 'cacheProxy.cookieAllowlist');
    }
  }
}

// ---------------------------------------------------------------------------
// Model assembly + redaction
// ---------------------------------------------------------------------------
