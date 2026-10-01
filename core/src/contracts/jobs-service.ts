/**
 * The jobs service contract: the producer-only dispatch surface the `jobs`
 * plugin provides, and its token. It lives with the contracts, not with the
 * jobs runtime, so a plugin that only dispatches (the mail plugin's queue)
 * declares the token without loading BullMQ, the job discovery or the
 * database reach the runtime pulls in. `jsails/jobs` and `jsails/internal`
 * export the same objects.
 */

import { createServiceToken, type ServiceToken } from '../extensions/services.js';

/**
 * The service the `jobs` plugin provides: a producer-only dispatch surface.
 *
 * @public
 */
export interface JobsService {
  /** Validate and enqueue a job named in the registry. */
  dispatch(name: string, payload: unknown, opts?: unknown): Promise<unknown>;
}

/**
 * Opaque token for the {@link JobsService}. Defined once here and shared by the
 * provider (`jobsPlugin`) and any consumer (e.g. an extension's `requires`).
 *
 * @public
 */
export const jobsToken: ServiceToken<JobsService> = createServiceToken<JobsService>('jobs');
