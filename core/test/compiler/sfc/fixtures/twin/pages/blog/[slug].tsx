/** TSX twin of `fixtures/app/pages/blog/[slug].jsails`: one post per slug. */

import type { RequestContext } from '../../../../../../../src/contracts/http.js';
import type { ComponentChild } from '../../../../../../../src/view/index.js';
import { formatDate } from '../../../app/shared/format-date.js';
import { posts, type Post } from '../../../app/shared/posts.js';
import Shell from '../../ui/shell.js';
import TagBadge from '../../ui/tag-badge.js';

interface Neighbour {
  readonly slug: string;
  readonly title: string;
}

interface Props {
  readonly page: Post | null;
  readonly next?: Neighbour;
  readonly minutes: number;
}

export function getStaticPaths(): { slug: string }[] {
  return posts.map((post) => ({ slug: post.slug }));
}

export function load(context: RequestContext): Props {
  const page = posts.find((post) => post.slug === context.params['slug']) ?? null;
  if (page === null) return { page, minutes: 0 };
  const after = posts[posts.indexOf(page) + 1];
  return {
    page,
    ...(after === undefined ? {} : { next: { slug: after.slug, title: after.title } }),
    minutes: Math.max(1, Math.round(page.body.length / 200)),
  };
}

export default function Page(
  { page, next, minutes }: Props,
  context: RequestContext,
): ComponentChild {
  return (
    <Shell title={page?.title ?? 'Not found'}>
      {' '}
      {page !== null ? (
        <article class={minutes > 5 ? 'post long' : 'post'} data-s="4y85xlah">
          <h1>{page.title}</h1>
          <p class="meta">{`${formatDate(page.date)} · ${minutes} min read`}</p>
          {page.tags.length > 0 ? (
            <ul class="tags">
              {page.tags.map((tag) => (
                <li key={tag}>
                  <TagBadge tag={tag} tagCount={page.tags.length} />
                </li>
              ))}
            </ul>
          ) : null}
          <div dangerouslySetInnerHTML={{ __html: page.body }} />
          {next !== undefined ? (
            <a href={`/blog/${next.slug}`}>Next: {next.title} →</a>
          ) : (
            <span>Last post</span>
          )}
        </article>
      ) : (
        <p class="empty" data-s="4y85xlah">
          No post at {context.url.pathname}.
        </p>
      )}{' '}
    </Shell>
  );
}
