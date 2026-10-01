// A live island: the client store and hook of @jsails/live/client.
import { registerIsland, startClient } from 'jsails/client';

export { createLiveClientStore, useLive } from '@jsails/live/client';

registerIsland('island', () => null);
void startClient();
