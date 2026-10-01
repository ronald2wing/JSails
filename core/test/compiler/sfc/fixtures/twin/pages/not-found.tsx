/** TSX twin of `fixtures/app/pages/not-found.jsails`: the page for unmatched URLs. */

import type { ComponentChild } from '../../../../../../src/view/index.js';

export function load(): { suggestions: readonly string[] } {
  return { suggestions: ['/', '/blog'] };
}

export default function NotFoundPage(props: {
  readonly suggestions: readonly string[];
}): ComponentChild {
  const { suggestions } = props;
  return (
    <main data-s="875jvyx5">
      <h1>Page not found</h1>
      <p style={suggestions.length > 0 ? undefined : { display: 'none' }}>
        Try{' '}
        {suggestions.map((href, index) => (
          <>
            <a href={href}>{href}</a>
            {index < suggestions.length - 1 ? <span>, </span> : null}
          </>
        ))}
      </p>
    </main>
  );
}
