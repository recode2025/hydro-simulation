/**
 * Addon entry. Hydro's boot loader resolves addons by looking for
 * `index.ts` / `index.js` at the addon ROOT (entry/common.ts locateFile) —
 * package.json `main` is not consulted — so the real implementation in
 * src/ must be re-exported from here.
 */
export { default } from './src/index';
