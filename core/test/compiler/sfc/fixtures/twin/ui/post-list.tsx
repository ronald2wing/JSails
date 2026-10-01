/** TSX twin of `fixtures/app/ui/post-list.jsails`: posts in a card, with a total per key. */

import type { ComponentChild } from '../../../../../../src/view/index.js';
import Card, { type Row } from './card.js';

export default function PostList(props: {
  readonly rows: readonly Row[];
  readonly totals: Record<string, number>;
}): ComponentChild {
  return (
    <Card
      rows={props.rows}
      attributes={{ id: 'posts', class: 'wide' }}
      header={<b data-s="cu47kewx">Posts</b>}
      row={({ item, index }) => (
        <li data-index={index} data-s="cu47kewx">
          #{item.id} {item.label}
        </li>
      )}
    >
      <dl data-s="cu47kewx">
        {Object.entries(props.totals).map(([key, value], index) => (
          <>
            {' '}
            <dt>
              {index + 1}. {key}
            </dt>
            <dd>{value}</dd>{' '}
          </>
        ))}
      </dl>
    </Card>
  );
}
