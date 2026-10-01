import type { PublicationDefinition } from './publication.js';
import { createServiceToken, type ServiceToken } from '../extensions/services.js';

/**
 * The publication registry: a name-keyed store of frozen publication
 * definitions (LIVE-PLAN.md §4.3).
 *
 * The registry is the only place a publication name resolves to a definition.
 * Clients subscribe by name, never by collection or scope, so duplicate names
 * are a configuration error rather than an ambiguity — registration time is
 * where that is caught, value-free.
 */

/**
 * A publication with its type parameters erased, as stored by the registry.
 * Callers only ever reach definitions through {@link PublicationRegistry.get} /
 * {@link PublicationRegistry.list}, so the erased params stay behind the
 * boundary (LIVE-PLAN.md §4.3).
 */
export type ErasedPublication = PublicationDefinition<unknown, object>;

export interface PublicationRegistry {
  register<TParams, TRow extends object>(definition: PublicationDefinition<TParams, TRow>): void;
  get(name: string): ErasedPublication | undefined;
  list(): readonly ErasedPublication[];
}

/**
 * The service token under which an application's publication registry is
 * provided.
 *
 * The registry is a caller-supplied object handed to `livePlugin` (the live
 * plugin is a consumer of the registry, not its owner), so the live plugin
 * publishes it under this token during `setup`. Publication-registering plugins
 * (e.g. the blog plugin's `blog.posts`) read the same token so every
 * publication lands in the one registry the live service resolves from. Token
 * identity is object identity, so provider and consumer must import this token.
 */
export const publicationRegistryToken: ServiceToken<PublicationRegistry> =
  createServiceToken<PublicationRegistry>('publicationRegistry');

/** Raised for a registry-level violation. Value-free: codes, never echoed names. */
export class PublicationRegistryError extends Error {
  readonly code: 'duplicate_publication';

  constructor() {
    super('a publication with this name is already defined');
    this.name = 'PublicationRegistryError';
    this.code = 'duplicate_publication';
  }
}

export function createPublicationRegistry(): PublicationRegistry {
  const definitions = new Map<string, ErasedPublication>();

  return {
    register(definition) {
      if (definitions.has(definition.name)) {
        throw new PublicationRegistryError();
      }
      // Variance: PublicationDefinition is contravariant in TParams, so a
      // concrete definition is not assignable to the erased form. The cast is
      // confined here; callers only reach definitions through get()/list().
      definitions.set(definition.name, definition as unknown as ErasedPublication);
    },
    get(name) {
      return definitions.get(name);
    },
    list() {
      // The array is a fresh snapshot so callers cannot mutate the registry's
      // internal map; the definitions themselves were frozen by
      // definePublication.
      return Object.freeze([...definitions.values()]);
    },
  };
}
