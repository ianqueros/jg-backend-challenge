import { z } from 'zod';
import { validateInput } from '../../shared/validation.js';
import { invalidEnvironment } from '../config/environment.errors.js';

const positive = (maximum: number, fallback: number) =>
  z.coerce.number().int().min(1).max(maximum).default(fallback);

const databaseSettingsSchema = z
  .object({
    DB_POOL_MAX: positive(1000, 10),
    DB_INSTANCE_COUNT: positive(1000, 3),
    DB_CONNECTION_BUDGET: positive(10000, 60),
    DB_POOL_ACQUIRE_TIMEOUT_MS: positive(300000, 1000),
    DB_CONNECT_TIMEOUT_MS: positive(300000, 1000),
    DB_LOCK_TIMEOUT_MS: positive(300000, 250),
    DB_STATEMENT_TIMEOUT_MS: positive(300000, 1000),
    OPERATION_TIMEOUT_MS: positive(300000, 5000),
    DB_TRANSACTION_MAX_ATTEMPTS: positive(10, 3),
    DB_RETRY_BASE_DELAY_MS: positive(300000, 10),
    DB_RETRY_MAX_DELAY_MS: positive(300000, 100),
  })
  .superRefine((settings, context) => {
    const rules: [boolean, string, keyof typeof settings][] = [
      [
        settings.DB_POOL_MAX * settings.DB_INSTANCE_COUNT <=
          settings.DB_CONNECTION_BUDGET,
        'Declared process pools exceed the database connection budget',
        'DB_CONNECTION_BUDGET',
      ],
      [
        settings.DB_LOCK_TIMEOUT_MS < settings.DB_STATEMENT_TIMEOUT_MS,
        'Lock timeout must be below statement timeout',
        'DB_LOCK_TIMEOUT_MS',
      ],
      [
        settings.DB_STATEMENT_TIMEOUT_MS <= settings.OPERATION_TIMEOUT_MS,
        'Statement timeout must fit the operation deadline',
        'DB_STATEMENT_TIMEOUT_MS',
      ],
      [
        settings.DB_POOL_ACQUIRE_TIMEOUT_MS <= settings.OPERATION_TIMEOUT_MS,
        'Pool acquisition timeout must fit the operation deadline',
        'DB_POOL_ACQUIRE_TIMEOUT_MS',
      ],
      [
        settings.DB_CONNECT_TIMEOUT_MS <= settings.OPERATION_TIMEOUT_MS,
        'Connection timeout must fit the operation deadline',
        'DB_CONNECT_TIMEOUT_MS',
      ],
      [
        settings.DB_RETRY_BASE_DELAY_MS <= settings.DB_RETRY_MAX_DELAY_MS,
        'Retry base delay must not exceed its cap',
        'DB_RETRY_BASE_DELAY_MS',
      ],
    ];
    for (const [valid, message, field] of rules) {
      if (!valid) context.addIssue({ code: 'custom', message, path: [field] });
    }
  });

export type DatabaseSettings = z.output<typeof databaseSettingsSchema>;

export function getDatabaseSettings(source: unknown = process.env): DatabaseSettings {
  return validateInput(databaseSettingsSchema, source, invalidEnvironment);
}
