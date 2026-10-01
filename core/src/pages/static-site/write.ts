/**
 * Staging, ownership, and commit for {@link generateStaticSite}.
 *
 * Writes the ownership marker, rendered pages (as each one is rendered),
 * generated files, and copied assets into a sibling staging directory, then
 * swaps it into `outDir`. Guards reject an unsafe or
 * unowned output directory before anything is written, and a failed swap
 * restores the prior output instead of deleting arbitrary paths.
 */

import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
} from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';

import { isPathInside, relativePathInside } from '../../support/path-containment.server.js';

import type { RouteManifest } from '../../routing/routes.js';
import { isErrno } from '../../errors/inspect.js';
import { StaticSiteError } from './plan.js';
import type { PlannedAsset } from './public-assets.js';
import { toPosixId } from '../../support/project-paths.server.js';

/** Fixed marker proving a non-empty output directory belongs to this build. */
const MARKER_FILE = '.jsails-static-site.json';
const MARKER_CONTENTS = `${JSON.stringify({ generator: 'jsails', version: 1 })}\n`;

/** Write the ownership marker that lets a later build replace this output. */
export async function writeStagingMarker(staging: string): Promise<void> {
  await writeFile(join(staging, MARKER_FILE), MARKER_CONTENTS);
}

/** Write one rendered page or generated file at its posix `rel` path. */
export async function writeStagedFile(
  staging: string,
  rel: string,
  contents: string,
): Promise<void> {
  const target = join(staging, ...rel.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

/** Copy every planned public asset into staging. */
export async function copyStagedAssets(staging: string, assets: PlannedAsset[]): Promise<void> {
  for (const asset of assets) {
    const target = join(staging, ...asset.rel.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(asset.from, target);
  }
}

/**
 * Swap staging into `outDir`. An owned existing directory is moved aside first
 * and restored if the swap fails; only the moved-aside backup and staging (both
 * created here) are ever removed.
 */
export function commitStaging(staging: string, outDir: string, existed: boolean): void {
  if (!existed) {
    renameSync(staging, outDir);
    return;
  }

  const backup = uniqueSibling(outDir);
  renameSync(outDir, backup);
  try {
    renameSync(staging, outDir);
  } catch (error) {
    try {
      renameSync(backup, outDir);
    } catch {
      // Restore failed: leave the backup in place rather than deleting output.
    }
    throw error;
  }
  try {
    rmSync(backup, { recursive: true, force: true });
  } catch {
    // The new output is live; a stray backup is preferable to failing the build.
  }
}

/** Return a same-parent path that does not collide with the target. */
function uniqueSibling(target: string): string {
  return join(
    dirname(target),
    `.jsails-old-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  );
}

/**
 * Confirm `outDir` is a usable target: an absent or empty directory, or a
 * non-empty one carrying the build's exact ownership marker. A regular file
 * that merely shares the marker name (foreign, forged, or truncated contents)
 * is refused. Never deletes anything.
 */
export function inspectOutput(outDir: string): boolean {
  let stat: Stats;
  try {
    stat = lstatSync(outDir);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new StaticSiteError(
      'unsafe_output_dir',
      `output directory "${outDir}" must not be a symlink`,
    );
  }
  if (!stat.isDirectory()) {
    throw new StaticSiteError(
      'unsafe_output_dir',
      `output path "${outDir}" exists and is not a directory`,
    );
  }
  if (readdirSync(outDir).length === 0) return true;

  const marker = join(outDir, MARKER_FILE);
  let markerStat: Stats;
  try {
    markerStat = lstatSync(marker);
  } catch {
    throw new StaticSiteError(
      'unsafe_output_dir',
      `refusing to overwrite non-empty output directory "${outDir}" without ownership marker "${MARKER_FILE}"`,
    );
  }
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    throw new StaticSiteError(
      'unsafe_output_dir',
      `refusing to overwrite "${outDir}": ownership marker "${MARKER_FILE}" is not a regular file`,
    );
  }
  let contents: string;
  try {
    contents = readFileSync(marker, 'utf8');
  } catch {
    throw new StaticSiteError(
      'unsafe_output_dir',
      `refusing to overwrite "${outDir}": ownership marker "${MARKER_FILE}" cannot be read`,
    );
  }
  if (contents !== MARKER_CONTENTS) {
    throw new StaticSiteError(
      'unsafe_output_dir',
      `refusing to overwrite "${outDir}": ownership marker "${MARKER_FILE}" is invalid or foreign`,
    );
  }
  return true;
}

/** Reject an output directory that would contain sources or an asset root. */
export function assertOutDirSafety(
  outDir: string,
  manifest: RouteManifest,
  assetRoots: readonly string[],
): void {
  // A not-found module is a build input too (it renders 404.html) but is not
  // listed in `entries`.
  const modules = [...manifest.entries, ...(manifest.notFound ?? [])].map((entry) => entry.file);
  for (const source of modules) {
    const file = resolve(source);
    if (file === outDir || isInside(outDir, file)) {
      throw new StaticSiteError(
        'unsafe_output_dir',
        `outDir "${outDir}" must not be or contain manifest module "${file}"`,
      );
    }
  }
  for (const publicDir of assetRoots) {
    if (publicDir === outDir || isInside(outDir, publicDir)) {
      throw new StaticSiteError(
        'unsafe_output_dir',
        `outDir "${outDir}" must not equal or contain publicDir "${publicDir}"`,
      );
    }
    if (isInside(publicDir, outDir)) {
      throw new StaticSiteError(
        'unsafe_output_dir',
        `outDir "${outDir}" must not be inside publicDir "${publicDir}"`,
      );
    }
  }
}

/**
 * Reject a symlink at any existing component of the output path that is not
 * part of `root`'s own ancestry.
 *
 * `root` and the directories above it are the operator's filesystem layout (a
 * symlinked home, macOS `/var` -> `/private/var`, a mounted volume) and are
 * trusted as they are. Every other component is one the build writes through:
 * a symlink there, such as one checked into the project tree, would redirect
 * the staging directory, the swap, and the removal of the moved-aside backup
 * to wherever it points, so it is refused. An `outDir` outside `root` is
 * checked from the deepest directory it shares with `root`.
 *
 * `root` may be spelled differently from `outDir` (the working directory is a
 * real path, while `os.tmpdir()` on macOS sits under the `/var` symlink), so
 * the trusted prefix of `outDir` is the longer of two: the components that are
 * lexical ancestors of `root`, and the components up to the shortest prefix
 * of `outDir` that resolves to `root` itself. Only the latter is consulted
 * physically. A symlink that merely resolves to a directory above `root`
 * (`/tmp/link -> /`) is not trusted, and a symlink inside the project that
 * points back at `root` is still refused, because the shortest prefix that
 * resolves to `root` lies above it.
 *
 * One more kind of link is trusted: the operating system's own layout,
 * such as macOS `/var`, `/tmp` and `/etc` pointing into `/private`, or a
 * usr-merged Linux linking `/bin` to `usr/bin`. That lets an `outDir` under
 * the system temp directory work on every platform. Such a link sits
 * directly in the filesystem root, the superuser owns it and the root, the
 * root is writable by nobody else, and the build is not itself the
 * superuser. Only the superuser can make or replace an entry there, the
 * root is never itself a link or a shared or remote mount, and no checkout
 * places files in it, so ownership there means what it says. Ownership
 * anywhere deeper does not: a hard link to a root-owned symlink can be
 * planted in a shared directory, a checkout copied in by root is root-owned
 * for the user who builds it, and some filesystems report every file as the
 * superuser's. So a link below the top level, whoever owns it, is refused,
 * and so is any link inside the project. The path a trusted link points to
 * must be the system's as well, with no link in it and every component held
 * in a directory only the superuser can change, so the link cannot lead into
 * a directory someone else can repoint or replace.
 * Windows reports no owners, so there no link is trusted this way.
 * `isSystemLink` replaces that test, so a test can stand in for a system link.
 */
export function assertNoSymlinkAncestors(
  target: string,
  root: string,
  isSystemLink: (path: string, stat: Stats) => boolean = operatingSystemLink,
): void {
  const abs = resolve(target);
  const lexicalRoot = resolve(root);
  const { root: filesystemRoot } = parse(abs);
  const prefixes: string[] = [];
  let prefix = filesystemRoot;
  for (const segment of toPosixId(abs.slice(filesystemRoot.length)).split('/')) {
    if (segment === '') continue;
    prefix = join(prefix, segment);
    prefixes.push(prefix);
  }
  const physicalRoot = physicalPath(lexicalRoot);
  const trusted = Math.max(
    lexicalAncestryLength(prefixes, lexicalRoot),
    physicalAncestryLength(prefixes, physicalRoot),
  );
  for (const current of prefixes.slice(trusted)) {
    let stat: Stats;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (!inProject(current, lexicalRoot, physicalRoot) && isSystemLink(current, stat)) continue;
      throw new StaticSiteError(
        'unsafe_output_dir',
        `output path ancestry "${current}" is a symlink outside the project root's ancestry`,
      );
    }
  }
}

/**
 * Whether the link at `path` lies inside the project, judged by where the
 * link itself is (its parent's real path and its name), not where it points:
 * a link spelled through a system link above it (`/var/app/link` for a root
 * at `/private/var/app`) is still the project's. A build running as the
 * superuser owns every file it checked out, so ownership alone cannot clear
 * a link inside the project.
 */
function inProject(path: string, lexicalRoot: string, physicalRoot: string): boolean {
  if (isPathInside(lexicalRoot, path)) return true;
  let location: string;
  try {
    location = join(realpathSync(dirname(path)), basename(path));
  } catch {
    // Its parent cannot be resolved: it cannot be cleared as outside.
    return true;
  }
  return isPathInside(physicalRoot, location);
}

/** What {@link isOperatingSystemLink} reads: the link, its directory, and the build process. */
export interface SystemLinkFacts {
  readonly link: Pick<Stats, 'uid' | 'isSymbolicLink'>;
  /** Whether the link is an entry of the filesystem root itself. */
  readonly atFilesystemRoot: boolean;
  /**
   * Whether the path the link points to is the system's too: every component
   * a real directory, not a link, and each one held in a directory the
   * superuser owns and nobody else can write. An admin's
   * `/scratch -> /home/alice/s` would otherwise hand the build to whoever can
   * repoint or replace `s`.
   */
  readonly targetIsSystem: boolean;
  /** The filesystem root the link sits in. */
  readonly filesystemRoot: Pick<Stats, 'uid' | 'mode'>;
  readonly platform: NodeJS.Platform;
  /** The build's effective user id; `undefined` where the platform has none. */
  readonly euid: number | undefined;
}

/** Group- and other-write permission bits. */
const SHARED_WRITE = 0o022;

/**
 * Whether a link is the operating system's: an entry of the filesystem
 * root, which the superuser owns along with the link and nobody else can
 * write, seen by a build that runs as some other user on a platform that
 * reports owners.
 */
export function isOperatingSystemLink(facts: SystemLinkFacts): boolean {
  const { link, atFilesystemRoot, targetIsSystem, filesystemRoot, platform, euid } = facts;
  if (platform === 'win32' || euid === undefined || euid === 0) return false;
  if (!atFilesystemRoot || !targetIsSystem) return false;
  return link.isSymbolicLink() && link.uid === 0 && superuserOnly(filesystemRoot);
}

/** A directory only the superuser can change the entries of. */
function superuserOnly(stat: Pick<Stats, 'uid' | 'mode'>): boolean {
  return stat.uid === 0 && (stat.mode & SHARED_WRITE) === 0;
}

/**
 * Whether every component of `path` is a directory, none a link, held in a
 * directory only the superuser can change (the filesystem root is checked by
 * the caller). The last component may itself be shared, as `/private/tmp` is.
 */
export function systemDirectoryPath(path: string): boolean {
  const { root } = parse(path);
  let prefix = root;
  for (const segment of toPosixId(path.slice(root.length)).split('/')) {
    if (segment === '') continue;
    const parent = prefix;
    prefix = join(prefix, segment);
    try {
      if (parent !== root && !superuserOnly(lstatSync(parent))) return false;
      if (!lstatSync(prefix).isDirectory()) return false;
    } catch {
      // Missing or unreadable: it cannot be cleared.
      return false;
    }
  }
  return true;
}

function operatingSystemLink(path: string, stat: Stats): boolean {
  const { root } = parse(path);
  if (dirname(path) !== root) return false;
  let filesystemRoot: Stats;
  let target: string;
  try {
    filesystemRoot = lstatSync(root);
    target = resolve(root, readlinkSync(path));
  } catch {
    // The root or the link cannot be read: it cannot be cleared as the system's.
    return false;
  }
  return isOperatingSystemLink({
    link: stat,
    atFilesystemRoot: true,
    targetIsSystem: systemDirectoryPath(target),
    filesystemRoot,
    platform: process.platform,
    euid: process.geteuid?.(),
  });
}

/** How many leading `prefixes` are `root` or a lexical ancestor of it. */
function lexicalAncestryLength(prefixes: readonly string[], root: string): number {
  let length = 0;
  for (const prefix of prefixes) {
    if (!isPathInside(prefix, root)) break;
    length += 1;
  }
  return length;
}

/**
 * How many leading `prefixes` reach the shortest one whose real path is
 * `physicalRoot`, or 0 when none does. Resolution stops at the first prefix
 * that cannot be resolved (missing, a loop, unreadable), since nothing below
 * it can resolve either.
 */
function physicalAncestryLength(prefixes: readonly string[], physicalRoot: string): number {
  for (const [index, prefix] of prefixes.entries()) {
    let real: string;
    try {
      real = realpathSync(prefix);
    } catch {
      // Unresolvable: no deeper prefix resolves to the root, so none is trusted
      // physically; the lstat walk reports what is wrong with it.
      return 0;
    }
    if (relativePathInside(physicalRoot, real) === '') return index + 1;
  }
  return 0;
}

/**
 * The real path of `path`, or, when it does not exist yet, the real path of
 * its deepest existing ancestor joined with the missing tail.
 */
function physicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    const parent = dirname(path);
    if (!isErrno(error, 'ENOENT') || parent === path) return path;
    return join(physicalPath(parent), basename(path));
  }
}

/** True when `child` is strictly below directory `parent`. */
function isInside(parent: string, child: string): boolean {
  const rel = relativePathInside(parent, child);
  return rel !== undefined && rel !== '';
}
