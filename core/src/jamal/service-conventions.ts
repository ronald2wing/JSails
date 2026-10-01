/**
 * Pinned container conventions for the backing services Jamal runs both
 * locally (`jamal dev`, via `.jamal/compose.yml`) and in production (as
 * accessories started over SSH). Keeping one table means a local container and
 * its production counterpart can never drift onto different images or data
 * volumes; a version bump here moves both.
 */

/** Image, listening port, named data volume, and in-container data directory. */
export interface ServiceConvention {
  readonly image: string;
  readonly port: number;
  readonly volume: string;
  readonly dataDir: string;
}

/** Backing service types that run in development and production alike. */
export type AccessoryServiceType = 'mariadb' | 'postgres' | 'valkey';

export const SERVICE_CONVENTIONS: Readonly<Record<AccessoryServiceType, ServiceConvention>> =
  Object.freeze({
    mariadb: Object.freeze({
      image: 'mariadb:11.4',
      port: 3306,
      volume: 'mariadb-data',
      dataDir: '/var/lib/mysql',
    }),
    postgres: Object.freeze({
      image: 'postgres:16-alpine',
      port: 5432,
      volume: 'postgres-data',
      dataDir: '/var/lib/postgresql/data',
    }),
    valkey: Object.freeze({
      image: 'valkey/valkey:8.0-alpine',
      port: 6379,
      volume: 'valkey-data',
      dataDir: '/data',
    }),
  });

/** True for a service type that also runs as a production accessory. */
export function isAccessoryServiceType(type: string): type is AccessoryServiceType {
  return Object.hasOwn(SERVICE_CONVENTIONS, type);
}
