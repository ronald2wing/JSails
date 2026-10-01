/**
 * Test helpers for apps on `@jsails/inertia` (`@jsails/inertia/testing`):
 * build the request an Inertia v3 client sends, read the page object out of
 * either response representation, and open the flash and errors carrier a
 * response sets.
 */

export {
  inertiaRequest,
  INERTIA_TEST_ORIGIN,
  type InertiaPartialInit,
  type InertiaRequestInit,
} from './inertia-request.js';
export { readInertiaPage, type ReadInertiaPageOptions } from './read-page.js';
export { openCarrier, type OpenCarrierOptions } from './open-carrier.js';
