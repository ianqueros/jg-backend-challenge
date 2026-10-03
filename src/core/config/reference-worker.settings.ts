import { z } from 'zod';
import { validateInput } from '../../shared/validation.js';
import { invalidEnvironment } from './environment.errors.js';

const settingsSchema = z
  .object({
    REFERENCE_WORKER_ENABLED: z
      .union([
        z.boolean(),
        z.enum(['true', 'false']).transform((value) => value === 'true'),
      ])
      .default(false),
    REFERENCE_TTL_MS: z.coerce.number().int().min(1).max(2147483647).default(86400000),
    REFERENCE_POLL_MS: z.coerce.number().int().min(1).max(300000).default(1000),
    REFERENCE_LEASE_MS: z.coerce.number().int().min(1).max(300000).default(30000),
    REFERENCE_RETRY_BASE_MS: z.coerce.number().int().min(1).max(300000).default(1000),
    REFERENCE_RETRY_MAX_MS: z.coerce.number().int().min(1).max(300000).default(60000),
    OPERATION_TIMEOUT_MS: z.coerce.number().int().min(1).max(300000).optional(),
  })
  .refine(
    (settings) => settings.REFERENCE_RETRY_BASE_MS <= settings.REFERENCE_RETRY_MAX_MS,
    'Retry base must not exceed retry maximum',
  )
  .refine(
    (settings) =>
      settings.OPERATION_TIMEOUT_MS === undefined ||
      settings.REFERENCE_LEASE_MS > settings.OPERATION_TIMEOUT_MS,
    'Reference lease must exceed operation timeout',
  )
  .transform((settings) => {
    const copy = { ...settings };
    delete copy.OPERATION_TIMEOUT_MS;
    return copy;
  });

export interface ReferenceWorkerSettings {
  readonly REFERENCE_WORKER_ENABLED: boolean;
  readonly REFERENCE_TTL_MS: number;
  readonly REFERENCE_POLL_MS: number;
  readonly REFERENCE_LEASE_MS: number;
  readonly REFERENCE_RETRY_BASE_MS: number;
  readonly REFERENCE_RETRY_MAX_MS: number;
}

export function getReferenceWorkerSettings(
  input: unknown = process.env,
): ReferenceWorkerSettings {
  return validateInput(settingsSchema, input, invalidEnvironment);
}
