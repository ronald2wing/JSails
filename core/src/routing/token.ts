/**
 * {@link routeManifestToken}, the service the `routing` plugin provides the
 * discovered route manifest under. Kept apart from the plugin so the routing
 * contract (`jsails/routing`) names it without loading the plugin contract
 * and its options schema.
 */

import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import type { RouteManifest } from './routes.js';

/**
 * Opaque token for the discovered {@link RouteManifest}. Defined once here and
 * shared by the provider (`routingPlugin`) and every consumer (the pipeline,
 * static export, introspection, and the public `Application.manifest` field).
 */
export const routeManifestToken: ServiceToken<RouteManifest> =
  createServiceToken<RouteManifest>('route-manifest');
