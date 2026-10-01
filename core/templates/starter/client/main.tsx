/**
 * Browser entry for the static blog.
 *
 * Starts the shared client runtime, which owns soft navigation through Turbo
 * Drive, and registers the one island the static site ships: `load-more`, a
 * pure client demo that paginates an inline seed. The runtime hydrates every
 * `data-jsails-island` element in the document, so the page only has to render
 * the marker and its serialized props.
 *
 * There is no manual `hydrate`, `fetch`, or `history` call here; the runtime
 * owns navigation. A startup failure is reported once with a fixed message and
 * leaves no state behind, so the server-rendered markup stays usable.
 */

import { registerIsland, startClient, type IslandProps } from '../app/application-client.js';
import { LoadMore, parseLoadMoreSeed } from '../ui/load-more.js';

import '../ui/styles.css';

// The island boundary hands components untyped JSON props. Decode the seed
// defensively and fall back to the inline seed so the first client render
// matches the server markup.
registerIsland('load-more', ({ seed }: IslandProps) => <LoadMore seed={parseLoadMoreSeed(seed)} />);

startClient().catch((error: unknown) => {
  console.error('jsails: client startup failed', error);
});
