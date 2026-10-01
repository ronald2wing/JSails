// The island entry plus the client model bindings a form island uses.
import { registerIsland, startClient } from 'jsails/client';

export { bindModel, createModel } from 'jsails/client/model';

registerIsland('island', () => null);
void startClient();
