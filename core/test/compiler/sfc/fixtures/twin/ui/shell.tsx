/** TSX twin of `fixtures/app/ui/shell.jsails`: a titled frame around its children. */

import type { ComponentChild } from '../../../../../../src/view/index.js';

export default function Shell(props: {
  readonly title: string;
  readonly children?: ComponentChild;
}): ComponentChild {
  return (
    <div class="shell" data-s="24wn39lb">
      <header>
        <h2>{props.title}</h2>
      </header>
      {props.children ?? 'Nothing to show.'}
    </div>
  );
}
