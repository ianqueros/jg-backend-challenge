import { expect, test } from 'bun:test';
import { installTestEnvironment } from '../../scripts/test-environment.js';

for (const [key, value] of Object.entries({
  TEST_API_URL: 'http://127.0.0.1:3000',
  TEST_DATABASE_URL: 'postgresql://jungle_main:main_local@127.0.0.1:5432/jungle',
  TEST_ADMIN_DATABASE_URL: 'postgresql://postgres:postgres_local@127.0.0.1:5432/postgres',
  TEST_SQS_ENDPOINT: 'http://127.0.0.1:4566',
  TEST_COMPOSE_FILE: 'compose.apps.yaml:compose.services.yaml',
  TEST_COMPOSE_PROJECT_NAME: 'jungle-wagering',
})) {
  test(`rejects unsafe ${key} before installing any target`, () => {
    const environment: NodeJS.ProcessEnv = {
      DATABASE_URL: 'original-database',
      API_URL: 'original-gateway',
      [key]: value,
    };
    const before = { ...environment };
    expect(() => {
      installTestEnvironment(environment);
    }).toThrow(`Unsafe ${key}`);
    expect(environment).toEqual(before);
  });
}
