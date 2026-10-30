import { build } from 'esbuild';
await build({
  entryPoints: ['desktop/backend.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  outfile: 'electron/backend.cjs', external: ['node:*', 'yjs'], alias: { 'cloudflare:workers': './desktop/cloud-env.ts' },
});
