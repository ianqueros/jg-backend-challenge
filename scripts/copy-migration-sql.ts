import { cpSync, rmSync } from 'node:fs';

const destination = new URL(
  '../dist/core/database/migrations/20261003000001',
  import.meta.url,
);

// TypeScript does not emit SQL assets used by this complex initial migration.
// Replace the asset directory so removed SQL files cannot remain in the build.
rmSync(destination, { recursive: true, force: true });
cpSync(
  new URL('../src/core/database/migrations/20261003000001', import.meta.url),
  destination,
  { recursive: true },
);
