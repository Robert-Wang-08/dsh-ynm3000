import { defineConfig } from 'tsdown'

/*
 * Two entries:
 *  - node half (`lib/index.js`, ESM) so the bundle can be mounted by the host
 *    roster;
 *  - browser half (`lib/client.js`, CJS) which `scripts/finalize-client-bundle.mjs`
 *    wraps in the `window.__ModuleLoader__.load({...})` classic-script
 *    envelope required by the /plugins/?? combo.
 *
 * The browser half has no React or framework imports: it is plain DOM work.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    dts: true,
    external: [/^@deepseek-ai\//],
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: true,
    external: [/^@deepseek-ai\//],
    outExtensions: () => ({ js: '.js' }),
  },
])
