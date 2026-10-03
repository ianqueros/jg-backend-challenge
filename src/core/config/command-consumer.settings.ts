import { z } from 'zod';
import { validateInput } from '../../shared/validation.js';
import { invalidEnvironment } from './environment.errors.js';

const queueName = z.string().regex(/^[a-zA-Z0-9_-]{1,75}\.fifo$/);
const seconds = z.coerce.number().int().min(1).max(43200);
const settingsSchema = z
  .object({
    COMMAND_CONSUMER_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    COMMAND_CONSUMER_NAME: z.string().min(1).max(128).default('wager-commands'),
    COMMAND_SOURCE_QUEUE: queueName.default('wager-transactions.fifo'),
    COMMAND_DLQ_QUEUE: queueName.default('wager-transactions-dlq.fifo'),
    COMMAND_LONG_POLL_SEC: z.coerce.number().int().min(0).max(20).default(20),
    COMMAND_VISIBILITY_SEC: seconds.default(30),
    COMMAND_RENEW_MS: z.coerce.number().int().min(1).max(43200000).default(10000),
    COMMAND_RETRY_BASE_SEC: seconds.default(1),
    COMMAND_RETRY_MAX_SEC: seconds.default(60),
    COMMAND_MAX_RECEIVE_COUNT: z.coerce.number().int().min(1).max(1000).default(5),
    COMMAND_BROKER_TIMEOUT_MS: z.coerce.number().int().min(1).max(60000).default(5000),
  })
  .refine(
    (settings) => settings.COMMAND_SOURCE_QUEUE !== settings.COMMAND_DLQ_QUEUE,
    'Source and DLQ must differ',
  )
  .refine(
    (settings) =>
      settings.COMMAND_RENEW_MS + settings.COMMAND_BROKER_TIMEOUT_MS <
      settings.COMMAND_VISIBILITY_SEC * 1000,
    'Renewal interval and broker deadline must fit within visibility',
  )
  .refine(
    (settings) => settings.COMMAND_RETRY_BASE_SEC <= settings.COMMAND_RETRY_MAX_SEC,
    'Retry base must not exceed retry maximum',
  );

export type CommandConsumerSettings = z.infer<typeof settingsSchema>;

export function getCommandConsumerSettings(
  input: unknown = process.env,
): CommandConsumerSettings {
  return validateInput(settingsSchema, input, invalidEnvironment);
}
