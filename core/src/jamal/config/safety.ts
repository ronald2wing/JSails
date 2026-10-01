/**
 * Value-safety checks run on the schema-parsed config. Zod has already checked
 * shape and ranges; these guards reject control characters, reserved keys,
 * argv-splitting whitespace, and path traversal. Every message names the field
 * and never echoes the offending value.
 */

import { isForbiddenKey } from '../../json/shape.js';
import { CONTROL_CHARS } from '../../support/strings.js';

import { JamalConfigError } from '../error.js';
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
  if (ssh.proxyCommand !== undefined) {
    assertSafeToken(ssh.proxyCommand, 'production.ssh.proxyCommand');
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
  assertNoControlChars(config.service, 'service');
  assertNoControlChars(config.image, 'image');
  if (config.command !== undefined) {
    assertNoControlChars(config.command, 'command');
  }
  if (config.health !== undefined) {
    assertHealthPath(config.health.path);
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    assertRecordKey(key, 'env');
    if (typeof value === 'string') {
      assertNoControlChars(value, 'env');
    }
    if (isEnvEntry(value)) {
      if (typeof value.value === 'string') {
        assertNoControlChars(value.value, 'env');
      }
      if (value.alias !== undefined) {
        assertSafeToken(value.alias, 'env');
        if (isForbiddenKey(value.alias)) {
          throw new JamalConfigError('config.env aliases must not use a reserved key');
        }
      }
    }
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
