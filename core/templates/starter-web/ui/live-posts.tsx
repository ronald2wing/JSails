/**
 * Starter live-posts island.
 *
 * Subscribes to the `blog.posts` publication over the live layer and renders
 * the published post list. The server sends a snapshot on subscribe and a
 * change per committed write, so the list updates without a reload or a poll.
 *
 * This is a client island, not a server component, but its module is still
 * imported during a static export to render the markup. `useLive` is inert
 * without a browser: it returns empty rows and a `connecting` status and opens
 * no socket, so the exported markup is the empty state and the first client
 * render matches it. Hydration then opens the real connection.
 *
 * Stable `data-*` markers are the browser-verification contract:
 * - `data-live-status` — the connection status (`connecting`/`live`/`refreshed`/`error`)
 * - `data-live-count`  — the number of rows currently held
 * - `data-live-post`   — one per rendered post, carrying its id
 */

import { useLive } from '@jsails/live/client';

/** The publication the blog plugin registers (see `plugins/blog/src/plugin.ts`). */
const POSTS_PUBLICATION = 'blog.posts';
/** The client-visible collection key the publication declares. */
const POSTS_COLLECTION = 'posts';

/** Human-readable label for each connection status. */
const STATUS_LABEL = {
  connecting: 'Connecting',
  live: 'Live',
  refreshed: 'Refreshed',
  error: 'Disconnected',
} as const;

/** The status dot color, so a glance tells live from stale. */
const STATUS_TONE = {
  connecting: 'bg-base-content/30',
  live: 'bg-success',
  refreshed: 'bg-warning',
  error: 'bg-error',
} as const;

/**
 * Render the live post list.
 *
 * Rows arrive as untyped JSON, so each field is read defensively: a row without
 * a usable `title` still renders, and a row without an `id` is skipped by the
 * store before it reaches here.
 */
export function UiLivePosts() {
  const { rows, status, error } = useLive({
    publication: POSTS_PUBLICATION,
    collection: POSTS_COLLECTION,
  });

  const posts = rows.value;

  return (
    <div class="card border border-base-300/70 bg-base-100 shadow-sm">
      <div class="card-body gap-4">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-base-content/50">
            <span
              class={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_TONE[status.value]}`}
              aria-hidden="true"
            />
            Live publication
          </div>
          <span class="badge badge-ghost badge-sm" data-live-status={status.value}>
            {STATUS_LABEL[status.value]}
          </span>
        </div>

        <h2 class="card-title text-xl">Published posts</h2>
        <p class="text-sm text-base-content/60">
          This list is pushed from the server. Publishing a post updates it without a reload.
        </p>

        {error.value === null ? null : (
          <p class="text-sm text-error" role="status">
            {error.value}
          </p>
        )}

        <p class="text-xs text-base-content/50" data-live-count={posts.length}>
          {posts.length === 1 ? '1 post' : `${posts.length} posts`}
        </p>

        {posts.length === 0 ? (
          <p class="text-sm text-base-content/55">No published posts yet.</p>
        ) : (
          <ul class="flex flex-col gap-2">
            {posts.map((post) => (
              <li
                key={String(post['id'])}
                class="rounded-box border border-base-300/60 px-3 py-2"
                data-live-post={String(post['id'])}
              >
                <p class="font-medium">
                  {typeof post['title'] === 'string' ? post['title'] : 'Untitled'}
                </p>
                {typeof post['excerpt'] === 'string' && post['excerpt'] !== '' ? (
                  <p class="text-sm text-base-content/60">{post['excerpt']}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
