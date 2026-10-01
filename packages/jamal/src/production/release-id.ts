/**
 * Release ids: `YYYYMMDDHHMMSS-<sha12>`, the UTC time a release was prepared
 * and the first 12 hex digits of the commit it was built from.
 *
 * The id names a release's directory, its manifest, its image tag and its
 * containers. The time makes every deploy distinct, a redeploy of the same
 * commit included, and sorts ids in the order they were made; the commit
 * says what they contain. Twelve hex digits keep a container name readable
 * and are unique in any repository a person maintains.
 */

/** The shape of a release id. */
const RELEASE_ID = /^\d{14}-[0-9a-f]{12}$/;

/** How many hex digits of the commit an id carries. */
export const RELEASE_SHA_LENGTH = 12;

/** Whether `value` is a release id. */
export function isReleaseId(value: string): boolean {
  return RELEASE_ID.test(value);
}

/** The release id for a commit (`sha`, full or abbreviated hex) prepared at `at`. */
export function releaseIdFor(at: Date, sha: string): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const stamp =
    `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `${stamp}-${sha.slice(0, RELEASE_SHA_LENGTH).toLowerCase()}`;
}
