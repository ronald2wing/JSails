/** TSX twin of `fixtures/app/ui/card.jsails`: rows with header, row and default slots. */

import type { ComponentChild } from '../../../../../../src/view/index.js';

export interface Row {
  readonly id: number;
  readonly label: string;
}

export default function Card(props: {
  readonly rows: readonly Row[];
  readonly attributes?: Record<string, string>;
  readonly header?: ComponentChild;
  readonly children?: ComponentChild;
  readonly row?: (props: { item: Row; index: number }) => ComponentChild;
}): ComponentChild {
  const { rows, attributes = {} } = props;
  const Count = rows.length > 1 ? 'strong' : 'em';
  return (
    <section
      {...attributes}
      class={['card', attributes['class']].filter(Boolean).join(' ')}
      data-s="3dd40m0f"
    >
      <header>{props.header ?? 'Rows'}</header>
      <ol>
        {rows.map((item, index) => (
          <> {props.row?.({ item, index }) ?? <li>{item.label}</li>} </>
        ))}
      </ol>
      {props.children} <Count class="count">{rows.length}</Count>{' '}
      <code>{'{{ not   interpolated }}'}</code>
    </section>
  );
}
