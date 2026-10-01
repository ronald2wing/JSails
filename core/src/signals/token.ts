/**
 * Typed service token for the application signal bus. The token is core-owned so
 * plugins can require it without importing the implementation package.
 */

import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import type { SignalBus } from './signal-bus.js';

export const signalsToken: ServiceToken<SignalBus> = createServiceToken<SignalBus>('signals');
