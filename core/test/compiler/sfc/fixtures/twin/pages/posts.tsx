/** TSX twin of `fixtures/app/pages/posts.jsails`: the post index. */

import type { ComponentChild } from '../../../../../../src/view/index.js';
import { posts } from '../../app/shared/posts.js';
import type { Row } from '../ui/card.js';
import PostList from '../ui/post-list.js';

interface Props {
  readonly rows: readonly Row[];
  readonly totals: Record<string, number>;
}

export function load(): Props {
  const totals: Record<string, number> = {};
  for (const post of posts) {
    for (const tag of post.tags) totals[tag] = (totals[tag] ?? 0) + 1;
  }
  return { rows: posts.map((post, index) => ({ id: index + 1, label: post.title })), totals };
}

export default function Page(props: Props): ComponentChild {
  return <PostList rows={props.rows} totals={props.totals} />;
}
