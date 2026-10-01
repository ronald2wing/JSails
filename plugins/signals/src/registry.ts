/**
 * Registry-backed signal bus implementation (`@jsails/signals`).
 *
 * The class lives in core because the runtime and tests construct it directly;
 * the package re-exports it with the plugin.
 */

export { RegistrySignalBus } from 'jsails/signals';
