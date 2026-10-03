import { defineConfig } from '@playwright/test';
import { installTestEnvironment, testTargets } from './scripts/test-environment.js';

installTestEnvironment();

export default defineConfig({
  testDir: './tests/api',
  // Isolate scenarios; concurrency tests still issue simultaneous requests internally.
  workers: 1,
  quiet: true,
  reporter: [['dot'], ['html', { open: 'never' }]],
  projects: [
    {
      name: 'load-balancer',
      use: { baseURL: testTargets.API_URL },
    },
  ],
});
