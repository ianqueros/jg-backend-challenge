import { z } from 'zod';
import { validateInput } from '../../shared/validation.js';
import { invalidEnvironment } from './environment.errors.js';
import { getDatabaseSettings } from '../database/database.settings.js';
import { getCommandConsumerSettings } from './command-consumer.settings.js';
import { getReferenceWorkerSettings } from './reference-worker.settings.js';
import { getOutboxPublisherSettings } from './outbox-publisher.settings.js';
const postgresUrl = z
  .url()
  .refine(
    (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
    'Expected a PostgreSQL URL',
  );

const environmentSchema = z.object({
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: postgresUrl,
  SQS_ENDPOINT: z.url(),
  AWS_REGION: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  LEDGER_CURSOR_SECRET: z.string().min(32).default('local-only-ledger-cursor-secret-32'),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1).max(3600000).default(30000),
});

export function getEnvironment() {
  const env = validateInput(environmentSchema, process.env, invalidEnvironment);
  const db = getDatabaseSettings();
  const sqs = getCommandConsumerSettings();
  const ref = getReferenceWorkerSettings({
    ...process.env,
    OPERATION_TIMEOUT_MS: db.OPERATION_TIMEOUT_MS,
  });
  if (ref.REFERENCE_LEASE_MS <= db.OPERATION_TIMEOUT_MS) {
    throw invalidEnvironment(new Error('Reference lease must exceed operation timeout.'));
  }
  const outbox = getOutboxPublisherSettings({
    ...process.env,
    OPERATION_TIMEOUT_MS: db.OPERATION_TIMEOUT_MS,
  });
  if (
    env.SHUTDOWN_GRACE_MS <=
    db.OPERATION_TIMEOUT_MS + 2 * sqs.COMMAND_BROKER_TIMEOUT_MS
  ) {
    throw invalidEnvironment(
      new Error('Shutdown grace must exceed financial and transport deadlines.'),
    );
  }
  return {
    ...env,
    ...db,
    ...sqs,
    ...ref,
    ...outbox,
  };
}
