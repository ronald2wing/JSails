// startClient() with one island: the smallest real client entry.
import { registerIsland, startClient } from 'jsails/client';

registerIsland('island', () => null);
void startClient();
