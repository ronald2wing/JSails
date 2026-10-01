// The starter-web client entry's framework part: the rich-text editor island
// passed to startClient, as client/main.tsx does.
import { startClient } from 'jsails/client';
import { richTextIsland } from '@jsails/editor/preact';

void startClient({ islands: richTextIsland });
