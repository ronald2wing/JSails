/**
 * Blog revisions admin page: lists a post's or page's recorded revisions
 * newest-first and restores a selected snapshot onto the entry.
 *
 * A revision is looked up within its (entry type, entry id) scope, so a snapshot
 * can never be restored into a different entry than it was recorded against. An
 * unknown entry type or action is a value-free 400; an unknown entry or revision
 * is a value-free 404.
 */

import type { JsonValue } from 'jsails/plugin-sdk';
import { h, type ComponentChild } from 'preact';

import {
  actionForm,
  adminBadRequestResponse,
  adminNotFoundResponse,
  adminRedirectResponse,
  defineAdminPage,
  hiddenInput,
  panelDocumentOptions,
  renderAdminDocumentWithTheme,
  renderNotice,
  type AdminPage,
  type AdminPagePostContext,
  type AdminPageRenderContext,
} from '@jsails/admin';

import {
  pageSnapshotSchema,
  postSnapshotSchema,
  type BlogRepository,
  type BlogPageSnapshot,
  type BlogPostSnapshot,
  type BlogRevision,
} from '../cms/index.js';
import { BLOG_PAGE_GROUP, blogPagePath, type BlogAdminPageOptions } from './page-frame.js';

/** Revisions page slug and label. */
const REVISIONS_SLUG = 'revisions';
const REVISIONS_LABEL = 'Revisions';

/** A revision entry type, narrowed to the two content collections. */
type RevisionEntryType = 'post' | 'page';

/** The restore POST action the page accepts. */
const RESTORE_ACTION = 'restore';

/** The `?notice=` value rendered after a successful restore. */
const RESTORED_NOTICE = 'restored';

/** Narrow a query/body value to a supported entry type, or `null`. */
function toEntryType(value: unknown): RevisionEntryType | null {
  return value === 'post' || value === 'page' ? value : null;
}

/**
 * The entry id query value, or `null` when absent/blank. Ids are opaque, so the
 * only validation is presence; existence is checked against the repository.
 */
function toEntryId(value: unknown): string | null {
  const id = typeof value === 'string' ? value.trim() : '';
  return id === '' ? null : id;
}

/** True when the entry type/id query pair names a known post or page. */
async function entryExists(
  repository: BlogRepository,
  entryType: RevisionEntryType,
  entryId: string,
): Promise<boolean> {
  return entryType === 'post'
    ? (await repository.getPost(entryId)) !== undefined
    : (await repository.getPage(entryId)) !== undefined;
}

/** Resolve a revision by id within the (type, entry) scope. */
async function findRevision(
  repository: BlogRepository,
  entryType: RevisionEntryType,
  entryId: string,
  revisionId: string,
): Promise<BlogRevision | undefined> {
  const revisions = await repository.listRevisions(entryType, entryId);
  return revisions.find((revision) => revision.id === revisionId);
}

/** Build the revisions {@link AdminPage}: list + restore over post/page revisions. */
export function defineBlogRevisionsAdminPage(options: BlogAdminPageOptions): AdminPage {
  const { repository } = options;

  return defineAdminPage({
    slug: REVISIONS_SLUG,
    label: REVISIONS_LABEL,
    group: BLOG_PAGE_GROUP,
    render: (context) => renderRevisionsPage(context, repository, options.path),
    handleGet: (context) => guardRevisionsGet(context, repository),
    handlePost: (context) => handleRevisionsPost(context, repository, options.path),
  });
}

/**
 * Validate the `GET` query before `render` runs: a present-but-unknown
 * `entryType` is a value-free 400, and a valid type whose `entryId` names no
 * existing entry is a value-free 404. Without query params the page renders the
 * lookup form.
 */
async function guardRevisionsGet(
  context: AdminPageRenderContext,
  repository: BlogRepository,
): Promise<Response | undefined> {
  const rawType = context.url.searchParams.get('entryType');
  if (rawType === null) {
    return undefined;
  }
  const entryType = toEntryType(rawType);
  if (entryType === null) {
    return adminBadRequestResponse();
  }
  const entryId = toEntryId(context.url.searchParams.get('entryId'));
  if (entryId === null || !(await entryExists(repository, entryType, entryId))) {
    return adminNotFoundResponse();
  }
  return undefined;
}

/** Render the revisions document: a lookup form plus the scoped revision list. */
async function renderRevisionsPage(
  context: AdminPageRenderContext,
  repository: BlogRepository,
  path?: string,
): Promise<string> {
  const entryType = toEntryType(context.url.searchParams.get('entryType'));
  const entryId = toEntryId(context.url.searchParams.get('entryId'));
  const scoped = entryType !== null && entryId !== null;
  const revisions = scoped
    ? [...(await repository.listRevisions(entryType, entryId))].reverse()
    : [];
  const notice =
    context.url.searchParams.get('notice') === RESTORED_NOTICE ? 'Revision restored.' : null;
  const actionPath = blogPagePath(path ?? context.path, REVISIONS_SLUG);

  const body: ComponentChild[] = [
    h('h1', null, REVISIONS_LABEL),
    ...(notice === null ? [] : [renderNotice(notice)]),
    h(
      'form',
      { method: 'get', action: actionPath },
      h(
        'div',
        null,
        h('label', null, 'Entry type'),
        h(
          'select',
          { name: 'entryType' },
          h('option', { value: 'post', selected: entryType === 'post' }, 'Post'),
          h('option', { value: 'page', selected: entryType === 'page' }, 'Page'),
        ),
      ),
      h(
        'div',
        null,
        h('label', null, 'Entry id'),
        h('input', { type: 'text', name: 'entryId', value: entryId ?? '' }),
      ),
      h('button', { type: 'submit' }, 'List revisions'),
    ),
  ];

  if (!scoped) {
    body.push(h('p', null, 'Choose an entry to list its revisions.'));
  } else if (revisions.length === 0) {
    body.push(h('p', null, 'No revisions recorded for this entry.'));
  } else {
    body.push(h('h2', null, 'Revisions'));
    for (const revision of revisions) {
      body.push(revisionRow(actionPath, context, entryType, entryId, revision));
    }
  }

  return renderAdminDocumentWithTheme(panelDocumentOptions(context, REVISIONS_LABEL), ...body);
}

/** One revision row: timestamp plus a restore button posting its revision id. */
function revisionRow(
  actionPath: string,
  context: AdminPageRenderContext,
  entryType: RevisionEntryType,
  entryId: string,
  revision: BlogRevision,
): ComponentChild {
  return actionForm({
    path: actionPath,
    csrf: context.session.csrfToken,
    action: RESTORE_ACTION,
    label: 'Restore',
    controls: [
      hiddenInput('entryType', entryType),
      hiddenInput('entryId', entryId),
      hiddenInput('revisionId', revision.id),
      h('span', null, snapshotTitle(revision.snapshot)),
      h('span', null, revision.createdAt),
    ],
  });
}

/** The snapshot's `title` when present and a string, else the empty string. */
function snapshotTitle(snapshot: JsonValue): string {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return '';
  }
  const title = snapshot['title'];
  return typeof title === 'string' ? title : '';
}

/** Handle the restore `POST`: validate the snapshot and re-apply it to the entry. */
async function handleRevisionsPost(
  context: AdminPagePostContext,
  repository: BlogRepository,
  path?: string,
): Promise<Response> {
  if (context.body['action'] !== RESTORE_ACTION) {
    return adminBadRequestResponse();
  }

  const entryType = toEntryType(context.body['entryType']);
  const entryId = toEntryId(context.body['entryId']);
  if (entryType === null || entryId === null) {
    return adminBadRequestResponse();
  }
  if (!(await entryExists(repository, entryType, entryId))) {
    return adminNotFoundResponse();
  }

  const revisionId = toEntryId(context.body['revisionId']);
  if (revisionId === null) {
    return adminBadRequestResponse();
  }
  // The revision is looked up within the (type, entry) scope, so a snapshot can
  // never be restored into a different entry type or id than it was recorded
  // against.
  const revision = await findRevision(repository, entryType, entryId, revisionId);
  if (revision === undefined) {
    return adminNotFoundResponse();
  }

  if (!(await restoreSnapshot(repository, entryType, entryId, revision.snapshot))) {
    return adminBadRequestResponse();
  }

  return adminRedirectResponse(
    `${blogPagePath(path ?? context.path, REVISIONS_SLUG)}?entryType=${encodeURIComponent(
      entryType,
    )}&entryId=${encodeURIComponent(entryId)}&notice=${RESTORED_NOTICE}`,
  );
}

/**
 * Validate a snapshot against the entry's snapshot schema and apply it. Returns
 * `false` (never throws) when the snapshot is not a valid content snapshot, so
 * the caller maps it to a value-free 400.
 */
async function restoreSnapshot(
  repository: BlogRepository,
  entryType: RevisionEntryType,
  entryId: string,
  snapshot: JsonValue,
): Promise<boolean> {
  if (entryType === 'post') {
    const parsed = postSnapshotSchema.safeParse(snapshot);
    if (!parsed.success) {
      return false;
    }
    const post: BlogPostSnapshot = parsed.data;
    await repository.updatePost(entryId, {
      title: post.title,
      slug: post.slug,
      excerpt: post.excerpt,
      blocks: post.blocks,
      ...(post.editor === undefined ? {} : { editor: post.editor }),
      ...(post.native === undefined ? {} : { native: post.native }),
      categoryIds: [...post.categoryIds],
      tagIds: [...post.tagIds],
      featuredMediaId: post.featuredMediaId,
    });
    return true;
  }

  const parsed = pageSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) {
    return false;
  }
  const page: BlogPageSnapshot = parsed.data;
  await repository.updatePage(entryId, {
    title: page.title,
    slug: page.slug,
    blocks: page.blocks,
    parentId: page.parentId,
    sortOrder: page.sortOrder,
  });
  return true;
}
