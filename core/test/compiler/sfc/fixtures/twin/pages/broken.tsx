/** TSX twin of `fixtures/app/pages/broken.jsails`: a page whose load always fails. */

import type { ComponentChild } from '../../../../../../src/view/index.js';

export function load(): { reason: string } {
  throw new Error('the fixture page always fails');
}

export default function Page(props: { readonly reason: string }): ComponentChild {
  return <p data-s="dl17qlu7">Never rendered: {props.reason}</p>;
}
