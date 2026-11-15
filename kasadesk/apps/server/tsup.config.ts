import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.api.ts', 'src/main.worker.ts', 'src/platform/db/migrate.cli.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  splitting: false,
  // Bundle workspace TS sources; keep npm dependencies external.
  noExternal: [/^@kasadesk\//],
});
