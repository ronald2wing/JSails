/** TSX twin of `fixtures/app/pages/index.jsails`: the home page. */

import type { ComponentChild } from '../../../../../../src/view/index.js';

export default function Page(): ComponentChild {
  return (
    <main data-s="8cbbuj7h">
      <h1>Welcome</h1>
      <p>
        Braces {'{'} and {'}'} and a {'>'} are text, &amp; entities decode.
      </p>
      <ol>
        {[1, 2, 3].map((n) => (
          <li key={n}>Item {n}</li>
        ))}
      </ol>
    </main>
  );
}
