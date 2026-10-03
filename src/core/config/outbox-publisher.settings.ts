import { z } from 'zod';
import { validateInput } from '../../shared/validation.js';
import { invalidEnvironment } from './environment.errors.js';

const milliseconds = z.coerce.number().int().min(1).max(3600000);
const settingsSchema = z
  .object({
    EVENT_QUEUE: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,75}\.fifo$/)
      .default('wager-events.fifo'),
    OUTBOX_PUBLISHER_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    OUTBOX_POLL_MS: milliseconds.default(250),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    OUTBOX_LEASE_MS: milliseconds.default(30000),
    OUTBOX_BROKER_TIMEOUT_MS: milliseconds.default(5000),
    OUTBOX_RETRY_BASE_MS: milliseconds.default(1000),
    OUTBOX_RETRY_MAX_MS: milliseconds.default(60000),
    OPERATION_TIMEOUT_MS: milliseconds.default(10000),
  })
  .refine(
    (value) => value.OUTBOX_RETRY_BASE_MS <= value.OUTBOX_RETRY_MAX_MS,
    'Outbox retry base must not exceed maximum',
  )
  .refine(
    (value) =>
      value.OUTBOX_LEASE_MS >
      value.OUTBOX_BROKER_TIMEOUT_MS + 2 * value.OPERATION_TIMEOUT_MS,
    'Outbox lease must exceed broker and SQL operation deadlines',
  );

export type OutboxPublisherSettings = z.infer<typeof settingsSchema>;
export function getOutboxPublisherSettings(
  input: unknown = process.env,
): OutboxPublisherSettings {
  return validateInput(settingsSchema, input, invalidEnvironment);
}
