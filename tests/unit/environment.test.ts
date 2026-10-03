import { describe, expect, test } from 'bun:test';
import { ZodError } from 'zod';
import { getEnvironment } from '../../src/core/config/environment.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

const validEnvironment = {
  DATABASE_URL: 'postgresql://jungle_main:main_local@localhost/jungle',
  SQS_ENDPOINT: 'http://localhost:4566',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  LEDGER_CURSOR_SECRET: 'test_secret_at_least_32_characters_long',
};

describe('environment validation', () => {
  test.each(['0', '65536', 'abc'])('rejects invalid listening port %s', (port) => {
    const previous = { ...process.env };
    try {
      Object.assign(process.env, validEnvironment, { PORT: port });
      let thrown: unknown;
      try {
        getEnvironment();
      } catch (error) {
        thrown = error;
      }
      const appError = expectApplicationError(thrown, {
        category: 'ServerError',
        code: 'ENVIRONMENT_INVALID',
      });
      expect(appError.cause).toBeInstanceOf(ZodError);
    } finally {
      process.env = previous;
    }
  });

  test('rejects non-PostgreSQL database URLs', () => {
    const previous = { ...process.env };
    try {
      Object.assign(process.env, validEnvironment, {
        DATABASE_URL: 'https://localhost/jungle',
      });
      let thrown: unknown;
      try {
        getEnvironment();
      } catch (error) {
        thrown = error;
      }
      const appError = expectApplicationError(thrown, {
        category: 'ServerError',
        code: 'ENVIRONMENT_INVALID',
      });
      expect(appError.cause).toBeInstanceOf(ZodError);
    } finally {
      process.env = previous;
    }
  });
  test('rejects LEDGER_CURSOR_SECRET shorter than 32 characters', () => {
    const previous = { ...process.env };
    try {
      Object.assign(process.env, validEnvironment, {
        LEDGER_CURSOR_SECRET: 'short_secret',
      });
      let thrown: unknown;
      try {
        getEnvironment();
      } catch (error) {
        thrown = error;
      }
      const appError = expectApplicationError(thrown, {
        category: 'ServerError',
        code: 'ENVIRONMENT_INVALID',
      });
      expect(appError.cause).toBeInstanceOf(ZodError);
    } finally {
      process.env = previous;
    }
  });

  test('rejects environment when database pool budget inequality is violated', () => {
    const previous = { ...process.env };
    try {
      Object.assign(process.env, validEnvironment, {
        DB_POOL_MAX: '25',
        DB_INSTANCE_COUNT: '3',
        DB_CONNECTION_BUDGET: '60',
      });
      let thrown: unknown;
      try {
        getEnvironment();
      } catch (error) {
        thrown = error;
      }
      const appError = expectApplicationError(thrown, {
        category: 'ServerError',
        code: 'ENVIRONMENT_INVALID',
      });
      expect(appError.cause).toBeInstanceOf(ZodError);
    } finally {
      process.env = previous;
    }
  });
});
