import { describe, expect, it } from 'bun:test';
import { ZodError } from 'zod';
import { getDatabaseSettings } from '../../src/core/database/database.settings.js';
import { expectApplicationError } from '../helpers/expect-application-error.js';

describe('Database Settings Validation', () => {
  it('rejects when aggregate pool across instances exceeds connection budget', () => {
    let thrown: unknown;
    try {
      getDatabaseSettings({
        DB_POOL_MAX: '25',
        DB_INSTANCE_COUNT: '3',
        DB_CONNECTION_BUDGET: '60',
      });
    } catch (error) {
      thrown = error;
    }
    const appError = expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
    const zodError = appError.cause as ZodError;
    expect(zodError.issues.some((i) => i.path.includes('DB_CONNECTION_BUDGET'))).toBe(
      true,
    );
  });

  it('accepts exact boundary where aggregate pool equals connection budget', () => {
    const settings = getDatabaseSettings({
      DB_POOL_MAX: '20',
      DB_INSTANCE_COUNT: '3',
      DB_CONNECTION_BUDGET: '60',
    });
    expect(settings.DB_POOL_MAX * settings.DB_INSTANCE_COUNT).toBe(
      settings.DB_CONNECTION_BUDGET,
    );
  });

  it('rejects when lock timeout is equal to or greater than statement timeout', () => {
    for (const [lock, statement] of [
      [1000, 1000],
      [1200, 1000],
    ]) {
      let thrown: unknown;
      try {
        getDatabaseSettings({
          DB_LOCK_TIMEOUT_MS: String(lock),
          DB_STATEMENT_TIMEOUT_MS: String(statement),
        });
      } catch (error) {
        thrown = error;
      }
      const appError = expectApplicationError(thrown, {
        category: 'ServerError',
        code: 'ENVIRONMENT_INVALID',
      });
      const zodError = appError.cause as ZodError;
      expect(zodError.issues.some((i) => i.path.includes('DB_LOCK_TIMEOUT_MS'))).toBe(
        true,
      );
    }
  });

  it('accepts boundary where lock timeout is strictly below statement timeout', () => {
    const settings = getDatabaseSettings({
      DB_LOCK_TIMEOUT_MS: '999',
      DB_STATEMENT_TIMEOUT_MS: '1000',
    });
    expect(settings.DB_LOCK_TIMEOUT_MS).toBe(999);
    expect(settings.DB_STATEMENT_TIMEOUT_MS).toBe(1000);
  });

  it('rejects when statement timeout exceeds total operation deadline', () => {
    let thrown: unknown;
    try {
      getDatabaseSettings({
        DB_STATEMENT_TIMEOUT_MS: '6000',
        OPERATION_TIMEOUT_MS: '5000',
      });
    } catch (error) {
      thrown = error;
    }
    const appError = expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
    const zodError = appError.cause as ZodError;
    expect(zodError.issues.some((i) => i.path.includes('DB_STATEMENT_TIMEOUT_MS'))).toBe(
      true,
    );
  });

  it('rejects when pool acquisition timeout exceeds operation deadline', () => {
    let thrown: unknown;
    try {
      getDatabaseSettings({
        DB_POOL_ACQUIRE_TIMEOUT_MS: '6000',
        OPERATION_TIMEOUT_MS: '5000',
      });
    } catch (error) {
      thrown = error;
    }
    const appError = expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
    const zodError = appError.cause as ZodError;
    expect(
      zodError.issues.some((i) => i.path.includes('DB_POOL_ACQUIRE_TIMEOUT_MS')),
    ).toBe(true);
  });

  it('rejects when connection timeout exceeds operation deadline', () => {
    let thrown: unknown;
    try {
      getDatabaseSettings({
        DB_CONNECT_TIMEOUT_MS: '6000',
        OPERATION_TIMEOUT_MS: '5000',
      });
    } catch (error) {
      thrown = error;
    }
    const appError = expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
    const zodError = appError.cause as ZodError;
    expect(zodError.issues.some((i) => i.path.includes('DB_CONNECT_TIMEOUT_MS'))).toBe(
      true,
    );
  });

  it('rejects when retry base delay exceeds retry max delay cap', () => {
    let thrown: unknown;
    try {
      getDatabaseSettings({
        DB_RETRY_BASE_DELAY_MS: '200',
        DB_RETRY_MAX_DELAY_MS: '100',
      });
    } catch (error) {
      thrown = error;
    }
    const appError = expectApplicationError(thrown, {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
    });
    const zodError = appError.cause as ZodError;
    expect(zodError.issues.some((i) => i.path.includes('DB_RETRY_BASE_DELAY_MS'))).toBe(
      true,
    );
  });

  it('accepts boundary where retry base delay equals retry max delay cap', () => {
    const settings = getDatabaseSettings({
      DB_RETRY_BASE_DELAY_MS: '100',
      DB_RETRY_MAX_DELAY_MS: '100',
    });
    expect(settings.DB_RETRY_BASE_DELAY_MS).toBe(100);
    expect(settings.DB_RETRY_MAX_DELAY_MS).toBe(100);
  });

  it.each([
    ['DB_POOL_MAX', '0'],
    ['DB_POOL_MAX', '-1'],
    ['DB_POOL_MAX', '1001'],
    ['DB_POOL_MAX', 'abc'],
    ['DB_POOL_MAX', '2.5'],
    ['DB_INSTANCE_COUNT', '0'],
    ['DB_INSTANCE_COUNT', '1001'],
    ['DB_CONNECTION_BUDGET', '0'],
    ['DB_CONNECTION_BUDGET', '10001'],
    ['DB_TRANSACTION_MAX_ATTEMPTS', '0'],
    ['DB_TRANSACTION_MAX_ATTEMPTS', '11'],
    ['DB_LOCK_TIMEOUT_MS', '0'],
    ['DB_STATEMENT_TIMEOUT_MS', '0'],
    ['OPERATION_TIMEOUT_MS', '0'],
    ['DB_RETRY_BASE_DELAY_MS', '0'],
    ['DB_RETRY_MAX_DELAY_MS', '0'],
  ])(
    'rejects non-positive, non-integer, or out-of-bound value for %s=%s',
    (key, value) => {
      let thrown: unknown;
      try {
        getDatabaseSettings({ [key]: value });
      } catch (error) {
        thrown = error;
      }
      const appError = expectApplicationError(thrown, {
        category: 'ServerError',
        code: 'ENVIRONMENT_INVALID',
      });
      expect(appError.cause).toBeInstanceOf(ZodError);
    },
  );
});
