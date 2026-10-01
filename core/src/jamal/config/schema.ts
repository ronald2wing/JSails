/**
 * The Zod schema for a raw `jamal.config.js` default export. It checks shape,
 * types, and numeric ranges only; the value-safety checks (control characters,
 * reserved keys, path traversal) run afterwards in `safety.ts` so that every
 * rejection message stays value-free.
 */

import { z } from 'zod';

import type { ZodIssueEntry } from '../../validation/zod-issues.js';

import { JAMAL_SERVICE_TYPES } from './model.js';
import { SecretRef } from './secret-ref.js';

/** Upper bound on a published port. */
const MAX_PORT = 65535;

const envEntrySchema = z
  .object({
    value: z.union([z.string(), z.instanceof(SecretRef)]),
    alias: z.string().optional(),
    clear: z.boolean().optional(),
  })
  .strict();

const envValueSchema = z.union([z.string(), z.instanceof(SecretRef), envEntrySchema]);

const healthSchema = z
  .object({
    path: z.string(),
    timeoutMs: z.number().int().positive(),
    intervalMs: z.number().int().positive(),
    retries: z.number().int().min(0).optional(),
    retryDelayMs: z.number().int().positive().optional(),
    readinessDelayMs: z.number().int().positive().optional(),
  })
  .strict();

const loggingSchema = z
  .object({
    driver: z.string(),
    options: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const sshSchema = z
  .object({
    user: z.string().optional(),
    port: z.number().int().min(1).max(MAX_PORT).optional(),
    proxyCommand: z.string().optional(),
    logLevel: z.string().optional(),
    keysOnly: z.boolean().optional(),
    keys: z.array(z.string()).optional(),
    config: z.string().optional(),
    forwardAgent: z.boolean().optional(),
  })
  .strict();

const serviceConfigSchema = z
  .object({
    type: z.enum(JAMAL_SERVICE_TYPES),
  })
  .strict();

const localSchema = z
  .object({
    ports: z.record(z.string(), z.number().int().min(1).max(MAX_PORT)).optional(),
    build: z.boolean().optional(),
  })
  .strict();

const registrySchema = z
  .object({
    server: z.string().min(1),
    username: z.string().min(1),
  })
  .strict();

const productionSchema = z
  .object({
    server: z.string().min(1),
    domain: z.string().min(1).optional(),
    onDemandTlsUrl: z.string().min(1).optional(),
    registry: registrySchema.optional(),
    ssh: sshSchema.optional(),
    destination: z.string().min(1).optional(),
    secretsPath: z.string().min(1).optional(),
  })
  .strict();

const cacheProxySchema = z
  .object({
    enabled: z.boolean().optional(),
    image: z.string().min(1).optional(),
    size: z.string().min(1).optional(),
    cookieAllowlist: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const jamalConfigSchema = z
  .object({
    service: z.string().min(1),
    image: z.string().min(1),
    command: z.string().optional(),
    health: healthSchema.optional(),
    env: z.record(z.string(), envValueSchema).optional(),
    services: z.record(z.string(), serviceConfigSchema).optional(),
    volumes: z.record(z.string(), z.string()).optional(),
    local: localSchema.optional(),
    production: productionSchema.optional(),
    logging: loggingSchema.optional(),
    cacheProxy: cacheProxySchema.optional(),
  })
  .strict();

/** The parsed (unresolved) shape produced by the schema. */
export type ParsedJamalConfig = z.infer<typeof jamalConfigSchema>;

/** The parsed shape of `production.ssh`. */
export type ParsedSshConfig = z.infer<typeof sshSchema>;

/**
 * Prefix a mapped issue with its top-level `config.` field only: nested keys
 * under `env`, `services`, and `volumes` are author-chosen names that must not
 * surface in a rejection message.
 */
export function describeIssue(entry: ZodIssueEntry): string {
  if (entry.code === 'unknown_field') {
    return 'config has an unrecognized field';
  }
  const top = typeof entry.path[0] === 'string' ? entry.path[0] : 'config';
  return `config.${top}: ${entry.message}`;
}
