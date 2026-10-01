/**
 * The Zod schema for a raw jamal config default export. It checks shape,
 * types, and numeric ranges only; the value-safety checks (control characters,
 * reserved keys, path traversal) run afterwards in `safety.ts` so that every
 * rejection message stays value-free.
 */

import { z } from 'jsails/zod';

import { JAMAL_LOCAL_APP_MODES, JAMAL_SERVICE_TYPES } from './model.js';
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

const sshSchema: z.ZodObject<
  {
    user: z.ZodOptional<z.ZodString>;
    port: z.ZodOptional<z.ZodNumber>;
    proxyCommand: z.ZodOptional<z.ZodString>;
    logLevel: z.ZodOptional<z.ZodString>;
    keysOnly: z.ZodOptional<z.ZodBoolean>;
    keys: z.ZodOptional<z.ZodArray<z.ZodString>>;
    config: z.ZodOptional<z.ZodString>;
    forwardAgent: z.ZodOptional<z.ZodBoolean>;
  },
  z.core.$strict
> = z
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
    app: z.enum(JAMAL_LOCAL_APP_MODES).optional(),
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

const proxySchema = z
  .object({
    forwardHeaders: z.boolean().optional(),
    upstreamCidrs: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export const jamalConfigSchema: z.ZodObject<
  {
    service: z.ZodString;
    image: z.ZodString;
    command: z.ZodOptional<z.ZodString>;
    health: z.ZodOptional<
      z.ZodObject<
        {
          path: z.ZodString;
          timeoutMs: z.ZodNumber;
          intervalMs: z.ZodNumber;
          retries: z.ZodOptional<z.ZodNumber>;
          retryDelayMs: z.ZodOptional<z.ZodNumber>;
          readinessDelayMs: z.ZodOptional<z.ZodNumber>;
        },
        z.core.$strict
      >
    >;
    env: z.ZodOptional<
      z.ZodRecord<
        z.ZodString,
        z.ZodUnion<
          readonly [
            z.ZodString,
            z.ZodInstanceOf<SecretRef>,
            z.ZodObject<
              {
                value: z.ZodUnion<readonly [z.ZodString, z.ZodInstanceOf<SecretRef>]>;
                alias: z.ZodOptional<z.ZodString>;
                clear: z.ZodOptional<z.ZodBoolean>;
              },
              z.core.$strict
            >,
          ]
        >
      >
    >;
    services: z.ZodOptional<
      z.ZodRecord<
        z.ZodString,
        z.ZodObject<
          {
            type: z.ZodEnum<{
              adminer: 'adminer';
              mailpit: 'mailpit';
              mariadb: 'mariadb';
              meilisearch: 'meilisearch';
              opensearch: 'opensearch';
              postgres: 'postgres';
              s3: 's3';
              typesense: 'typesense';
              valkey: 'valkey';
            }>;
          },
          z.core.$strict
        >
      >
    >;
    volumes: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    local: z.ZodOptional<
      z.ZodObject<
        {
          ports: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
          app: z.ZodOptional<
            z.ZodEnum<{
              dev: 'dev';
              host: 'host';
              image: 'image';
            }>
          >;
        },
        z.core.$strict
      >
    >;
    production: z.ZodOptional<
      z.ZodObject<
        {
          server: z.ZodString;
          domain: z.ZodOptional<z.ZodString>;
          onDemandTlsUrl: z.ZodOptional<z.ZodString>;
          registry: z.ZodOptional<
            z.ZodObject<
              {
                server: z.ZodString;
                username: z.ZodString;
              },
              z.core.$strict
            >
          >;
          ssh: z.ZodOptional<
            z.ZodObject<
              {
                user: z.ZodOptional<z.ZodString>;
                port: z.ZodOptional<z.ZodNumber>;
                proxyCommand: z.ZodOptional<z.ZodString>;
                logLevel: z.ZodOptional<z.ZodString>;
                keysOnly: z.ZodOptional<z.ZodBoolean>;
                keys: z.ZodOptional<z.ZodArray<z.ZodString>>;
                config: z.ZodOptional<z.ZodString>;
                forwardAgent: z.ZodOptional<z.ZodBoolean>;
              },
              z.core.$strict
            >
          >;
          destination: z.ZodOptional<z.ZodString>;
          secretsPath: z.ZodOptional<z.ZodString>;
        },
        z.core.$strict
      >
    >;
    logging: z.ZodOptional<
      z.ZodObject<
        {
          driver: z.ZodString;
          options: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        },
        z.core.$strict
      >
    >;
    cacheProxy: z.ZodOptional<
      z.ZodObject<
        {
          enabled: z.ZodOptional<z.ZodBoolean>;
          image: z.ZodOptional<z.ZodString>;
          size: z.ZodOptional<z.ZodString>;
          cookieAllowlist: z.ZodOptional<z.ZodArray<z.ZodString>>;
        },
        z.core.$strict
      >
    >;
    proxy: z.ZodOptional<
      z.ZodObject<
        {
          forwardHeaders: z.ZodOptional<z.ZodBoolean>;
          upstreamCidrs: z.ZodOptional<z.ZodArray<z.ZodString>>;
        },
        z.core.$strict
      >
    >;
  },
  z.core.$strict
> = z
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
    proxy: proxySchema.optional(),
  })
  .strict();

/** The parsed (unresolved) shape produced by the schema. */
export type ParsedJamalConfig = z.infer<typeof jamalConfigSchema>;

/** The parsed shape of `production.ssh`. */
export type ParsedSshConfig = z.infer<typeof sshSchema>;

/**
 * One value-free line per issue, prefixed with its top-level `config.` field
 * only: nested keys under `env`, `services`, and `volumes` are author-chosen
 * names that must not surface in a rejection message, and every message is
 * derived from the schema, never from the input.
 */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      if (issue.code === 'unrecognized_keys') return 'config has an unrecognized field';
      const top = typeof issue.path[0] === 'string' ? issue.path[0] : 'config';
      return `config.${top}: ${issueMessage(issue)}`;
    })
    .join('; ');
}

function issueMessage(issue: z.ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `expected ${typeName(issue.expected)}`;
    case 'too_small':
      return `must be at least ${String(issue.minimum)}`;
    case 'too_big':
      return `must be at most ${String(issue.maximum)}`;
    case 'invalid_format':
      return 'invalid format';
    case 'invalid_value':
    case 'custom':
      return 'invalid value';
    default:
      return issue.code;
  }
}

function typeName(expected: string): string {
  switch (expected) {
    case 'string':
      return 'a string';
    case 'number':
    case 'int':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
    case 'record':
      return 'an object';
    case 'array':
    case 'tuple':
      return 'an array';
    default:
      return 'a valid value';
  }
}
