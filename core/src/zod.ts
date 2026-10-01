/**
 * Zod authoring surface (`jsails/zod`, server-only in the default autoload).
 *
 * The browser-safe validation barrel (`jsails/validation`) deliberately does
 * not project `z`; browser modules import Zod explicitly when they need it.
 */
export { z } from 'zod';
