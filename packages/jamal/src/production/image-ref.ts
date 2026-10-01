/**
 * Image references pinned by digest.
 *
 * A release runs `repo@sha256:<digest>`, never `repo:tag`: a tag is a pointer
 * any later push can move, so a rollback or a second pull of a tag can run
 * bytes that were never deployed. {@link isPinnedImage} is the one test of
 * that form (a `repo:tag@sha256:…` reference is pinned too: Docker resolves
 * it by the digest and ignores the tag), and {@link pinnedRepoDigest} picks
 * the digest a registry holds for a repository out of an image's
 * `RepoDigests`, which is where the digest of a push or a pull is recorded.
 */

/** The digest part of a pinned reference: SHA-256 in lowercase hex. */
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** A repository (with an optional tag) as Docker writes it: no whitespace, no `@`. */
const REPOSITORY = /^[a-z0-9][A-Za-z0-9._:/-]*$/;

/** Whether `ref` names an image by digest (`repo@sha256:<64 hex>`). */
export function isPinnedImage(ref: string): boolean {
  const at = ref.indexOf('@');
  if (at <= 0) return false;
  return REPOSITORY.test(ref.slice(0, at)) && DIGEST.test(ref.slice(at + 1));
}

/** The repository of `ref`, without its tag or digest (`ghcr.io/acme/app`). */
export function imageRepository(ref: string): string {
  const at = ref.indexOf('@');
  const named = at === -1 ? ref : ref.slice(0, at);
  const slash = named.lastIndexOf('/');
  const colon = named.lastIndexOf(':');
  return colon > slash ? named.slice(0, colon) : named;
}

/**
 * The one `repo@sha256:…` entry of `repoDigests` (an image's `RepoDigests`)
 * for `repository`, or `undefined` when it has none or several different
 * ones. Docker Hub names an official image either way (`varnish`,
 * `docker.io/library/varnish`), so both spellings match.
 */
export function pinnedRepoDigest(
  repoDigests: readonly string[],
  repository: string,
): string | undefined {
  const wanted = new Set([repository, ...dockerHubAliases(repository)]);
  const digests = new Set(
    repoDigests
      .filter((entry) => isPinnedImage(entry) && wanted.has(imageRepository(entry)))
      .map((entry) => entry.slice(entry.indexOf('@') + 1)),
  );
  if (digests.size !== 1) return undefined;
  const [digest] = digests;
  return digest === undefined ? undefined : `${repository}@${digest}`;
}

/** The other spellings Docker gives a Docker Hub repository; none for another registry. */
function dockerHubAliases(repository: string): readonly string[] {
  const bare = repository.replace(/^docker\.io\//, '').replace(/^library\//, '');
  const first = bare.split('/', 1)[0] ?? '';
  const registry = first.includes('.') || first.includes(':') || first === 'localhost';
  if (bare.includes('/') && registry) return [];
  const official = bare.includes('/') ? bare : `library/${bare}`;
  return [bare, official, `docker.io/${official}`];
}
