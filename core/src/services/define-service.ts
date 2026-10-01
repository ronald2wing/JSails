/**
 * Domain services: a reusable unit of work shared by jobs, commands, pages, and
 * APIs.
 *
 * A service is input schema + `run`. Calling it validates the input and returns
 * the result. It is not a job and not a command: jobs and commands are delivery
 * adapters, the service is the work they both call.
 */

import type { z } from 'zod';

import { mapZodIssues } from '../internal/zod.js';
import type { FieldError } from '../validation/rules.js';

/** A value-free service failure. */
export class ServiceError extends Error {
  readonly code: 'invalid_definition' | 'invalid_input';

  constructor(code: ServiceError['code'], message: string) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

/** Invalid service input, carrying field-level errors. */
export class ServiceInputError extends ServiceError {
  readonly errors: readonly FieldError[];

  constructor(serviceName: string | undefined, errors: readonly FieldError[]) {
    super(
      'invalid_input',
      serviceName === undefined
        ? 'service input is invalid'
        : `service "${serviceName}" input is invalid`,
    );
    this.name = 'ServiceInputError';
    this.errors = Object.freeze([...errors]);
  }
}

/** The object accepted by {@link defineService}. */
export interface ServiceDefinition<S extends z.ZodType, R> {
  /** Optional diagnostic name; never used as a queue or route identity. */
  readonly name?: string;
  /** Runtime input validation and the source of the handler's input type. */
  readonly input: S;
  /** The work. Receives already-validated input. */
  readonly run: (input: z.infer<S>) => R | Promise<R>;
}

/** The callable returned by {@link defineService}. */
export type ServiceFn<S extends z.ZodType, R> = ((input: z.infer<S>) => Promise<R>) & {
  readonly input: S;
  readonly serviceName?: string;
};

/**
 * Base class for a service that groups related operations.
 *
 * A subclass holds its dependencies (or the data an operation acts on) and
 * declares each operation with `this.action(...)`; the returned function is a
 * normal validated service. Static declarations use the static `action`.
 */
export abstract class Service {
  protected static action<const S extends z.ZodType, R>(
    definition: ServiceDefinition<S, R>,
  ): ServiceFn<S, R> {
    return defineService(definition);
  }

  protected action<const S extends z.ZodType, R>(
    definition: ServiceDefinition<S, R>,
  ): ServiceFn<S, R> {
    return defineService(definition);
  }
}

/**
 * Build a callable service. `input` is parsed before `run`; a validation
 * failure throws {@link ServiceInputError} with value-free field errors.
 */
export function defineService<const S extends z.ZodType, R>(
  definition: ServiceDefinition<S, R>,
): ServiceFn<S, R> {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new ServiceError('invalid_definition', 'defineService requires an options object');
  }
  const input = definition.input;
  if (input === null || typeof input !== 'object' || typeof input.safeParse !== 'function') {
    throw new ServiceError('invalid_definition', 'service input must be a Zod schema');
  }
  if (typeof definition.run !== 'function') {
    throw new ServiceError('invalid_definition', 'service run must be a function');
  }
  if (
    definition.name !== undefined &&
    (typeof definition.name !== 'string' || definition.name.trim() === '')
  ) {
    throw new ServiceError('invalid_definition', 'service name must be a non-empty string');
  }

  const service = async (raw: z.infer<S>): Promise<R> => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) {
      const errors = mapZodIssues(parsed.error).map((issue) => ({
        field: issue.path,
        message: issue.message,
      }));
      throw new ServiceInputError(definition.name, errors);
    }
    return definition.run(parsed.data);
  };

  Object.defineProperty(service, 'input', { value: input, enumerable: false });
  if (definition.name !== undefined) {
    Object.defineProperty(service, 'serviceName', {
      value: definition.name,
      enumerable: false,
    });
  }
  return service as ServiceFn<S, R>;
}
