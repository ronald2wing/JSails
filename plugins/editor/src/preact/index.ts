/**
 * Browser-facing rich-text editor island (`src/editor/preact`): the Preact
 * component that wraps the Editor.js mount seam, plus the island registration
 * surface apps and admin forms hydrate.
 *
 * Register it in a browser entry with either the declarative map or the
 * explicit function:
 *
 * ```ts
 * import { startClient } from 'jsails/client';
 * import { richTextIsland } from 'jsails/editor/preact';
 * startClient({ islands: richTextIsland });
 * ```
 *
 * ```ts
 * import { registerIsland, startClient } from 'jsails/client';
 * import { RICH_TEXT_ISLAND, RichTextIsland } from 'jsails/editor/preact';
 * registerIsland(RICH_TEXT_ISLAND, RichTextIsland);
 * startClient();
 * ```
 */

export {
  RICH_TEXT_ISLAND,
  RichTextEditor,
  RichTextIsland,
  richTextIsland,
  type RichTextEditorProps,
} from './editor.js';
