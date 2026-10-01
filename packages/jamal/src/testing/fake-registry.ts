/**
 * A container registry and a developer machine's Docker, as test models.
 *
 * {@link FakeRegistry} maps image references (`repo:tag`) to image digests
 * the way a real registry does: a tag is a movable pointer, so pushing the
 * same tag again repoints it and the earlier digest is only reachable by
 * digest. {@link createLocalDocker} is the {@link ProcessRunner} a deploy's
 * local steps run through (`docker buildx build -t <ref> .`,
 * `docker push <ref>`, and `docker image inspect` of the pushed image's
 * `RepoDigests`): the build turns whatever the caller says the build context
 * holds into a digest, so two builds of different trees get different
 * digests under one tag, which is exactly how a mutable tag goes wrong in
 * production; the push records the digest the registry gave it, as Docker
 * does, so the deploy can run the image by that digest.
 *
 * Nothing here spawns a process or opens a connection. A command the model
 * does not know is answered with exit 127 and recorded, so a test can assert
 * that the engine ran only modelled commands.
 */

import { createHash } from 'node:crypto';

import type { CommandResult, ProcessRunner } from '../production/process-runner.js';

/** How an app image behaves once it runs in a container. */
export interface FakeImageBehaviour {
  /** Whether the app answers its health probe; a healthy app is the default. */
  readonly healthy?: boolean;
}

/** One image: its content digest, its repository, and how it behaves. */
export interface FakeImage {
  /** `sha256:<64 hex>`. */
  readonly digest: string;
  /** The reference's repository, `ghcr.io/acme/app` of `ghcr.io/acme/app:abc123`. */
  readonly repository: string;
  readonly healthy: boolean;
}

/** The digest of an image whose build context is `content`. */
export function imageDigest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/** The repository of `ref`: everything before the tag or digest. */
export function imageRepository(ref: string): string {
  const at = ref.indexOf('@');
  if (at !== -1) return ref.slice(0, at);
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  return colon > slash ? ref.slice(0, colon) : ref;
}

/** A registry: references pointing at images, and every image ever pushed by digest. */
export class FakeRegistry {
  readonly #tags = new Map<string, string>();
  readonly #images = new Map<string, FakeImage>();

  /** Point `ref` at `image`, replacing whatever the tag pointed at before. */
  push(ref: string, image: FakeImage): void {
    this.#images.set(image.digest, image);
    this.#tags.set(ref, image.digest);
  }

  /** The image `ref` points at now (`repo:tag` or `repo@sha256:...`), if any. */
  resolve(ref: string): FakeImage | undefined {
    const at = ref.indexOf('@');
    const digest = at === -1 ? this.#tags.get(ref) : ref.slice(at + 1);
    return digest === undefined ? undefined : this.#images.get(digest);
  }

  /** Whether anything was ever pushed to `repository`. */
  hasRepository(repository: string): boolean {
    return [...this.#images.values()].some((image) => image.repository === repository);
  }

  /** The digest `ref` points at now, if any. */
  digestOf(ref: string): string | undefined {
    return this.resolve(ref)?.digest;
  }
}

/** What a local build produces from the current build context. */
export interface FakeBuildContext {
  /** Everything the image is built from; equal content gives an equal digest. */
  readonly content: string;
  readonly behaviour?: FakeImageBehaviour;
}

/** Options for {@link createLocalDocker}. */
export interface LocalDockerOptions {
  readonly registry: FakeRegistry;
  /** Read the build context at the moment `docker buildx build` runs. */
  readonly context: () => FakeBuildContext | Promise<FakeBuildContext>;
}

/** A developer machine's Docker as a {@link ProcessRunner}, plus what it saw. */
export interface LocalDocker {
  readonly runner: ProcessRunner;
  /** The argvs the model did not know. */
  readonly unmodelled: readonly (readonly string[])[];
}

/**
 * A local Docker that builds from {@link LocalDockerOptions.context} into its
 * own image store and pushes to the registry. `buildx build` tags the local
 * image; `push` points the registry's reference at it.
 */
export function createLocalDocker(options: LocalDockerOptions): LocalDocker {
  const local = new Map<string, FakeImage>();
  /** The `repo@sha256:…` references each local image was pushed as, by digest. */
  const repoDigests = new Map<string, Set<string>>();
  const unmodelled: (readonly string[])[] = [];
  const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
  const fail = (exitCode: number, stderr: string): CommandResult => ({
    exitCode,
    stdout: '',
    stderr,
  });

  const runner: ProcessRunner = async (argv) => {
    const [docker, verb, ...rest] = argv;
    if (docker === 'docker' && verb === 'buildx' && rest[0] === 'build') {
      const tagAt = rest.indexOf('-t');
      const ref = tagAt === -1 ? undefined : rest[tagAt + 1];
      if (ref === undefined) return fail(1, 'buildx: no tag');
      const context = await options.context();
      local.set(ref, {
        digest: imageDigest(context.content),
        repository: imageRepository(ref),
        healthy: context.behaviour?.healthy ?? true,
      });
      return ok();
    }
    if (docker === 'docker' && verb === 'push' && rest.length === 1) {
      const ref = rest[0]!;
      const image = local.get(ref);
      if (image === undefined) return fail(1, 'push: no such image');
      options.registry.push(ref, image);
      const pinned = repoDigests.get(image.digest) ?? new Set<string>();
      pinned.add(`${image.repository}@${image.digest}`);
      repoDigests.set(image.digest, pinned);
      return ok();
    }
    if (
      docker === 'docker' &&
      verb === 'image' &&
      rest[0] === 'inspect' &&
      rest[1] === '--format' &&
      rest[2] === '{{json .RepoDigests}}' &&
      rest.length === 4
    ) {
      const image = local.get(rest[3]!);
      if (image === undefined) return fail(1, 'No such image');
      return ok(`${JSON.stringify([...(repoDigests.get(image.digest) ?? [])].sort())}\n`);
    }

    unmodelled.push([...argv]);
    return fail(127, 'not modelled by the local docker model');
  };

  return { runner, unmodelled };
}
