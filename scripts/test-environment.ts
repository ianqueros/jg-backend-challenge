import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Test targets are fixed. Ordinary application .env values never select test resources.
export const testTargets = {
  API_URL: 'http://127.0.0.1:3100',
  DATABASE_URL: 'postgresql://jungle_main:main_local@127.0.0.1:55432/jungle_test',
  ADMIN_DATABASE_URL: 'postgresql://postgres:postgres_local@127.0.0.1:55432/postgres',
  SQS_ENDPOINT: 'http://127.0.0.1:4567',
  COMPOSE_FILE: 'compose.services.yaml:compose.apps.yaml',
  COMPOSE_PROJECT_NAME: 'jungle-wagering-test',
} as const;

export function installTestEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  for (const [key, target] of Object.entries(testTargets)) {
    const requested = environment[`TEST_${key}`];
    if (requested !== undefined && requested !== target) {
      throw new Error(
        `Unsafe TEST_${key}: only the fixed local test stack is supported.`,
      );
    }
  }
  const composeSettings = parseEnv(
    readFileSync(new URL('../docker/test.env', import.meta.url), 'utf8'),
  );
  Object.assign(environment, composeSettings, testTargets, {
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
  });
}
