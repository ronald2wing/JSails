/**
 * Constants shared by both ends of the RFC 8628 device flow: the server side
 * (Better Auth's device authorization plugin, which allowlists the client id)
 * and the CLI client that requests and redeems device codes. Both also fall
 * back to the same app base URL, so a default server and a default CLI agree.
 */

/** The RFC 8628 client id the CLI presents and the server allowlists. */
export const DEVICE_CLIENT_ID = 'jsails-cli';

/** The RFC 8628 device grant type. */
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Public base URL when neither an option nor an environment variable sets one. */
export const DEFAULT_BASE_URL = 'http://localhost:3000';
