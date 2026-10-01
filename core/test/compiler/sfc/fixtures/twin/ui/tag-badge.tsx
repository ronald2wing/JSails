/** TSX twin of `fixtures/app/ui/tag-badge.jsails`: an upper-cased tag. */

import type { ComponentChild } from '../../../../../../src/view/index.js';

export default function TagBadge(props: {
  readonly tag: string;
  readonly tagCount?: number;
}): ComponentChild {
  const tagCount = props.tagCount ?? 1;
  const label = props.tag.toUpperCase();
  const classes = ['badge'];
  if (tagCount > 3) classes.push('small');
  if (tagCount === 1) classes.push('solo');
  return (
    <span
      class={classes.join(' ')}
      style={{ color: 'red', fontWeight: 'bold', ...(label === '' ? { display: 'none' } : {}) }}
      data-s="c9sw0dwn"
    >
      {label}
    </span>
  );
}
