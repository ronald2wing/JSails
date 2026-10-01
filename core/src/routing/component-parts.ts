/**
 * Which files of a project are parts of a `.jsails` component rather than
 * modules of their own: the members of a component folder (`D/x/x.jsails`,
 * `x.ts`, `x.css`, `x.scoped.css`, `x.server.ts`) and the server module
 * beside a single file (`D/x.server.ts` beside `D/x.jsails`).
 *
 * The compiler's layouts (`compiler/sfc/layout.ts`), the project scans and
 * route discovery read this one rule. It lives with routing because route
 * discovery runs in the serving runtime, which does not load the compiler;
 * the other authoring conventions are in `compiler/conventions.ts`. Pure:
 * `exists` is the caller's.
 */

/** What a file of a `.jsails` component folder holds. */
export type SfcFolderRole = 'template' | 'script' | 'style' | 'scopedStyle' | 'server';

/**
 * The file name suffix of each folder role, after the component's name; the
 * longer suffix of a pair is tried first (`.scoped.css` before `.css`).
 */
export const SFC_FOLDER_SUFFIXES: Readonly<Record<SfcFolderRole, string>> = Object.freeze({
  template: '.jsails',
  script: '.ts',
  style: '.css',
  scopedStyle: '.scoped.css',
  server: '.server.ts',
});

const FOLDER_ROLES_BY_LENGTH: readonly SfcFolderRole[] = Object.freeze(
  (Object.keys(SFC_FOLDER_SUFFIXES) as SfcFolderRole[]).sort(
    (a, b) => SFC_FOLDER_SUFFIXES[b].length - SFC_FOLDER_SUFFIXES[a].length,
  ),
);

/** A path named like a member of a `.jsails` component folder. */
export interface SfcFolderMember {
  readonly role: SfcFolderRole;
  /** The component's path: `D/x.jsails` for the folder `D/x/`. */
  readonly component: string;
  /** The folder's template file, `D/x/x.jsails`, whose presence makes it a folder. */
  readonly template: string;
}

/**
 * The folder member a project-relative posix path is named as: a file in a
 * directory `D/x/` whose name is `x` plus a role's suffix (`x.jsails`,
 * `x.ts`, `x.css`, `x.scoped.css`, `x.server.ts`). A `.jsails` file named
 * after its directory is always a component folder's template, so the folder
 * a component lives in is decided by its path alone; any other member belongs
 * to a folder only when that template exists.
 */
export function sfcFolderMember(posixRelPath: string): SfcFolderMember | undefined {
  const segments = posixRelPath.split('/');
  if (segments.length < 2) return undefined;
  const name = segments[segments.length - 1] ?? '';
  const directory = segments[segments.length - 2] ?? '';
  const role = FOLDER_ROLES_BY_LENGTH.find(
    (candidate) => name === `${directory}${SFC_FOLDER_SUFFIXES[candidate]}`,
  );
  if (role === undefined || directory === '') return undefined;
  const parent = segments.slice(0, -2);
  return Object.freeze({
    role,
    component: [...parent, `${directory}.jsails`].join('/'),
    template: [...segments.slice(0, -1), `${directory}.jsails`].join('/'),
  });
}

/**
 * Whether a project-relative posix path is a part of a `.jsails` component
 * rather than a module of its own: a member of a component folder other than
 * its template (`components/card/card.ts`, `card.css`, `card.server.ts`
 * beside `components/card/card.jsails`), or the server module beside a
 * single file (`pages/about.server.ts` beside `pages/about.jsails`; the
 * server module is a `.server.ts` file, as the layouts name it). A scan
 * of modules (routes, the component registry, the autoload projection)
 * skips parts: the component's `.jsails` file stands for them. `exists`
 * answers whether a project path is a file.
 */
export function isSfcComponentPart(
  posixRelPath: string,
  exists: (posixRelPath: string) => boolean,
): boolean {
  const member = sfcFolderMember(posixRelPath);
  if (member !== undefined && member.role !== 'template' && exists(member.template)) return true;
  if (!posixRelPath.endsWith(SFC_FOLDER_SUFFIXES.server)) return false;
  const base = posixRelPath.slice(0, -SFC_FOLDER_SUFFIXES.server.length);
  return base !== '' && !base.endsWith('/') && exists(`${base}${SFC_FOLDER_SUFFIXES.template}`);
}
