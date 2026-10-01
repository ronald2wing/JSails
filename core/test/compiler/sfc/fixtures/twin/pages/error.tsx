/** TSX twin of `fixtures/app/pages/error.jsails`: the error boundary. */

import type { ComponentChild } from '../../../../../../src/view/index.js';

export default function ErrorPage(props: {
  readonly error: { readonly status: number; readonly message: string };
}): ComponentChild {
  const { status, message } = props.error;
  return (
    <section class="error" data-status={status} data-s="2ymrmssr">
      {status === 404 ? (
        <h1>Not found</h1>
      ) : status >= 500 ? (
        <h1>Server error</h1>
      ) : (
        <h1>Error {status}</h1>
      )}
      <p>{message}</p>
    </section>
  );
}
